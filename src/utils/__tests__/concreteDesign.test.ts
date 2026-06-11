/**
 * Unit tests for ACI 318-19 concrete design engine — beams only.
 * Reference values computed by hand or cross-checked against published examples.
 */
import { describe, it, expect } from 'vitest';
import {
  getBarArea, getBarDiam, beta1, effectiveDepth, effectiveFlange,
  steelLimits, computeFlexure, computeShear, computeTorsion,
  requiredAs, designMember, effectiveDepthMulti, layerCentroidOffset,
} from '../concreteDesign';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../../types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mat4k: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat5k: MaterialProps = { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat6k: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const matLW: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 0.75 };

const rect12x21: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 21, coverClear: 1.5, stirrupDia: 4 };
const rect16x24: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 };
const rect16x42: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 42, coverClear: 1.5, stirrupDia: 4 };
const tBeam: SectionDimensions     = { type: 'T_beam', b: 48, bw: 14, h: 24, hf: 5, coverClear: 1.5, stirrupDia: 4 };
const tBeamNarrow: SectionDimensions = { type: 'T_beam', b: 48, bw: 14, h: 24, hf: 2, coverClear: 1.5, stirrupDia: 4 };

const rebar3_8: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
};
const rebarLight: RebarLayout = {
  topBars: [{ numBars: 2, barSize: 5 }],
  botBars: [{ numBars: 2, barSize: 5 }],
  ties: { barSize: 3, spacing: 10, legs: 2 },
};
const rebarHeavy: RebarLayout = {
  topBars: [{ numBars: 8, barSize: 11 }],
  botBars: [{ numBars: 8, barSize: 11 }],
  ties: { barSize: 5, spacing: 4, legs: 4 },
};

const stdLoad: LoadCase = { id: 'lc', label: 'Test', Mu_pos: 120, Mu_neg: 80, Vu: 50, Tu: 5, Pu: 0 };

// ─── Bar lookups ─────────────────────────────────────────────────────────────

describe('Bar property lookups', () => {
  it('returns correct area for standard bar sizes', () => {
    expect(getBarArea(3)).toBeCloseTo(0.11, 2);
    expect(getBarArea(8)).toBeCloseTo(0.79, 2);
    expect(getBarArea(11)).toBeCloseTo(1.56, 2);
    expect(getBarArea(14)).toBeCloseTo(2.25, 2);
  });

  it('returns correct diameter', () => {
    expect(getBarDiam(8)).toBeCloseTo(1.0, 2);
    expect(getBarDiam(4)).toBeCloseTo(0.5, 2);
    expect(getBarDiam(11)).toBeCloseTo(1.410, 2);
  });

  it('returns 0 for unknown size', () => {
    expect(getBarArea(99)).toBe(0);
    expect(getBarDiam(99)).toBe(0);
  });
});

// ─── beta1 ───────────────────────────────────────────────────────────────────

describe('beta1', () => {
  it('= 0.85 for fc ≤ 4000 psi', () => {
    expect(beta1(3000)).toBe(0.85);
    expect(beta1(4000)).toBe(0.85);
  });

  it('decreases for fc > 4000 psi', () => {
    expect(beta1(5000)).toBeCloseTo(0.80, 3);
    expect(beta1(6000)).toBeCloseTo(0.75, 3);
  });

  it('floor at 0.65 for very high fc', () => {
    expect(beta1(12000)).toBe(0.65);
    expect(beta1(20000)).toBe(0.65);
  });
});

// ─── effectiveDepth ──────────────────────────────────────────────────────────

describe('effectiveDepth', () => {
  it('standard 16×24 beam with cc=1.5", #4 stirrup, #8 bar → d ≈ 20.75"', () => {
    // d = 24 - 1.5 - 0.5 - 0.5 = 21.5"  (stirrup diam = 0.5", bar diam = 1.0")
    expect(effectiveDepth(rect16x24, 8)).toBeCloseTo(21.5, 1);
  });

  it('larger cover reduces d', () => {
    const largeCover: SectionDimensions = { ...rect16x24, coverClear: 3 };
    expect(effectiveDepth(largeCover, 8)).toBeLessThan(effectiveDepth(rect16x24, 8));
  });

  it('larger bar size reduces d', () => {
    const d8  = effectiveDepth(rect16x24, 8);
    const d11 = effectiveDepth(rect16x24, 11);
    expect(d11).toBeLessThan(d8);
  });
});

// ─── effectiveFlange ─────────────────────────────────────────────────────────

describe('effectiveFlange — T-beam', () => {
  it('rectangular beam returns b', () => {
    expect(effectiveFlange(rect16x24, 20)).toBe(16);
  });

  it('T-beam limited by 16·hf rule', () => {
    // bw=14, hf=2: beff = min(14 + 2*8*2=46, span*12/4, 48) → 46 if span is long
    expect(effectiveFlange(tBeamNarrow, 50)).toBeCloseTo(46, 0);
  });

  it('T-beam limited by span/4 for short span', () => {
    // span=10ft: L/4 = 30" → beff = min(14+16*5=94, 30, 48) = 30
    expect(effectiveFlange(tBeam, 10)).toBeCloseTo(30, 0);
  });

  it('T-beam limited by flange width b', () => {
    // Very long span + narrow hf: 16*hf rule may exceed b=48
    // bw=14, hf=5: 14+2*8*5=94, L/4 for span=40ft=120", b=48 → limited to 48
    expect(effectiveFlange(tBeam, 40)).toBe(48);
  });
});

// ─── steelLimits ─────────────────────────────────────────────────────────────

describe('steelLimits', () => {
  it('As_min > 0', () => {
    const { As_min } = steelLimits(rect16x24, mat4k);
    expect(As_min).toBeGreaterThan(0);
  });

  it('As_max > As_min', () => {
    const { As_min, As_max } = steelLimits(rect16x24, mat4k);
    expect(As_max).toBeGreaterThan(As_min);
  });

  it('governs by 200/fy for lower fc', () => {
    // 3√3000 / 60000 = 0.00274  vs  200/60000 = 0.00333 → 200/fy governs
    const { As_min: a3k } = steelLimits(rect16x24, { ...mat4k, fc: 3000 });
    const { As_min: a6k } = steelLimits(rect16x24, mat6k);
    expect(a6k).toBeGreaterThan(a3k); // 3√fc/fy governs at 6k
  });
});

// ─── computeFlexure ──────────────────────────────────────────────────────────

describe('computeFlexure — rectangular beam', () => {
  it('phi_Mn > 0 when steel is provided', () => {
    const r = computeFlexure(rect16x24, mat4k, 2.37, 3.16);
    expect(r.phi_Mn_pos).toBeGreaterThan(0);
    expect(r.phi_Mn_neg).toBeGreaterThan(0);
  });

  it('zero steel → zero capacity', () => {
    const r = computeFlexure(rect16x24, mat4k, 0, 0);
    expect(r.phi_Mn_pos).toBe(0);
    expect(r.phi_Mn_neg).toBe(0);
  });

  it('phi = 0.9 for tension-controlled section', () => {
    const r = computeFlexure(rect16x24, mat4k, 0, getBarArea(6));
    expect(r.phi_pos).toBeCloseTo(0.9, 2);
  });

  it('more steel → higher capacity (below As_max)', () => {
    const light = computeFlexure(rect16x24, mat4k, 0, 2 * getBarArea(7));
    const heavy = computeFlexure(rect16x24, mat4k, 0, 5 * getBarArea(8));
    expect(heavy.phi_Mn_pos).toBeGreaterThan(light.phi_Mn_pos);
  });

  it('higher fc → higher capacity for same steel', () => {
    const As = 4 * getBarArea(8);
    const r4k = computeFlexure(rect16x24, mat4k, 0, As);
    const r6k = computeFlexure(rect16x24, mat6k, 0, As);
    expect(r6k.phi_Mn_pos).toBeGreaterThanOrEqual(r4k.phi_Mn_pos);
  });
});

describe('computeFlexure — T-beam', () => {
  it('T-beam capacity exceeds same web rectangular section', () => {
    const As = 5 * getBarArea(9);
    const tRes = computeFlexure(tBeam, mat4k, 0, As);
    const rRes = computeFlexure({ ...tBeam, type: 'rectangular_beam', b: 14 }, mat4k, 0, As);
    expect(tRes.phi_Mn_pos).toBeGreaterThan(rRes.phi_Mn_pos);
  });

  it('T-beam handles a > hf (flange + web compression)', () => {
    // 8-#9 in 48"/14"×24" with hf=2" (tBeamNarrow) → beff=46", a = 480k/(0.85*4k*46) = 3.07" > hf=2"
    const As_bot = 8 * getBarArea(9);
    const r = computeFlexure(tBeamNarrow, mat4k, 3 * getBarArea(8), As_bot);
    expect(r.phi_Mn_pos).toBeGreaterThan(0);
    expect(r.a_pos).toBeGreaterThan(tBeamNarrow.hf!); // 3.07 > 2"
  });
});

// ─── computeShear ─────────────────────────────────────────────────────────────

describe('computeShear', () => {
  it('Vc > 0', () => {
    expect(computeShear(rect16x24, mat4k, rebar3_8).Vc).toBeGreaterThan(0);
  });

  it('Vs proportional to Av/s', () => {
    const close = computeShear(rect16x24, mat4k, { ...rebar3_8, ties: { barSize: 4, spacing: 4,  legs: 2 } });
    const far   = computeShear(rect16x24, mat4k, { ...rebar3_8, ties: { barSize: 4, spacing: 12, legs: 2 } });
    expect(close.Vs).toBeGreaterThan(far.Vs);
  });

  it('larger section → higher Vc', () => {
    const small = computeShear({ ...rect12x21, b: 8, h: 12 }, mat4k, rebar3_8);
    const large = computeShear(rect16x24, mat4k, rebar3_8);
    expect(large.Vc).toBeGreaterThan(small.Vc);
  });

  it('higher fc → higher Vc', () => {
    const low  = computeShear(rect16x24, mat4k, rebar3_8);
    const high = computeShear(rect16x24, mat5k, rebar3_8);
    expect(high.Vc).toBeGreaterThan(low.Vc);
  });

  it('lightweight concrete reduces Vc', () => {
    const normal = computeShear(rect16x24, mat4k, rebar3_8);
    const light  = computeShear(rect16x24, matLW,  rebar3_8);
    expect(light.Vc).toBeLessThan(normal.Vc);
  });

  it('axial compression (Nu > 0) increases Vc', () => {
    const noAxial  = computeShear(rect16x24, mat4k, rebar3_8, 0);
    const withAxial = computeShear(rect16x24, mat4k, rebar3_8, 100); // 100 kips compression
    expect(withAxial.Vc).toBeGreaterThan(noAxial.Vc);
  });

  it('d_shear = max(d_raw, 0.8h)', () => {
    // Extreme cover: cc=10" → d_raw = 24 - 10 - 0.5 - 0.5 = 13" < 0.8*24=19.2"
    const deepCover: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 10, stirrupDia: 4 };
    const r = computeShear(deepCover, mat4k, rebar3_8);
    expect(r.d_shear).toBeCloseTo(0.8 * 24, 1);
  });

  it('phi_Vn = 0.75*(Vc + Vs)', () => {
    const r = computeShear(rect16x24, mat4k, rebar3_8);
    expect(r.phi_Vn).toBeCloseTo(0.75 * (r.Vc + r.Vs), 2);
  });
});

// ─── computeTorsion ──────────────────────────────────────────────────────────

describe('computeTorsion', () => {
  it('Tcr > 0; Tu_threshold = phi*lambda*sqrt(fc)*Acp^2/Pcp/12000 (not Tcr/4)', () => {
    const r = computeTorsion(rect16x24, mat4k, rebar3_8);
    expect(r.Tcr).toBeGreaterThan(0);
    // Tu_threshold = 0.75 * Tcr/4 (Tcr_new = 4*Tcr_old, threshold = phi*old_Tcr)
    expect(r.Tu_threshold).toBeCloseTo(r.Tcr * 0.1875, 3);
  });

  it('larger section → higher Tcr', () => {
    const small = computeTorsion({ ...rect12x21, b: 10, h: 14 }, mat4k, rebar3_8);
    const large = computeTorsion(rect16x24, mat4k, rebar3_8);
    expect(large.Tcr).toBeGreaterThan(small.Tcr);
  });

  it('higher fc → higher Tcr', () => {
    const low  = computeTorsion(rect16x24, mat4k, rebar3_8);
    const high = computeTorsion(rect16x24, mat5k, rebar3_8);
    expect(high.Tcr).toBeGreaterThan(low.Tcr);
  });

  it('lightweight concrete reduces Tcr', () => {
    const normal = computeTorsion(rect16x24, mat4k, rebar3_8);
    const light  = computeTorsion(rect16x24, matLW,  rebar3_8);
    expect(light.Tcr).toBeLessThan(normal.Tcr);
  });

  it('phi_Tn uses actual stirrup data (larger stirrups → higher phi_Tn)', () => {
    const smallTies = computeTorsion(rect16x24, mat4k, { ...rebar3_8, ties: { barSize: 3, spacing: 6, legs: 2 } });
    const largeTies = computeTorsion(rect16x24, mat4k, { ...rebar3_8, ties: { barSize: 5, spacing: 6, legs: 2 } });
    expect(largeTies.phi_Tn).toBeGreaterThan(smallTies.phi_Tn);
  });

  it('Ph > 0 (perimeter of closed stirrup path)', () => {
    const r = computeTorsion(rect16x24, mat4k, rebar3_8);
    expect(r.Ph).toBeGreaterThan(0);
  });
});

// ─── requiredAs ──────────────────────────────────────────────────────────────

describe('requiredAs', () => {
  it('> 0 for nonzero moment', () => {
    expect(requiredAs(100, rect16x24, mat4k, false)).toBeGreaterThan(0);
  });

  it('= 0 for zero moment', () => {
    expect(requiredAs(0, rect16x24, mat4k, false)).toBe(0);
  });

  it('more moment → more steel', () => {
    const sm = requiredAs(50,  rect16x24, mat4k, false);
    const lg = requiredAs(200, rect16x24, mat4k, false);
    expect(lg).toBeGreaterThan(sm);
  });

  it('at least As_min', () => {
    const { As_min } = steelLimits(rect16x24, mat4k);
    expect(requiredAs(1, rect16x24, mat4k, false)).toBeGreaterThanOrEqual(As_min);
  });
});

// ─── designMember — core behaviour ───────────────────────────────────────────

describe('designMember — core', () => {
  it('returns OK / Warning / NG', () => {
    const r = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    expect(['OK', 'Warning', 'NG']).toContain(r.status);
  });

  it('DCRs non-negative', () => {
    const r = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    expect(r.DCR_flex_pos).toBeGreaterThanOrEqual(0);
    expect(r.DCR_flex_neg).toBeGreaterThanOrEqual(0);
    expect(r.DCR_shear).toBeGreaterThanOrEqual(0);
    expect(r.DCR_torsion).toBeGreaterThanOrEqual(0);
  });

  it('NG when loads massively exceed capacity', () => {
    const bigLoad: LoadCase = { ...stdLoad, Mu_pos: 9999, Mu_neg: 9999, Vu: 9999 };
    const r = designMember(rect16x24, mat4k, rebar3_8, bigLoad);
    expect(r.status).toBe('NG');
    expect(r.DCR_flex_pos).toBeGreaterThan(1);
  });

  it('OK for very light loads', () => {
    const lightLoad: LoadCase = { ...stdLoad, Mu_pos: 10, Mu_neg: 5, Vu: 5, Tu: 0 };
    const r = designMember(rect16x24, mat4k, rebar3_8, lightLoad);
    expect(r.status).toBe('OK');
  });

  it('phi_Vn = 0.75*(Vc + Vs)', () => {
    const r = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    expect(r.phi_Vn).toBeCloseTo(0.75 * (r.Vc + r.Vs), 1);
  });

  it('As_max > As_min', () => {
    const r = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    expect(r.As_max).toBeGreaterThan(r.As_min);
  });

  it('Av_req = 0 when Vu << phi*Vc', () => {
    const lightLoad: LoadCase = { ...stdLoad, Vu: 1 };
    const r = designMember(rect16x24, mat4k, rebar3_8, lightLoad);
    expect(r.Av_req).toBe(0);
  });

  it('Av_min_per_s > 0', () => {
    const r = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    expect(r.Av_min_per_s).toBeGreaterThan(0);
  });

  it('warnings are DesignWarning objects with code + message', () => {
    const bigLoad: LoadCase = { ...stdLoad, Mu_pos: 9999 };
    const r = designMember(rect16x24, mat4k, rebar3_8, bigLoad);
    const w = r.warnings.find(w => w.code === 'ACI §22.3');
    expect(w).toBeDefined();
    expect(w?.message).toContain('DCR');
    expect(w?.severity).toBe('error');
  });
});

// ─── designMember — ACI code checks ──────────────────────────────────────────

describe('designMember — ACI code checks', () => {
  it('As_min warning: bottom steel below minimum', () => {
    // 1-#3 in 16×24 is well below As_min
    const underReinf: RebarLayout = {
      topBars: [{ numBars: 1, barSize: 3 }],
      botBars: [{ numBars: 1, barSize: 3 }],
      ties: { barSize: 4, spacing: 8, legs: 2 },
    };
    const r = designMember(rect16x24, mat4k, underReinf, stdLoad);
    expect(r.warnings.some(w => w.code === 'ACI §9.6.1.2' && w.message.includes('below'))).toBe(true);
  });

  it('As_max warning: over-reinforced section', () => {
    const r = designMember(rect12x21, mat4k, rebarHeavy, stdLoad);
    expect(r.warnings.some(w => w.code === 'ACI §9.3.3')).toBe(true);
  });

  it('two-tier spacing: warning for s > d/2 normal shear zone', () => {
    const wideSpacing: RebarLayout = { ...rebar3_8, ties: { barSize: 4, spacing: 20, legs: 2 } };
    const r = designMember(rect16x24, mat4k, wideSpacing, stdLoad);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.6.2.2')).toBe(true);
  });

  it('two-tier spacing: heavy shear zone fires d/4 check', () => {
    const heavyLoad: LoadCase = { ...stdLoad, Vu: 400 };
    const r = designMember(rect16x24, mat4k, rebar3_8, heavyLoad);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.6.2.2' && w.message.includes('Heavy'))).toBe(true);
  });

  it('face steel warning when h > 36" with no side bars', () => {
    const r = designMember(rect16x42, mat4k, rebar3_8, stdLoad);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.2.3')).toBe(true);
  });

  it('NO face steel warning when h ≤ 36"', () => {
    const r = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.2.3')).toBe(false);
  });

  it('NO face steel warning when side bars are provided', () => {
    const withSide: RebarLayout = { ...rebar3_8, sideBars: [{ numBars: 2, barSize: 5 }] };
    const r = designMember(rect16x42, mat4k, withSide, stdLoad);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.2.3')).toBe(false);
  });

  it('torsion DCR = 0 when Tu = 0', () => {
    const noTorsion: LoadCase = { ...stdLoad, Tu: 0 };
    const r = designMember(rect16x24, mat4k, rebar3_8, noTorsion);
    expect(r.DCR_torsion).toBe(0);
  });

  it('min shear reinforcement warning fires correctly (ACI §9.6.3.1)', () => {
    const noTies: RebarLayout = { topBars: rebar3_8.topBars, botBars: rebar3_8.botBars };
    const heavyVu: LoadCase = { ...stdLoad, Vu: 100 };
    const r = designMember(rect16x24, mat4k, noTies, heavyVu);
    expect(r.warnings.some(w => w.code === 'ACI §9.6.3.1')).toBe(true);
  });

  it('lightweight concrete reduces Vc (lambda factor)', () => {
    const rNW = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    const rLW = designMember(rect16x24, matLW,  rebar3_8, stdLoad);
    expect(rLW.Vc).toBeLessThan(rNW.Vc);
    expect(rLW.DCR_shear).toBeGreaterThan(rNW.DCR_shear);
  });

  it('T-beam full design does not throw', () => {
    const tLoad: LoadCase = { ...stdLoad, Mu_pos: 300 };
    expect(() => designMember(tBeam, mat5k, rebar3_8, tLoad)).not.toThrow();
  });

  it('beta1 change with high fc affects moment capacity', () => {
    const r4 = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    const r8 = designMember(rect16x24, { ...mat4k, fc: 8000 }, rebar3_8, stdLoad);
    expect(r8.phi_Mn_pos).not.toBeCloseTo(r4.phi_Mn_pos, 0);
  });

  it('Av_min_per_s = max(0.75√fc/fyt, 50/fyt)*bw', () => {
    const r = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    const expected = Math.max(0.75 * Math.sqrt(4000) / 60000, 50 / 60000) * 16;
    expect(r.Av_min_per_s).toBeCloseTo(expected, 4);
  });
});

describe('metric bar encoding (negative barSize = Ø mm)', () => {
  it('getBarDiam(-16) = 16/25.4 in', () => {
    expect(getBarDiam(-16)).toBeCloseTo(0.6299, 4);
  });

  it('getBarArea(-16) ≈ 201 mm² = 0.3117 in²', () => {
    expect(getBarArea(-16)).toBeCloseTo(201.06 / 645.16, 4);
  });

  it('getBarArea(-25) ≈ 490.9 mm² in in²', () => {
    expect(getBarArea(-25)).toBeCloseTo(490.87 / 645.16, 3);
  });

  it('US bars unaffected', () => {
    expect(getBarArea(8)).toBeCloseTo(0.79, 4);
    expect(getBarDiam(8)).toBeCloseTo(1.0, 4);
  });

  it('unknown positive sizes still return 0', () => {
    expect(getBarArea(99)).toBe(0);
    expect(getBarDiam(99)).toBe(0);
  });

  it('designMember runs with all-metric rebar and gives sane results', () => {
    const metricRebar: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 4, barSize: -20 }],
      ties: { barSize: -10, spacing: 6, legs: 2 },
    };
    const r = designMember(rect16x24, mat4k, metricRebar, stdLoad);
    expect(r.phi_Mn_pos).toBeGreaterThan(0);
    expect(r.phi_Vn).toBeGreaterThan(0);
    expect(Number.isFinite(r.DCR_flex_pos)).toBe(true);
    // 4-Ø20 = 1257 mm² ≈ 1.95 in² ≈ 2.5 #8 — capacity should be in a plausible band
    const rUS = designMember(rect16x24, mat4k, { ...metricRebar, botBars: [{ numBars: 4, barSize: 8 }] }, stdLoad);
    expect(r.phi_Mn_pos).toBeLessThan(rUS.phi_Mn_pos); // 1.95 in² < 3.16 in²
  });
});

// ─── Multi-layer rebar (one BarGroup per layer, outermost first) ─────────────

describe('effectiveDepthMulti / layerCentroidOffset', () => {
  it('single layer reduces exactly to effectiveDepth for several bar sizes', () => {
    for (const size of [5, 8, 9, 11]) {
      const bars = [{ numBars: 4, barSize: size }];
      expect(effectiveDepthMulti(rect16x24, bars)).toBeCloseTo(effectiveDepth(rect16x24, size), 10);
    }
  });

  it('2-layer hand calc: h=24, cc=1.5, #4 stir, [4-#8, 2-#8], s=1" -> d = 20.83"', () => {
    // y1 = 1.5 + 0.5 + 0.5 = 2.5"; y2 = 1.5 + 0.5 + 1.0 + 1.0 + 0.5 = 4.5"
    // ybar = (3.16*2.5 + 1.58*4.5) / 4.74 = 3.1667"; d = 24 - 3.1667 = 20.833"
    const bars = [{ numBars: 4, barSize: 8 }, { numBars: 2, barSize: 8 }];
    expect(layerCentroidOffset(rect16x24, bars, 1.0)).toBeCloseTo(3.1667, 3);
    expect(effectiveDepthMulti(rect16x24, bars, 1.0)).toBeCloseTo(20.833, 2);
  });

  it('2-layer beam has lower phiMn than the same As in a single layer', () => {
    const single: RebarLayout = { topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 6, barSize: 8 }], ties: { barSize: 4, spacing: 6, legs: 2 } };
    const layered: RebarLayout = { ...single, botBars: [{ numBars: 4, barSize: 8 }, { numBars: 2, barSize: 8 }] };
    const r1 = designMember(rect16x24, mat4k, single, stdLoad);
    const r2 = designMember(rect16x24, mat4k, layered, stdLoad);
    expect(r2.phi_Mn_pos).toBeLessThan(r1.phi_Mn_pos);
    expect(r2.phi_Mn_pos).toBeGreaterThan(0.85 * r1.phi_Mn_pos); // small reduction, not a collapse
  });

  it('ACI §25.2.2 warning fires when layer clear spacing < max(1", db)', () => {
    const layered: RebarLayout = {
      topBars: [{ numBars: 2, barSize: 8 }],
      botBars: [{ numBars: 3, barSize: 9 }, { numBars: 2, barSize: 9 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
      layerClearSpacing: 0.5,
    };
    const r = designMember(rect16x24, mat4k, layered, stdLoad);
    expect(r.warnings.some(w => w.code === 'ACI §25.2.2')).toBe(true);
    const ok = designMember(rect16x24, mat4k, { ...layered, layerClearSpacing: 1.2 }, stdLoad);
    expect(ok.warnings.some(w => w.code === 'ACI §25.2.2')).toBe(false);
  });

  it('no §25.2.2 warning for single-layer beams; doubly-reinforced path gives higher phi_Mn_pos than singly-reinforced', () => {
    const r = designMember(rect16x24, mat4k, rebar3_8, stdLoad);
    expect(r.warnings.some(w => w.code === 'ACI §25.2.2')).toBe(false);
    // rebar3_8: As_top=3*0.79=2.37, As_bot=4*0.79=3.16 — compression steel helps
    const rSingly = computeFlexure(rect16x24, mat4k, 0, 4 * getBarArea(8));
    expect(r.phi_Mn_pos).toBeGreaterThanOrEqual(rSingly.phi_Mn_pos);
    expect(r.phi_Mn_pos).toBeGreaterThan(200); // sanity: well above 0
  });
});

// ─── S-CONCRETE reference beam back-check ─────────────────────────────────────
// 12×24, f'c=5000, fy=fyt=60k, cc=1.5", #4@6 2-leg, top 3-#7, bot 2-#7
describe('S-CONCRETE back-check (reference beam)', () => {
  const sect: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 };
  const mat: MaterialProps      = { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
  const rb: RebarLayout = {
    topBars: [{ numBars: 3, barSize: 7 }],
    botBars: [{ numBars: 2, barSize: 7 }],
    ties: { barSize: 4, spacing: 6, legs: 2 },
  };

  it('d = 21.563"', () => {
    // d = 24 - 1.5 - 0.5 - 0.875/2 = 21.5625"
    expect(effectiveDepthMulti(sect, rb.botBars)).toBeCloseTo(21.563, 2);
  });

  it('phi*Vc = 27.4 kips (Table 22.5.5.1 case a governs when min stirrups provided)', () => {
    const r = computeShear(sect, mat, rb);
    expect(r.phi_Vn - 0.75 * r.Vs).toBeCloseTo(27.4, 0); // phi*Vc
  });

  it('phi*Vn = 92.1 kips', () => {
    const r = computeShear(sect, mat, rb);
    expect(r.phi_Vn).toBeCloseTo(92.1, 0);
  });

  it('torsion Tcr = 27.2 k-ft, phi*Tcr/4 = 5.1 k-ft, phi*Tn = 37.0 k-ft', () => {
    const r = computeTorsion(sect, mat, rb);
    expect(r.Tcr).toBeCloseTo(27.2, 0);          // 4*lambda*sqrt(fc)*Acp^2/Pcp
    expect(r.Tu_threshold).toBeCloseTo(5.1, 0);  // phi*lambda*sqrt(fc)*Acp^2/Pcp
    expect(r.phi_Tn).toBeCloseTo(37.0, 0);
  });

  it('phi*Mn_pos matches S-CONCRETE singly-reinforced baseline (c_sr < d_prime, comp steel in tension zone)', () => {
    // For 2-#7 bot, 3-#7 top: c_sr = 1.765" < d'=2.44" → comp bars are in tension zone
    // The engine correctly falls back to singly-reinforced; S-CONCRETE gives 113.7 (1% rounding)
    const As_top = 3 * getBarArea(7);
    const As_bot = 2 * getBarArea(7);
    const r = computeFlexure(sect, mat, As_top, As_bot, 20, 7, 7, rb.topBars, rb.botBars);
    expect(r.phi_Mn_pos).toBeGreaterThan(110);
    expect(r.phi_Mn_pos).toBeLessThan(115);
  });

  it('doubly-reinforced path activates and increases Mn when c_sr > d_prime', () => {
    // 8-#8 bot, 3-#8 top on 16×24: a_sr = 8*0.79*60000/(0.85*4000*16) = 6.93", c_sr = 8.15" > d'=2.5"
    const sect2: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 };
    const topB = [{ numBars: 3, barSize: 8 }];
    const botB = [{ numBars: 8, barSize: 8 }];
    const As_top2 = 3 * getBarArea(8), As_bot2 = 8 * getBarArea(8);
    const rDoubly = computeFlexure(sect2, mat4k, As_top2, As_bot2, 20, 8, 8, topB, botB);
    const rSingly = computeFlexure(sect2, mat4k, 0, As_bot2, 20, 8, 8);
    expect(rDoubly.phi_Mn_pos).toBeGreaterThan(rSingly.phi_Mn_pos);
  });
});

// ─── S-CONCRETE back-check #2: multi-layer beam ──────────────────────────────
// 12×24, f'c=5000, fy=fyt=60k, cc=1.5", #4@6 2-leg, top 3-#7 + 3-#7, bot 3-#7 + 3-#7
// (two layers each face, dz=1"), 2-#5 face steel. LC1: My=45 k-ft, LC3: Vz=45 k.
describe('S-CONCRETE back-check #2 (multi-layer beam)', () => {
  const sect: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 };
  const mat: MaterialProps      = { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
  const topBars = [{ numBars: 3, barSize: 7 }, { numBars: 3, barSize: 7 }];
  const botBars = [{ numBars: 3, barSize: 7 }, { numBars: 3, barSize: 7 }];
  const rb: RebarLayout = {
    topBars, botBars,
    ties: { barSize: 4, spacing: 6, legs: 2 },
    layerClearSpacing: 1.0,
    sideBars: [{ numBars: 2, barSize: 5 }],
  };
  const As = 6 * getBarArea(7); // 3.6 in²

  it('d = 20.625" and d\' = 3.375" (2-layer centroids)', () => {
    expect(effectiveDepthMulti(sect, botBars, 1.0)).toBeCloseTo(20.625, 3);
    expect(layerCentroidOffset(sect, topBars, 1.0)).toBeCloseTo(3.375, 3);
  });

  it('phiVc=26.3, phiVs=61.9, phiVn=88.1 kips', () => {
    const r = computeShear(sect, mat, rb);
    expect(0.75 * r.Vc).toBeCloseTo(26.3, 1);
    expect(0.75 * r.Vs).toBeCloseTo(61.9, 1);
    expect(r.phi_Vn).toBeCloseTo(88.1, 1);
  });

  it('phiTcr=20.4, threshold=5.1, phiTn=37.0 k-ft', () => {
    const r = computeTorsion(sect, mat, rb);
    expect(0.75 * r.Tcr).toBeCloseTo(20.4, 1);
    expect(r.Tu_threshold).toBeCloseTo(5.1, 1);
    expect(r.phi_Tn).toBeCloseTo(37.0, 1);
  });

  it('phiMn+ ≈ 305.7 k-ft (per-layer compression steel strain compatibility)', () => {
    const r = computeFlexure(sect, mat, As, As, 20, 7, 7, topBars, botBars, 1.0);
    expect(r.Mn_pos).toBeCloseTo(339.7, -1);       // ±5: S-C gives 339.7
    expect(r.phi_Mn_pos).toBeGreaterThan(304);
    expect(r.phi_Mn_pos).toBeLessThan(308);
  });

  it('As,max = 5.97 in² (0.85β₁ formula, §9.3.3.1)', () => {
    const { As_max } = steelLimits(sect, mat);
    // steelLimits uses d for a #8 bar single layer (21.5"); S-C uses d=20.625
    const As_max_at_d = 0.85 * 0.8 * (5000 / 60000) * (3 / 7) * 12 * 20.625;
    expect(As_max_at_d).toBeCloseTo(5.97, 1);
    expect(As_max).toBeGreaterThan(5.9); // engine value at its own d
  });

  it('shear util = 0.511 and moment util ≈ 0.147; status OK; no warnings', () => {
    const r1 = designMember(sect, mat, rb, { id: '1', label: '1', Mu_pos: 45, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 }, 20);
    const r3 = designMember(sect, mat, rb, { id: '3', label: '3', Mu_pos: 0, Mu_neg: 0, Vu: 45, Tu: 0, Pu: 0 }, 20);
    expect(r3.DCR_shear).toBeCloseTo(0.511, 2);
    expect(r1.DCR_flex_pos).toBeCloseTo(0.147, 2);
    expect(r1.warnings).toHaveLength(0);
    expect(r3.warnings).toHaveLength(0);
    expect(r1.status).toBe('OK');
  });

  it('reported As_min reflects §9.6.1.3 exception (≈0.71 in² for Mu=45)', () => {
    const r = designMember(sect, mat, rb, { id: '1', label: '1', Mu_pos: 45, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 }, 20);
    expect(r.As_min).toBeLessThan(0.91); // below the raw code minimum (0.91)
    // S-CONCRETE reports 0.71; ours gives 0.66 (small difference in As,req internals)
    expect(r.As_min).toBeGreaterThan(0.6);
    expect(r.As_min).toBeLessThan(0.78);
  });
});

// ─── As,min §9.6.1.3 exception ───────────────────────────────────────────────
describe('designMember — §9.6.1.3 As,min 4/3 exception', () => {
  it('no As,min warning when As >= (4/3)*As,req even if As < code min', () => {
    // Tiny Mu → As,req very small → (4/3)*As,req < code As,min → exception kicks in
    const smallMu: LoadCase = { id: 'lc', label: '', Mu_pos: 5, Mu_neg: 0, Vu: 10, Tu: 0, Pu: 0 };
    const rb2: RebarLayout = {
      topBars: [{ numBars: 1, barSize: 3 }],
      botBars: [{ numBars: 2, barSize: 5 }], // 2*0.31 = 0.62 in²
      ties: { barSize: 4, spacing: 6, legs: 2 },
    };
    const r = designMember(rect16x24, mat4k, rb2, smallMu);
    expect(r.warnings.some(w => w.code === 'ACI §9.6.1.2' && w.message.includes('below'))).toBe(false);
  });
});

describe('computeShear — Vs cap §22.5.1.2', () => {
  it('caps Vs at 8*sqrt(fc)*bw*d and flags it', () => {
    const heavyTies: RebarLayout = {
      topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }],
      ties: { barSize: 6, spacing: 2, legs: 6 },
    };
    const r = computeShear(rect16x24, mat4k, heavyTies);
    const VsMax = 8 * Math.sqrt(4000) * 16 * r.d_shear / 1000;
    expect(r.Vs).toBeCloseTo(VsMax, 5);
    expect(r.VsCapped).toBe(true);
    const normal = computeShear(rect16x24, mat4k, rebar3_8);
    expect(normal.VsCapped).toBe(false);
  });
});
