/**
 * Suggest — the min/max window, and the order the faces are solved in.
 *
 * The window is a promise: if it says #6–#9, a cage of #5s or #11s is a broken promise,
 * not a clever optimisation. And an empty window has to be reported rather than silently
 * searched as if it were the full ladder — that is the failure mode where the engineer
 * asks for one thing, gets another, and has no way to tell.
 */
import { describe, it, expect } from 'vitest';
import { suggestGroupRebar, isSuggestError, suggestSizeCandidates } from '../suggestRebar';
import type { Member } from '../../types';

const beam = (o: { b?: number; h?: number; MuPos?: number; MuNeg?: number; Vu?: number }): Member => ({
  id: 'm', label: 'm', memberType: 'beam',
  material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
  section: { type: 'rectangular_beam', b: o.b ?? 18, h: o.h ?? 60, coverClear: 1.5, stirrupDia: 4 },
  rebar: {
    topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 2, barSize: 5 }],
    ties: { barSize: 4, spacing: 6, legs: 2 },
  },
  loads: [{ id: 'lc', label: 'ENV', Mu_pos: o.MuPos ?? 600, Mu_neg: o.MuNeg ?? 500, Vu: o.Vu ?? 120, Tu: 0, Pu: 0 }],
  span: 25,
});

const sizes = (bars: { barSize: number }[]) => bars.map(b => Math.abs(b.barSize));

describe('bar-size window', () => {
  it('honours a MAXIMUM — no bar larger than asked for', () => {
    const r = suggestGroupRebar([beam({})], 'ACI318-19', 0.9,
      { maxTopBar: 8, maxBotBar: 8 });
    if (isSuggestError(r)) throw new Error(r.error);
    for (const n of [...sizes(r.rebar.topBars), ...sizes(r.rebar.botBars)]) {
      expect(n).toBeLessThanOrEqual(8);
    }
  });

  it('honours a MINIMUM — no bar smaller than asked for', () => {
    const r = suggestGroupRebar([beam({})], 'ACI318-19', 0.9,
      { minTopBar: 9, minBotBar: 9 });
    if (isSuggestError(r)) throw new Error(r.error);
    for (const n of [...sizes(r.rebar.topBars), ...sizes(r.rebar.botBars)]) {
      expect(n).toBeGreaterThanOrEqual(9);
    }
  });

  it('honours both ends at once', () => {
    const r = suggestGroupRebar([beam({})], 'ACI318-19', 0.9,
      { minTopBar: 7, maxTopBar: 8, minBotBar: 7, maxBotBar: 8 });
    if (isSuggestError(r)) throw new Error(r.error);
    for (const n of [...sizes(r.rebar.topBars), ...sizes(r.rebar.botBars)]) {
      expect(n).toBeGreaterThanOrEqual(7);
      expect(n).toBeLessThanOrEqual(8);
    }
  });

  it('caps the STIRRUP size', () => {
    const r = suggestGroupRebar([beam({ Vu: 300 })], 'ACI318-19', 0.9, { maxStirrup: 4 });
    if (isSuggestError(r)) throw new Error(r.error);
    expect(Math.abs(r.rebar.ties!.barSize)).toBeLessThanOrEqual(4);
  });

  it('reports an EMPTY window instead of quietly searching the whole ladder', () => {
    // The faces share one longitudinal size, so #9-or-larger on top and #8-or-smaller
    // on the bottom leaves nothing. Silently ignoring one of them would hand back a
    // cage that violates a constraint the engineer typed in.
    const r = suggestGroupRebar([beam({})], 'ACI318-19', 0.9,
      { minTopBar: 9, maxBotBar: 8 });
    expect(isSuggestError(r)).toBe(true);
    if (!isSuggestError(r)) return;
    expect(r.kind).toBe('bar-floor');
  });

  it('leaves the default search untouched when no window is given', () => {
    const withNone = suggestGroupRebar([beam({})], 'ACI318-19', 0.9);
    const withEmpty = suggestGroupRebar([beam({})], 'ACI318-19', 0.9, {});
    if (isSuggestError(withNone) || isSuggestError(withEmpty)) throw new Error('expected cages');
    expect(withEmpty.rebar).toEqual(withNone.rebar);
  });
});

describe('stirrup spacing window', () => {
  it('never proposes a spacing looser than the maximum asked for', () => {
    const r = suggestGroupRebar([beam({ Vu: 60 })], 'ACI318-19', 0.9, { maxSpacing: 6 });
    if (isSuggestError(r)) throw new Error(r.error);
    for (const z of r.rebar.tieZones ?? [{ spacing: r.rebar.ties!.spacing }]) {
      expect(z.spacing).toBeLessThanOrEqual(6 + 1e-9);
    }
  });

  it('never proposes one tighter than the minimum asked for', () => {
    // A buildability floor: "do not hand me links at 4 inches".
    const r = suggestGroupRebar([beam({ Vu: 120 })], 'ACI318-19', 0.9, { minSpacing: 8 });
    if (isSuggestError(r)) throw new Error(r.error);
    for (const z of r.rebar.tieZones ?? [{ spacing: r.rebar.ties!.spacing }]) {
      expect(z.spacing).toBeGreaterThanOrEqual(8 - 1e-9);
    }
  });

  it('says so when the window excludes every rung', () => {
    const r = suggestGroupRebar([beam({})], 'ACI318-19', 0.9, { minSpacing: 20, maxSpacing: 24 });
    expect(isSuggestError(r)).toBe(true);
    if (!isSuggestError(r)) return;
    expect(r.kind).toBe('bar-floor');
    expect(r.error).toMatch(/spacing/i);
  });

  it('offers the dialog the same spacing ladder the search uses', () => {
    // Two hard-coded lists that drift apart is how the bar catalogues broke twice.
    const { spacing } = suggestSizeCandidates('ACI318-19', 'us');
    expect(spacing).toEqual([4, 6, 8, 10, 12]);
  });
});

describe('the faces are solved sagging-first', () => {
  it('records the positive moment before the negative one', () => {
    const r = suggestGroupRebar([beam({})], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    const stages = r.steps!.map(s => s.stage);
    expect(stages.indexOf('flexure+')).toBeLessThan(stages.indexOf('flexure−'));
    expect(stages.indexOf('flexure−')).toBeLessThan(stages.indexOf('shear'));
    expect(stages.indexOf('shear')).toBeLessThan(stages.indexOf('detailing'));
  });

  it('each moment row reports only its own face', () => {
    const r = suggestGroupRebar([beam({})], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    const pos = r.steps!.find(s => s.stage === 'flexure+')!;
    const neg = r.steps!.find(s => s.stage === 'flexure−')!;
    expect(pos.chose).toMatch(/^bot /);
    expect(neg.chose).toMatch(/^top /);
    // Both faces are brought under the target — that is the point of solving them in turn.
    expect(pos.flexDCR).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(neg.flexDCR).toBeLessThanOrEqual(0.9 + 1e-6);
  });
});
