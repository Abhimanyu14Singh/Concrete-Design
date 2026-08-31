/**
 * The frame meter's arithmetic and its off-by-default contract.
 *
 * The statistics matter because they are what a decision gets made on: "60 fps mean with
 * a 90 ms worst" and "35 fps mean" call for different fixes, and a meter that reported
 * the mean alone would hide a stutter entirely. The off-by-default part matters because
 * a always-running requestAnimationFrame loop would be a cost added by the tool meant to
 * find one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { frameStats, getPerf, resetPerf, sceneStats, startPerf, stopPerf, subscribePerf, togglePerf } from '../perfProbe';

beforeEach(() => resetPerf());
afterEach(() => resetPerf());

describe('frame statistics', () => {
  it('reports mean, median, p95, worst and fps from the sample window', () => {
    // 16.7 ms x 19 plus one 100 ms stutter — a smooth orbit with a single hitch.
    const s = frameStats([...Array(19).fill(16.7), 100])!;
    expect(s.samples).toBe(20);
    expect(s.median).toBeCloseTo(16.7, 1);
    expect(s.worst).toBe(100);
    // The mean is dragged up by the hitch, which is exactly why it is not shown alone.
    expect(s.mean).toBeGreaterThan(16.7);
    expect(s.fps).toBe(Math.round(1000 / s.mean));
  });

  it('p95 catches a stutter the median hides', () => {
    const smooth = frameStats(Array(100).fill(16.7))!;
    const hitchy = frameStats([...Array(95).fill(16.7), ...Array(5).fill(120)])!;
    expect(hitchy.median).toBeCloseTo(smooth.median, 1);   // same middle
    expect(hitchy.p95).toBeGreaterThan(smooth.p95 * 3);    // different tail
  });

  it('needs at least two samples to say anything', () => {
    expect(frameStats([])).toBeNull();
    expect(frameStats([16.7])).toBeNull();
  });

  it('does not divide by zero on a degenerate window', () => {
    const s = frameStats([0, 0])!;
    expect(Number.isFinite(s.fps)).toBe(true);
  });
});

describe('the meter is off until asked for', () => {
  it('starts disabled with no statistics', () => {
    const p = getPerf();
    expect(p.enabled).toBe(false);
    expect(p.stats).toBeNull();
  });

  it('start and stop flip the flag and notify subscribers', () => {
    let n = 0;
    const off = subscribePerf(() => { n++; });
    startPerf();
    expect(getPerf().enabled).toBe(true);
    expect(n).toBeGreaterThan(0);
    stopPerf();
    expect(getPerf().enabled).toBe(false);
    off();
  });

  it('toggle flips both ways', () => {
    togglePerf();
    expect(getPerf().enabled).toBe(true);
    togglePerf();
    expect(getPerf().enabled).toBe(false);
  });

  it('starting twice is a no-op rather than a second loop', () => {
    startPerf();
    const first = getPerf();
    startPerf();
    expect(getPerf().enabled).toBe(true);
    expect(getPerf()).toBe(first);   // no re-emit, so no second rAF chain
    stopPerf();
  });

  it('stopping clears the readout so a stale number cannot be read as live', () => {
    startPerf();
    stopPerf();
    expect(getPerf().stats).toBeNull();
    expect(getPerf().longTasks).toBe(0);
  });
});

describe('scene stats', () => {
  // The DOM-walking half is exercised in the browser, not here: this suite runs in node
  // and the repo ships no jsdom. What is worth pinning without one is that a missing
  // document degrades to zeros rather than throwing inside a diagnostic.
  it('returns zeros rather than throwing when there is no document', () => {
    const s = sceneStats();
    expect(s).toEqual({ svgNodes: 0, polygons: 0, lines: 0, domTotal: 0 });
  });
});
