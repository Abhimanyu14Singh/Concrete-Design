/**
 * Renderer usage-log tests.
 *
 * Two things are worth guarding here, and they are not the obvious ones. The first is
 * that the module is INERT outside Electron — a browser build must not queue events
 * forever against a transport that will never exist. The second is `_dt`, the gap since
 * the previous event: it is the field the whole "where did they stumble" reading rests
 * on, and it is the easiest to silently break, because everything still looks fine when
 * it is wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  track, trackOnce, trackTiming, setUsageContext, flushUsage, trackException,
  compactStack, stripLabels, __setUsageTransport, __resetUsage,
} from '../usage';

interface Sent { ev: string; p?: Record<string, unknown>; lvl?: string; src?: string; ts: number }

let sent: Sent[] = [];

beforeEach(() => {
  __resetUsage();
  sent = [];
  __setUsageTransport(batch => { sent.push(...(batch as Sent[])); });
});

afterEach(() => {
  __setUsageTransport(null);
  __resetUsage();
  vi.useRealTimers();
});

const names = () => sent.map(e => e.ev);

describe('inertness outside Electron', () => {
  it('records nothing when there is no transport and no electronAPI', () => {
    __setUsageTransport(null);
    track('should.vanish', { a: 1 });
    trackOnce('also.vanishes');
    setUsageContext({ code: 'ACI' });
    // Re-attach and flush: if anything had been queued it would arrive now.
    __setUsageTransport(batch => { sent.push(...(batch as Sent[])); });
    flushUsage();
    expect(sent).toEqual([]);
  });
});

describe('track', () => {
  it('queues until flushed, then sends one batch', () => {
    track('a');
    track('b');
    expect(sent).toEqual([]);          // still buffered
    flushUsage();
    expect(names()).toEqual(['a', 'b']);
  });

  it('flushes an error immediately — the crashing session is the one worth keeping', () => {
    track('boom', { why: 'x' }, 'error');
    expect(names()).toEqual(['boom']); // no flushUsage() call
    expect(sent[0].lvl).toBe('error');
  });

  it('carries the caller props through untouched', () => {
    track('design.run', { members: 312, code: 'EC2' });
    flushUsage();
    expect(sent[0].p).toMatchObject({ members: 312, code: 'EC2' });
  });

  it('does not let a caller prop overwrite the sequencing fields', () => {
    // `dt` is a plausible thing for a caller to pass; `_dt` is ours and must survive it.
    track('x', { dt: 999, n: 5 });
    flushUsage();
    expect(sent[0].p).toMatchObject({ dt: 999, n: 5 });
    expect(sent[0].p!._dt).not.toBe(999);
    expect(sent[0].p!._n).toBe(1);
  });
});

describe('event timestamps', () => {
  it('stamps each event when it happens, not when the batch is flushed', () => {
    // The queue holds events for up to a second. If the main process timed them on
    // arrival, a whole interaction would land on one instant and every gap the log
    // exists to measure would be gone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T10:00:00.000Z'));
    track('first');
    vi.advanceTimersByTime(3000);
    track('second');
    vi.advanceTimersByTime(3000);
    flushUsage();                       // both leave together, 6s after the first
    expect(sent[1].ts - sent[0].ts).toBe(3000);
    expect(sent[0].ts).toBe(Date.parse('2026-08-27T10:00:00.000Z'));
  });
});

describe('sequencing', () => {
  it('numbers events from 1 and never repeats', () => {
    track('a'); track('b'); track('c');
    flushUsage();
    expect(sent.map(e => e.p!._n)).toEqual([1, 2, 3]);
  });

  it('reports the gap since the previous event, starting at 0', () => {
    vi.useFakeTimers();
    track('first');
    vi.advanceTimersByTime(4000);
    track('second');
    vi.advanceTimersByTime(250);
    track('third');
    flushUsage();
    expect(sent.map(e => e.p!._dt)).toEqual([0, 4000, 250]);
    // `_t` is cumulative from the first event, which is what makes a session
    // reconstructable from the file alone.
    expect(sent.map(e => e.p!._t)).toEqual([0, 4000, 4250]);
  });
});

describe('trackOnce', () => {
  it('records a milestone once per session however often it is reached', () => {
    trackOnce('milestone.verified');
    trackOnce('milestone.verified');
    trackOnce('milestone.verified');
    flushUsage();
    expect(names()).toEqual(['milestone.verified']);
  });

  it('starts again after a reset, so a new session re-arms it', () => {
    trackOnce('milestone.verified');
    flushUsage();
    __resetUsage();
    __setUsageTransport(batch => { sent.push(...(batch as Sent[])); });
    trackOnce('milestone.verified');
    flushUsage();
    expect(names()).toEqual(['milestone.verified', 'milestone.verified']);
  });
});

describe('trackTiming', () => {
  it('records elapsed milliseconds and merges both prop sets', () => {
    vi.useFakeTimers();
    const done = trackTiming('sconcrete.batch', { mode: 'run' });
    vi.advanceTimersByTime(2500);
    done({ ok: true, files: 7 });
    flushUsage();
    expect(sent[0].p).toMatchObject({ mode: 'run', ok: true, files: 7, ms: 2500 });
  });

  it('ignores a second call, so a double-resolved promise cannot double-count', () => {
    const done = trackTiming('op');
    done(); done();
    flushUsage();
    expect(names()).toEqual(['op']);
  });

  it('records nothing when the work never finishes', () => {
    trackTiming('abandoned');
    flushUsage();
    expect(sent).toEqual([]);
  });
});

describe('setUsageContext', () => {
  it('emits only what changed, and stays silent when nothing did', () => {
    setUsageContext({ code: 'ACI', members: 12 });
    setUsageContext({ code: 'ACI', members: 12 });   // no change — no event
    setUsageContext({ code: 'EC2', members: 12 });   // one field changed
    flushUsage();
    expect(names()).toEqual(['context', 'context']);
    expect(sent[0].p).toMatchObject({ code: 'ACI', members: 12 });
    expect(sent[1].p).toMatchObject({ code: 'EC2' });
    expect(sent[1].p).not.toHaveProperty('members');
  });
});

describe('error capture', () => {
  it('dedupes the same message inside the dedupe window', () => {
    // A render loop throwing every frame is one fact, not a thousand.
    trackException(new Error('same thing'), 'MapCanvas');
    trackException(new Error('same thing'), 'MapCanvas');
    expect(names()).toEqual(['error.caught']);
  });

  it('keeps a genuinely different error', () => {
    trackException(new Error('first'), 'A');
    trackException(new Error('second'), 'B');
    expect(names()).toEqual(['error.caught', 'error.caught']);
  });

  it('records where it was caught', () => {
    trackException(new Error('nope'), 'GroupDashboard');
    expect(sent[0].p).toMatchObject({ message: 'nope', where: 'GroupDashboard' });
  });
});

describe('stripLabels', () => {
  // The real line that leaked, from a 2026-08-27 export: it carried nine of the
  // engineer's own group labels and their ETABS section names into the log, while the
  // Diagnostics page promised no names are recorded.
  const REAL = 'Suggested 2/12 groups · torsion ≤ 0.00 on every cage applied · 10 unresolved'
    + ' (LOWER ROOF · B18X60-5KSI, LOWER ROOF · LB18X60X168-6KSI, L02 · B18X60-5KSI,'
    + ' L01 · LB18X60X64-6KSI)';

  it('removes the name list but keeps every count', () => {
    const out = stripLabels(REAL);
    expect(out).not.toContain('LOWER ROOF');
    expect(out).not.toContain('B18X60');
    expect(out).toContain('Suggested 2/12 groups');
    expect(out).toContain('10 unresolved');
    expect(out).toContain('torsion ≤ 0.00');
  });

  it('says how many names it removed rather than hiding that it did', () => {
    // Counted by SEPARATOR, so a label containing a space is still one name.
    expect(stripLabels('3 unresolved (Alpha, Beta, Gamma with a space)'))
      .toBe('3 unresolved (3 names omitted)');
  });

  it('keeps a short aside that is not a list', () => {
    const msg = 'Design code changed (ACI 318-19)';
    expect(stripLabels(msg)).toBe(msg);
  });

  it('keeps a long parenthetical that carries no separators', () => {
    // Prose about the app, not a list of the user's things.
    const msg = 'Suggest stopped (the sweep was paused and never resumed by the user)';
    expect(stripLabels(msg)).toBe(msg);
  });

  it('leaves a message with no parentheses alone', () => {
    expect(stripLabels('Suggested 5/5 groups')).toBe('Suggested 5/5 groups');
  });

  it('handles several lists in one message', () => {
    expect(stripLabels('a (One, Two, Three long) and b (Five, Six, Seven long)'))
      .toBe('a (3 names omitted) and b (3 names omitted)');
  });
});

describe('compactStack', () => {
  it('reduces a packaged file:// frame to its basename', () => {
    const stack = [
      'Error: boom',
      '    at computeFlexure (file:///C:/Program%20Files/S-Dashboard/resources/app.asar/dist/assets/index-oZdfSgoH.js:12:34)',
    ].join('\n');
    // Asserted whole, not by absence: checking only that some segments are missing is
    // how a regex that captures the wrong segment passes a test it should have failed.
    expect(compactStack(stack)).toBe('Error: boom | at computeFlexure (index-oZdfSgoH.js:12:34)');
  });

  it('reduces a Windows path frame to its basename', () => {
    expect(compactStack('at f (C:\\Users\\someone\\app\\dist\\bundle.js:9:1)'))
      .toBe('at f (bundle.js:9:1)');
  });

  it('returns undefined for a missing stack rather than an empty string', () => {
    expect(compactStack(undefined)).toBeUndefined();
    expect(compactStack(null)).toBeUndefined();
  });
});
