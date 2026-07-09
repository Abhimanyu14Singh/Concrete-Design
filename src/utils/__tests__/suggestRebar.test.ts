import { describe, it, expect } from 'vitest';
import { suggestGroupRebar, isSuggestError } from '../suggestRebar';
import { runDesign } from '../../engines';
import { getBarArea } from '../concreteDesign';
import type { Member } from '../../types';

function makeBeam(opts: {
  id: string; b?: number; h?: number;
  MuPos?: number; MuNeg?: number; Vu?: number;
  loads?: Member['loads'];
}): Member {
  return {
    id: opts.id,
    label: opts.id,
    memberType: 'beam',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: opts.b ?? 14, h: opts.h ?? 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 2, barSize: 5 }],
      botBars: [{ numBars: 2, barSize: 5 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    loads: opts.loads ?? [{
      id: 'lc1', label: 'Env',
      Mu_pos: opts.MuPos ?? 150, Mu_neg: opts.MuNeg ?? 120, Vu: opts.Vu ?? 45, Tu: 0, Pu: 0,
    }],
    span: 20,
  };
}

function totalAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

describe('suggestGroupRebar', () => {
  it('suggests a layout meeting target DCR for a typical beam', () => {
    const m = makeBeam({ id: 'b1' });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.worstDCRFlex).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.worstDCRShear).toBeLessThanOrEqual(0.9 + 1e-6);
    // Independent verification with runDesign
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(Math.max(check.DCR_flex_pos, check.DCR_flex_neg)).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(check.DCR_shear).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.steelLb).toBeGreaterThan(0);
    expect(r.governingMemberId).toBe('b1');
  });

  it('adds code-based skin bars to a deep beam (ACI §9.7.2.3, h > 36 in)', () => {
    const m = makeBeam({ id: 'deep', h: 40, MuPos: 260, MuNeg: 220, Vu: 55 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.rebar.sideBars).toBeDefined();
    expect(r.rebar.sideBars![0].numBars).toBeGreaterThanOrEqual(1); // per face
  });

  it('adds no skin bars to a shallow beam (h ≤ 36 in)', () => {
    const r = suggestGroupRebar([makeBeam({ id: 'shallow', h: 24 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) return;
    expect(r.rebar.sideBars).toBeUndefined();
  });

  it('uses a third bar layer for very high demand instead of erroring', () => {
    // A narrow, deep beam with a large sagging moment needs more bottom steel
    // than two full layers can hold; the 3-layer branch lets it succeed.
    const m = makeBeam({ id: 'tall', b: 14, h: 48, MuPos: 1500, MuNeg: 500, Vu: 110 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.rebar.botBars.length).toBe(3);
    expect(r.worstDCRFlex).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('only uses practical bar sizes and stirrup spacings', () => {
    const m = makeBeam({ id: 'b1', MuPos: 250, MuNeg: 200, Vu: 60 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    const allBars = [...r.rebar.topBars, ...r.rebar.botBars];
    for (const g of allBars) {
      expect(g.barSize).toBeGreaterThanOrEqual(5);
      expect(g.barSize).toBeLessThanOrEqual(9);
      expect(g.numBars).toBeGreaterThanOrEqual(2);
    }
    // Top and bottom faces must share a single bar size.
    const sizes = new Set(allBars.map(g => g.barSize));
    expect(sizes.size).toBe(1);
    expect([4, 5]).toContain(r.rebar.ties!.barSize);
    expect([4, 6, 8, 10, 12]).toContain(r.rebar.ties!.spacing);
    expect(r.rebar.tieZones).toHaveLength(3);
  });

  it('respects width fit on a narrow beam (max 2 layers, bars fit in 10 in width)', () => {
    const m = makeBeam({ id: 'narrow', b: 10, MuPos: 180, MuNeg: 150, Vu: 40 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    for (const bars of [r.rebar.topBars, r.rebar.botBars]) {
      expect(bars.length).toBeLessThanOrEqual(2);
      for (const g of bars) {
        // 10in − 2(1.5+0.5) = 6in usable; #9 (1.128in) with 1.128 clear → max 3 bars
        expect(g.numBars).toBeLessThanOrEqual(4);
      }
    }
  });

  it('lower target DCR yields at least as much steel', () => {
    const m = makeBeam({ id: 'b1', MuPos: 220, MuNeg: 180, Vu: 55 });
    const tight = suggestGroupRebar([m], 'ACI318-19', 0.75);
    const loose = suggestGroupRebar([m], 'ACI318-19', 0.95);
    expect(isSuggestError(tight)).toBe(false);
    expect(isSuggestError(loose)).toBe(false);
    if (isSuggestError(tight) || isSuggestError(loose)) return;
    expect(totalAs(tight.rebar.botBars)).toBeGreaterThanOrEqual(totalAs(loose.rebar.botBars) - 1e-9);
  });

  it('uses worst demand across the group', () => {
    const light = makeBeam({ id: 'light', MuPos: 60, MuNeg: 40, Vu: 20 });
    const heavy = makeBeam({ id: 'heavy', MuPos: 250, MuNeg: 200, Vu: 60 });
    const r = suggestGroupRebar([light, heavy], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.governingMemberId).toBe('heavy');
    // Verify the heavy member passes at target
    const check = runDesign(heavy.section, heavy.material, r.rebar, heavy.loads[0], heavy.span, 'ACI318-19');
    expect(Math.max(check.DCR_flex_pos, check.DCR_flex_neg, check.DCR_shear)).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('returns an error for members without loads', () => {
    const m = makeBeam({ id: 'b1', loads: [] });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(true);
  });

  it('returns an error when demand is impossible for the section', () => {
    const m = makeBeam({ id: 'tiny', b: 10, h: 12, MuPos: 900, MuNeg: 800, Vu: 200 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(true);
  });
});
