/**
 * The Model view histogram's binning.
 *
 * The drawing is a few rectangles; what is worth pinning is the arithmetic behind them,
 * because every way it can be wrong is silent — a bar in the wrong bucket, a beam with
 * no result counted as a zero, or a beam outside the x limits quietly disappearing all
 * render as a perfectly plausible chart. The ids each bin carries matter for the same
 * reason: they are what the map draws heavy on hover, so a bin holding the wrong ones
 * points at the wrong beams while looking entirely correct.
 */
import { describe, it, expect } from 'vitest';
import { buildBins, defaultLimits, countTicks } from '../PlanHistogram.jsx';

/** `n` beams at the given values, ids b0, b1, … */
const items = (...vs: (number | undefined | null)[]) =>
  vs.map((v, i) => ({ id: `b${i}`, v: v as number }));

describe('buildBins — counting beams into bins', () => {
  it('puts each value in the bin its range covers', () => {
    const { bins, total } = buildBins(items(0, 2.5, 5, 7.5, 9.99), 0, 10, 10);
    expect(total).toBe(5);
    expect(bins.map(b => b.n)).toEqual([1, 0, 1, 0, 0, 1, 0, 1, 0, 1]);
  });

  it('lands a value exactly on a boundary in the UPPER bin', () => {
    const { bins } = buildBins(items(5), 0, 10, 10);
    expect(bins[5].n).toBe(1);
    expect(bins[4].n).toBe(0);
  });

  it('puts the top of the range in the LAST bin, not off the end', () => {
    const { bins } = buildBins(items(10), 0, 10, 10);
    expect(bins[9].n).toBe(1);
    expect(bins).toHaveLength(10);
  });

  it('DROPS a beam with no value rather than binning it at zero', () => {
    // A member with no result yet is missing data. Counting it as zero reads as a
    // cluster of zero-DCR beams that do not exist.
    const { bins, total } = buildBins(items(1, undefined, NaN, null, 2), 0, 4, 4);
    expect(total).toBe(2);
    expect(bins.reduce((n, b) => n + b.n, 0)).toBe(2);
  });

  it('survives a model where every beam is identical (zero range)', () => {
    const { bins, total } = buildBins(items(3, 3, 3), 3, 3, 8);
    expect(total).toBe(3);
    expect(bins.reduce((n, b) => n + b.n, 0)).toBe(3);
  });

  it('returns nothing for an empty series', () => {
    expect(buildBins([], 0, 1)).toMatchObject({ bins: [], total: 0, under: 0, over: 0 });
  });
});

describe('buildBins — values outside the x limits are CLAMPED, never lost', () => {
  it('stacks low values into the first bar and high ones into the last', () => {
    const { bins, total, under, over } = buildBins(items(-5, -1, 0.5, 9.5, 20, 30), 0, 10, 10);
    expect(under).toBe(2);
    expect(over).toBe(2);
    expect(bins[0].n).toBe(3);   // the two below, plus the 0.5 that genuinely belongs
    expect(bins[9].n).toBe(3);   // the two above, plus the 9.5
    // The whole point: tightening the limits must not change how many beams there are.
    expect(total).toBe(6);
    expect(bins.reduce((n, b) => n + b.n, 0)).toBe(6);
  });

  it('reports zero under/over when everything fits', () => {
    const { under, over } = buildBins(items(2, 4, 6), 0, 10, 10);
    expect(under).toBe(0);
    expect(over).toBe(0);
  });
});

describe('buildBins — the ids a bar points at', () => {
  it('carries the members of each bin, and only those', () => {
    const { bins } = buildBins(items(0.5, 0.6, 5.5), 0, 10, 10);
    expect(bins[0].ids.sort()).toEqual(['b0', 'b1']);
    expect(bins[5].ids).toEqual(['b2']);
    expect(bins[3].ids).toEqual([]);
  });

  it('keeps ids and count in step for every bin', () => {
    const { bins } = buildBins(items(1, 2, 2.5, 8, 8.1, 8.2), 0, 10, 10);
    for (const b of bins) expect(b.ids).toHaveLength(b.n);
  });

  it('gives the end bar the CLAMPED members, not just the ones in its range', () => {
    // The bar is drawn as "≤ 0" and holds three beams; hovering it must light up all
    // three on the map, including the two that sit off the left of the axis. A range
    // test on [x0, x1] would find only the third.
    const { bins } = buildBins(items(-40, -12, 0.2), 0, 10, 10);
    expect(bins[0].n).toBe(3);
    expect(bins[0].ids.sort()).toEqual(['b0', 'b1', 'b2']);
  });

  it('drops the id of a beam whose value is missing', () => {
    const { bins } = buildBins(items(1, undefined, 2), 0, 4, 4);
    expect(bins.flatMap(b => b.ids).sort()).toEqual(['b0', 'b2']);
  });
});

describe('defaultLimits', () => {
  it('rounds outwards to a step a person would choose', () => {
    const { lo, hi } = defaultLimits(items(0.88, 1.12, 1.95));
    expect(lo).toBeLessThanOrEqual(0.88);
    expect(hi).toBeGreaterThanOrEqual(1.95);
    // Round, not 0.88–1.95 exactly.
    expect(Number.isInteger(lo / 0.1)).toBe(true);
  });

  it('gives a single-valued model a visible span instead of a zero one', () => {
    const { lo, hi } = defaultLimits(items(24, 24, 24));
    expect(hi).toBeGreaterThan(lo);
  });

  it('falls back to 0–1 with nothing to measure', () => {
    expect(defaultLimits([])).toEqual({ lo: 0, hi: 1 });
  });
});

describe('countTicks — the Y axis counts beams, so ticks are whole', () => {
  it('never produces a fractional beam', () => {
    for (const peak of [1, 2, 3, 7, 12, 40, 137]) {
      for (const t of countTicks(peak)) expect(Number.isInteger(t)).toBe(true);
    }
  });

  it('starts at zero and covers the peak', () => {
    const ticks = countTicks(7);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(7);
  });

  it('handles an empty chart', () => {
    expect(countTicks(0)).toEqual([0]);
  });
});
