/**
 * The run log behind the status bar's ⋯ button.
 *
 * The strip carries one line and the next task overwrites it, so an outcome worth acting
 * on — "2 need a BIGGER SECTION (L2 Spandrels, Transfer)" — used to live only until
 * something else started. The log is where that line goes now, which makes two things
 * load-bearing: that a task's END NOTE is captured (it is the whole point), and that the
 * snapshot is stable by REFERENCE between reads, because `useSyncExternalStore` compares
 * snapshots that way and a fresh array each call is an infinite render loop.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginActivity, clearActivityLog, getActivityLog, logActivity, resetActivity,
  subscribeActivity,
} from '../activity';

beforeEach(() => resetActivity());

describe('what lands in the log', () => {
  it('a task records its start and its outcome', () => {
    const t = beginActivity({ label: 'Suggest — preparing…', total: 3 });
    t.end('Suggested 2/3 groups · 1 unresolved');
    expect(getActivityLog().map(e => [e.kind, e.message])).toEqual([
      ['start', 'Suggest — preparing…'],
      ['done', 'Suggested 2/3 groups · 1 unresolved'],
    ]);
  });

  it('progress ticks do NOT — a log of 5,700 rows is not a log', () => {
    const t = beginActivity({ label: 'Sizing', total: 200 });
    for (let i = 0; i < 50; i++) t.update({ done: i, label: `Sizing group ${i}` });
    expect(getActivityLog()).toHaveLength(1);
  });

  it('an end with no note leaves nothing behind', () => {
    beginActivity({ label: 'Quiet task' }).end();
    expect(getActivityLog().map(e => e.kind)).toEqual(['start']);
  });

  it('blank and whitespace-only messages are dropped, not stored as empty rows', () => {
    logActivity('   ');
    logActivity('');
    expect(getActivityLog()).toHaveLength(0);
  });

  it('kinds are carried through, so the panel can colour an error red', () => {
    logActivity('Could not reach ETABS', 'error');
    logActivity('Imported 174 beams', 'info');
    expect(getActivityLog().map(e => e.kind)).toEqual(['error', 'info']);
  });

  it('entries are ordered oldest first and numbered monotonically', () => {
    logActivity('one');
    logActivity('two');
    logActivity('three');
    const seqs = getActivityLog().map(e => e.seq);
    expect(getActivityLog().map(e => e.message)).toEqual(['one', 'two', 'three']);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
  });
});

describe('the log cannot grow without bound', () => {
  it('caps at 200 and keeps the NEWEST, which is the half anyone reads', () => {
    for (let i = 0; i < 260; i++) logActivity(`entry ${i}`);
    const log = getActivityLog();
    expect(log).toHaveLength(200);
    expect(log[0].message).toBe('entry 60');
    expect(log[log.length - 1].message).toBe('entry 259');
  });
});

describe('the store contract the status bar relies on', () => {
  it('the same log reads back by REFERENCE until something changes it', () => {
    logActivity('one');
    expect(getActivityLog()).toBe(getActivityLog());
    const before = getActivityLog();
    logActivity('two');
    expect(getActivityLog()).not.toBe(before);
  });

  it('an empty log is a stable reference too — the idle case must not re-render forever', () => {
    expect(getActivityLog()).toBe(getActivityLog());
  });

  it('writing to the log notifies subscribers', () => {
    let calls = 0;
    const off = subscribeActivity(() => { calls++; });
    logActivity('something happened');
    off();
    expect(calls).toBeGreaterThan(0);
  });

  it('Clear empties it without disturbing the running task', () => {
    const t = beginActivity({ label: 'Batch', total: 10 });
    t.update({ done: 4 });
    clearActivityLog();
    expect(getActivityLog()).toHaveLength(0);
    // Still running, still countable — clearing the log is a view action, not a stop.
    t.end('Batch finished');
    expect(getActivityLog().map(e => e.message)).toEqual(['Batch finished']);
  });

  it('resetActivity drops the log and restarts numbering', () => {
    logActivity('before');
    resetActivity();
    expect(getActivityLog()).toHaveLength(0);
    logActivity('after');
    expect(getActivityLog()[0].seq).toBe(1);
  });
});
