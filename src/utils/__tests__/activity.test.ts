/**
 * The status bar's store, and the one property that makes its pause button honest:
 * a paused task actually stops, and resuming actually restarts it.
 *
 * The bar is 22px of chrome, but a pause switch that does not stop the work is worse
 * than no switch — so these tests drive a real chunked loop through `gate()` rather
 * than asserting on the flag alone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginActivity, beginIndeterminate, getActivity, pauseActivity, resetActivity,
  resumeActivity, subscribeActivity, toggleActivity,
} from '../activity';

beforeEach(() => resetActivity());

/** Let queued microtasks and the 0ms timers inside gate() run. */
const tick = () => new Promise(r => setTimeout(r, 0));

describe('the idle state', () => {
  it('starts finished and empty, so the bar has nothing to claim', () => {
    const a = getActivity();
    expect(a.finished).toBe(true);
    expect(a.label).toBe('');
    expect(a.total).toBe(0);
    expect(a.pausable).toBe(false);
  });

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    // Counts the FACT of notification, not how many. The store also notifies for the
    // run log, so pinning an exact number here just breaks whenever something else
    // legitimately publishes — what the bar needs is "we were told", and "we stopped
    // being told".
    let n = 0;
    const off = subscribeActivity(() => { n++; });
    const t = beginActivity({ label: 'x', total: 2 });
    expect(n).toBeGreaterThan(0);
    const afterBegin = n;
    t.update({ done: 1 });
    expect(n).toBeGreaterThan(afterBegin);
    const afterUpdate = n;
    off();
    t.update({ done: 2 });
    expect(n).toBe(afterUpdate);
  });
});

describe('progress reporting', () => {
  it('carries label, done and total, and freezes the snapshot', () => {
    const t = beginActivity({ label: 'Sizing', total: 24 });
    t.update({ done: 7, label: 'Sizing L2 Spandrels' });
    const a = getActivity();
    expect(a).toEqual(expect.objectContaining({ done: 7, total: 24, label: 'Sizing L2 Spandrels' }));
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('replaces the snapshot rather than mutating it, so a store compare sees the change', () => {
    const t = beginActivity({ label: 'x', total: 2 });
    const before = getActivity();
    t.update({ done: 1 });
    expect(getActivity()).not.toBe(before);
  });

  it('end() completes the bar and keeps the closing note', () => {
    const t = beginActivity({ label: 'Sizing', total: 5 });
    t.update({ done: 2 });
    t.end('Suggested 5/5 groups');
    const a = getActivity();
    expect(a.finished).toBe(true);
    expect(a.label).toBe('Suggested 5/5 groups');
    expect(a.done).toBe(5);          // a finished determinate bar reads full
  });

  it('a stale handle cannot move the bar after a newer task took it', () => {
    const first = beginActivity({ label: 'first', total: 10 });
    beginActivity({ label: 'second', total: 3 });
    first.update({ done: 9, label: 'first again' });
    first.end('first done');
    expect(getActivity().label).toBe('second');
  });
});

describe('pause actually pauses', () => {
  it('holds a chunked loop at a boundary and releases it on resume', async () => {
    const seen: number[] = [];
    const t = beginActivity({ label: 'sweep', total: 5, pausable: true });
    const loop = (async () => {
      for (let i = 0; i < 5; i++) {
        await t.gate();
        seen.push(i);
        t.update({ done: i + 1 });
      }
      t.end('done');
    })();

    await tick();
    pauseActivity();
    expect(getActivity().paused).toBe(true);
    // Pause lands at the NEXT gate, so the chunk already in flight finishes — which is
    // the point of pausing at a boundary rather than mid-work. Let it land, THEN hold.
    await tick();
    const atPause = seen.length;

    // Give it every chance to keep going. It must not.
    await tick(); await tick(); await tick();
    expect(seen.length).toBe(atPause);
    expect(atPause).toBeLessThan(5);

    resumeActivity();
    await loop;
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(getActivity().finished).toBe(true);
  });

  it('the model is untouched while paused — nothing is applied mid-sweep', async () => {
    // The sweep's own guarantee: results accumulate, and the caller applies them only
    // after the loop returns. A pause therefore leaves zero applied.
    const applied: number[] = [];
    const resolved: number[] = [];
    const t = beginActivity({ label: 'sweep', total: 4, pausable: true });
    const loop = (async () => {
      for (let i = 0; i < 4; i++) { await t.gate(); resolved.push(i); }
      applied.push(...resolved);          // one application, at the end
      t.end();
    })();
    await tick();
    pauseActivity();
    await tick(); await tick();
    expect(resolved.length).toBeGreaterThan(0);
    expect(applied).toEqual([]);          // nothing applied while held
    resumeActivity();
    await loop;
    expect(applied).toEqual([0, 1, 2, 3]);
  });

  it('refuses to pause a task that did not opt in', () => {
    beginActivity({ label: 'sidecar', total: 0, pausable: false });
    pauseActivity();
    expect(getActivity().paused).toBe(false);
    toggleActivity();
    expect(getActivity().paused).toBe(false);
  });

  it('toggle flips both ways', () => {
    beginActivity({ label: 'x', total: 3, pausable: true });
    toggleActivity();
    expect(getActivity().paused).toBe(true);
    toggleActivity();
    expect(getActivity().paused).toBe(false);
  });

  it('a new task clears an inherited pause and releases the old waiters', async () => {
    const t = beginActivity({ label: 'old', total: 3, pausable: true });
    let unblocked = false;
    const waiting = t.gate().then(() => { unblocked = true; });
    pauseActivity();
    await tick();

    beginActivity({ label: 'new', total: 2, pausable: true });
    await waiting;
    expect(unblocked).toBe(true);                 // the old driver can unwind
    expect(getActivity().paused).toBe(false);     // and the new task starts running
    expect(getActivity().label).toBe('new');
  });

  it('end() while paused releases the loop rather than stranding it', async () => {
    const t = beginActivity({ label: 'x', total: 3, pausable: true });
    // Pause BEFORE the gate: a gate already passed cannot be recalled, so this is the
    // only ordering in which a driver is genuinely held.
    pauseActivity();
    let done = false;
    const waiting = t.gate().then(() => { done = true; });
    await tick(); await tick();
    expect(done).toBe(false);
    t.end();
    await waiting;
    expect(done).toBe(true);
  });
});

describe('indeterminate work', () => {
  it('reports a moving label with no total and no pause', () => {
    const h = beginIndeterminate('Launching S-Concrete BatchReporter…');
    expect(getActivity()).toEqual(expect.objectContaining({ total: 0, pausable: false }));
    h.set('Running the batch designer…');
    expect(getActivity().label).toBe('Running the batch designer…');
    h.end('Batch complete');
    expect(getActivity().finished).toBe(true);
    expect(getActivity().label).toBe('Batch complete');
  });
});
