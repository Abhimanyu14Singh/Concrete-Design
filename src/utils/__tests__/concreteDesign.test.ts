/**
 * Unit tests for ACI 318-19 concrete design engine — beams only.
 */
import { describe, it, expect } from 'vitest';
import {
  getBarArea,
  getBarDiam,
  beta1,
  effectiveDepth,
  effectiveFlange,
  steelLimits,
  computeFlexure,
  computeShear,
  computeTorsion,
  requiredAs,
  designMember,
} from '../concreteDesign';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../../types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mat4k: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat5k: MaterialProps = { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat6k: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };

const rectBeam: SectionDimensions    = { type: 'rectangular_beam', b: 12, h: 21, coverClear: 1.5, stirrupDia: 4 };
const beam16x24: SectionDimensions   = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 };
const tBeam: SectionDimensions       = { type: 'T_beam', b: 48, bw: 14, h: 24, hf: 5, coverClear: 1.5, stirrupDia: 4 };

const rebar3_8: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
};

// ─── Bar lookups ─────────────────────────────────────────────────────────────

describe('Bar property tables', () => {
  it('returns correct areas', () => {
    expect(getBarArea(3)).toBeCloseTo(0.11, 2);
    expect(getBarArea(4)).toBeCloseTo(0.20, 2);
    expect(getBarArea(8)).toBeCloseTo(0.79, 2);
    expect(getBarArea(11)).toBeCloseTo(1.56, 2);
  });
  it('returns correct diameters', () => {
    expect(getBarDiam(4)).toBeCloseTo(0.500, 3);
    expect(getBarDiam(8)).toBeCloseTo(1.000, 3);
    expect(getBarDiam(9)).toBeCloseTo(1.128, 3);
  });
  it('returns 0 for unknown size', () => {
    expect(getBarArea(99)).toBe(0);
    expect(getBarDiam(99)).toBe(0);
  });
});

// ─── beta1 ───────────────────────────────────────────────────────────────────

describe('beta1', () => {
  it('= 0.85 for fc ≤ 4000', () => {
    expect(beta1(3000)).toBe(0.85);
    expect(beta1(4000)).toBe(0.85);
  });
  it('decreases above 4000, min 0.65', () => {
    expect(beta1(5000)).toBeCloseTo(0.80, 3);
    expect(beta1(6000)).toBeCloseTo(0.75, 3);
    expect(beta1(9000)).toBe(0.65);
  });
});

// ─── effectiveDepth ───────────────────────────────────────────────────────────

describe('effectiveDepth — uses actual bar diameters', () => {
  it('h=24, cc=1.5, #4 stirrup (0.5"), #8 bar (1.0") → d = 24-1.5-0.5-0.5 = 21.5"', () => {
    expect(effectiveDepth(beam16x24, 8)).toBeCloseTo(21.5, 2);
  });
  it('larger bar → smaller d', () => {
    expect(effectiveDepth(beam16x24, 8)).toBeGreaterThan(effectiveDepth(beam16x24, 11));
  });
  it('d < h always', () => {
    expect(effectiveDepth(beam16x24, 8)).toBeLessThan(24);
  });
});

// ─── effectiveFlange ──────────────────────────────────────────────────────────

describe('effectiveFlange', () => {
  it('returns b for rectangular beam', () => {
    expect(effectiveFlange(beam16x24, 20)).toBe(16);
  });
  it('T-beam beff ≤ b and ≥ bw', () => {
    const beff = effectiveFlange(tBeam, 20);
    expect(beff).toBeLessThanOrEqual(tBeam.b);
    expect(beff).toBeGreaterThanOrEqual(tBeam.bw ?? tBeam.b);
  });
});

// ─── steelLimits ──────────────────────────────────────────────────────────────

describe('steelLimits', () => {
  const d = effectiveDepth(beam16x24, 8);
  it('As_min > 0', () => {
    expect(steelLimits(beam16x24, mat4k, d).As_min).toBeGreaterThan(0);
  });
  it('As_max > As_min', () => {
    const { As_min, As_max } = steelLimits(beam16x24, mat4k, d);
    expect(As_max).toBeGreaterThan(As_min);
  });
  it('As_max uses 0.85 coefficient (ACI §9.3.3.1)', () => {
    // As_max = 0.85*β₁*(fc/fy)*(3/7)*bw*d
    const { As_max } = steelLimits(beam16x24, mat4k, d);
    const expected = 0.85 * beta1(4000) * (4000 / 60000) * (3 / 7) * 16 * d;
    expect(As_max).toBeCloseTo(expected, 2);
  });
});

// ─── Flexure ─────────────────────────────────────────────────────────────────

describe('computeFlexure — rectangular beam', () => {
  it('phi_Mn_pos > 0 with bottom steel', () => {
    expect(computeFlexure(beam16x24, mat4k, rebar3_8).phi_Mn_pos).toBeGreaterThan(0);
  });
  it('phi_Mn_pos > phi_Mn_neg with more bottom steel (4 vs 3)', () => {
    expect(computeFlexure(beam16x24, mat4k, rebar3_8).phi_Mn_pos).toBeGreaterThan(
      computeFlexure(beam16x24, mat4k, rebar3_8).phi_Mn_neg
    );
  });
  it('zero steel → zero capacity', () => {
    const noRebar: RebarLayout = { topBars: [{ numBars: 0, barSize: 8 }], botBars: [{ numBars: 0, barSize: 8 }] };
    const r = computeFlexure(beam16x24, mat4k, noRebar);
    expect(r.phi_Mn_pos).toBe(0);
    expect(r.phi_Mn_neg).toBe(0);
  });
  it('more steel → higher capacity', () => {
    const r3 = computeFlexure(beam16x24, mat4k, { ...rebar3_8, botBars: [{ numBars: 3, barSize: 8 }] });
    const r6 = computeFlexure(beam16x24, mat4k, { ...rebar3_8, botBars: [{ numBars: 6, barSize: 8 }] });
    expect(r6.phi_Mn_pos).toBeGreaterThan(r3.phi_Mn_pos);
  });
  it('phi = 0.9 for lightly reinforced section', () => {
    const light: RebarLayout = { topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 2, barSize: 5 }] };
    expect(computeFlexure(beam16x24, mat4k, light).phi_pos).toBeCloseTo(0.9, 2);
  });
});

describe('computeFlexure — T-beam', () => {
  const tRebar: RebarLayout = {
    topBars: [{ numBars: 3, barSize: 9 }],
    botBars: [{ numBars: 5, barSize: 9 }],
    ties: { barSize: 4, spacing: 5, legs: 2 },
  };
  it('positive capacity > equivalent rectangular web section', () => {
    const tResult = computeFlexure(tBeam, mat4k, tRebar);
    const rRect: SectionDimensions = { ...tBeam, type: 'rectangular_beam', b: 14 };
    const rResult = computeFlexure(rRect, mat4k, tRebar);
    expect(tResult.phi_Mn_pos).toBeGreaterThan(rResult.phi_Mn_pos);
  });
  it('isT_behavior_pos true for short span (stress block > hf)', () => {
    const r = computeFlexure(tBeam, mat4k, tRebar, 5);
    expect(r.isT_behavior_pos).toBe(true);
  });
  it('negative moment uses web width only', () => {
    const tResult = computeFlexure(tBeam, mat4k, tRebar);
    const webRect: SectionDimensions = { ...tBeam, type: 'rectangular_beam', b: 14 };
    const rResult = computeFlexure(webRect, mat4k, tRebar);
    expect(tResult.phi_Mn_neg).toBeCloseTo(rResult.phi_Mn_neg, 1);
  });
});

// ─── Shear ────────────────────────────────────────────────────────────────────

describe('computeShear', () => {
  it('Vc > 0', () => {
    expect(computeShear(beam16x24, mat4k, rebar3_8).Vc).toBeGreaterThan(0);
  });
  it('lambda_s = 1.0 when stirrups meet Av_min (size effect waived)', () => {
    const r = computeShear(beam16x24, mat4k, rebar3_8);
    expect(r.has_min_stirrups).toBe(true);
    expect(r.lambda_s).toBe(1.0);
  });
  it('lambda_s < 1.0 for beam without adequate stirrups (d > 10")', () => {
    const noTies: RebarLayout = { topBars: rebar3_8.topBars, botBars: rebar3_8.botBars };
    const r = computeShear(beam16x24, mat4k, noTies);
    expect(r.lambda_s).toBeLessThan(1.0);
  });
  it('phi_Vn = 0.75*(Vc+Vs)', () => {
    const r = computeShear(beam16x24, mat4k, rebar3_8);
    expect(r.phi_Vn).toBeCloseTo(0.75 * (r.Vc + r.Vs), 3);
  });
  it('closer spacing → higher Vs', () => {
    const close = computeShear(beam16x24, mat4k, { ...rebar3_8, ties: { barSize: 4, spacing: 4, legs: 2 } });
    const far   = computeShear(beam16x24, mat4k, { ...rebar3_8, ties: { barSize: 4, spacing: 12, legs: 2 } });
    expect(close.Vs).toBeGreaterThan(far.Vs);
  });
  it('lightweight concrete reduces Vc', () => {
    const nw = computeShear(beam16x24, mat4k, rebar3_8);
    const lw = computeShear(beam16x24, { ...mat4k, lambdaConcrete: 0.75 }, rebar3_8);
    expect(lw.Vc).toBeLessThan(nw.Vc);
  });
  it('d_shear applies 0.8h lower bound', () => {
    // For beam16x24: d_raw = 21.5", 0.8h = 19.2" → d_shear = 21.5 (raw > lower bound)
    const r = computeShear(beam16x24, mat4k, rebar3_8);
    expect(r.d_shear).toBeCloseTo(21.5, 1);
    // Extreme cover case: h=24, cc=10 → d_raw = 24-10-0.5-0.5=13; 0.8*24=19.2 → d_shear=19.2
    const deepCover: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 10, stirrupDia: 4 };
    const r2 = computeShear(deepCover, mat4k, rebar3_8);
    expect(r2.d_shear).toBeCloseTo(19.2, 1);
  });
  it('Av_min_per_s formula correct for 16" beam at fc=4000', () => {
    // Av_min/s = max(0.75√4000, 50) * 16 / 60000 = max(47.4, 50)*16/60000 = 0.01333 in²/in
    const r = computeShear(beam16x24, mat4k, rebar3_8);
    expect(r.Av_min_per_s).toBeCloseTo(0.01333, 3);
  });
});

// ─── Torsion ──────────────────────────────────────────────────────────────────

describe('computeTorsion', () => {
  it('Tcr > 0', () => {
    expect(computeTorsion(beam16x24, mat4k, rebar3_8).Tcr).toBeGreaterThan(0);
  });
  it('Tu_threshold = Tcr / 4', () => {
    const r = computeTorsion(beam16x24, mat4k, rebar3_8);
    expect(r.Tu_threshold).toBeCloseTo(r.Tcr / 4, 4);
  });
  it('phi_Tn proportional to At/s (halving spacing doubles phi_Tn)', () => {
    const r1 = computeTorsion(beam16x24, mat4k, rebar3_8); // spacing=6
    const r2 = computeTorsion(beam16x24, mat4k, { ...rebar3_8, ties: { barSize: 4, spacing: 3, legs: 2 } });
    expect(r2.phi_Tn).toBeCloseTo(r1.phi_Tn * 2, 0);
  });
  it('larger section → higher Tcr', () => {
    const small = computeTorsion({ ...rectBeam, b: 10, h: 14 }, mat4k, rebar3_8);
    const large = computeTorsion(beam16x24, mat4k, rebar3_8);
    expect(large.Tcr).toBeGreaterThan(small.Tcr);
  });
  it('returns Aoh and Ph > 0', () => {
    const r = computeTorsion(beam16x24, mat4k, rebar3_8);
    expect(r.Aoh).toBeGreaterThan(0);
    expect(r.Ph).toBeGreaterThan(0);
  });
});

// ─── requiredAs ───────────────────────────────────────────────────────────────

describe('requiredAs', () => {
  it('returns 0 for Mu=0', () => {
    expect(requiredAs(0, beam16x24, mat4k, false, 20)).toBe(0);
  });
  it('positive for Mu > 0', () => {
    expect(requiredAs(100, beam16x24, mat4k, false, 20)).toBeGreaterThan(0);
  });
  it('larger Mu → more steel', () => {
    expect(requiredAs(200, beam16x24, mat4k, false, 20)).toBeGreaterThan(
      requiredAs(50, beam16x24, mat4k, false, 20)
    );
  });
  it('higher fc → slightly less steel', () => {
    expect(requiredAs(150, beam16x24, mat6k, false, 20)).toBeLessThanOrEqual(
      requiredAs(150, beam16x24, mat4k, false, 20)
    );
  });
});

// ─── designMember ─────────────────────────────────────────────────────────────

describe('designMember', () => {
  const load: LoadCase = { id: 'lc1', label: 'LC1', Mu_pos: 140, Mu_neg: 90, Vu: 55, Tu: 6, Pu: 0 };

  it('returns valid status', () => {
    expect(['OK', 'Warning', 'NG']).toContain(designMember(beam16x24, mat4k, rebar3_8, load).status);
  });
  it('all DCRs non-negative', () => {
    const r = designMember(beam16x24, mat4k, rebar3_8, load);
    expect(r.DCR_flex_pos).toBeGreaterThanOrEqual(0);
    expect(r.DCR_flex_neg).toBeGreaterThanOrEqual(0);
    expect(r.DCR_shear).toBeGreaterThanOrEqual(0);
    expect(r.DCR_torsion).toBeGreaterThanOrEqual(0);
  });
  it('status = NG when loads vastly exceed capacity', () => {
    const big = { ...load, Mu_pos: 9999, Mu_neg: 9999, Vu: 9999 };
    expect(designMember(beam16x24, mat4k, rebar3_8, big).status).toBe('NG');
  });
  it('status = OK for light loads', () => {
    const small = { ...load, Mu_pos: 10, Mu_neg: 5, Vu: 5, Tu: 0 };
    expect(designMember(beam16x24, mat4k, rebar3_8, small).status).toBe('OK');
  });
  it('phi_Vn = 0.75*(Vc+Vs)', () => {
    const r = designMember(beam16x24, mat4k, rebar3_8, load);
    expect(r.phi_Vn).toBeCloseTo(0.75 * (r.Vc + r.Vs), 2);
  });
  it('As_max > As_min', () => {
    const r = designMember(beam16x24, mat4k, rebar3_8, load);
    expect(r.As_max).toBeGreaterThan(r.As_min);
  });
  it('Av_req = 0 when Vu << phi*Vc', () => {
    const tiny = { ...load, Vu: 0.1 };
    expect(designMember(beam16x24, mat4k, rebar3_8, tiny).Av_req).toBe(0);
  });
  it('no throw for T-beam', () => {
    const tRebar: RebarLayout = {
      topBars: [{ numBars: 3, barSize: 9 }],
      botBars: [{ numBars: 5, barSize: 9 }],
      ties: { barSize: 4, spacing: 5, legs: 2 },
    };
    expect(() => designMember(tBeam, mat5k, tRebar, load, 30)).not.toThrow();
  });
});

// ─── ACI beam calc fixes ──────────────────────────────────────────────────────

describe('ACI 318-19 beam calc fixes', () => {
  it('min shear trigger: no warning when Vu is very small', () => {
    const lightLoad: LoadCase = { id: 'lc', label: 'lc', Mu_pos: 0, Mu_neg: 0, Vu: 0.5, Tu: 0, Pu: 0 };
    const noTies: RebarLayout = { topBars: rebar3_8.topBars, botBars: rebar3_8.botBars };
    const r = designMember(beam16x24, mat4k, noTies, lightLoad);
    expect(r.warnings.some(w => w.code === 'ACI §9.6.3.1')).toBe(false);
  });

  it('two-tier spacing: d/2 warning fires when s > d/2 (normal shear zone)', () => {
    const wideStir: RebarLayout = { ...rebar3_8, ties: { barSize: 4, spacing: 20, legs: 2 } };
    // d ≈ 21.5, d/2 ≈ 10.75 < 20
    const load: LoadCase = { id: 'lc', label: 'lc', Mu_pos: 50, Mu_neg: 30, Vu: 30, Tu: 0, Pu: 0 };
    const r = designMember(beam16x24, mat4k, wideStir, load);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.6.2.2')).toBe(true);
  });

  it('two-tier spacing: d/4 warning fires under heavy shear', () => {
    const stir8: RebarLayout = { ...rebar3_8, ties: { barSize: 4, spacing: 8, legs: 2 } };
    // Massive Vu to trigger heavy shear zone; d/4 ≈ 5.4 < 8
    const load: LoadCase = { id: 'lc', label: 'lc', Mu_pos: 100, Mu_neg: 50, Vu: 500, Tu: 0, Pu: 0 };
    const r = designMember(beam16x24, mat4k, stir8, load);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.6.2.2' && w.message.includes('Heavy shear'))).toBe(true);
  });

  it('face steel warning fires for h > 36"', () => {
    const tallBeam: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 42, coverClear: 1.5, stirrupDia: 4 };
    const load: LoadCase = { id: 'lc', label: 'lc', Mu_pos: 200, Mu_neg: 100, Vu: 60, Tu: 0, Pu: 0 };
    const r = designMember(tallBeam, mat4k, rebar3_8, load);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.2.3')).toBe(true);
  });

  it('face steel warning does NOT fire for h ≤ 36"', () => {
    const load: LoadCase = { id: 'lc', label: 'lc', Mu_pos: 100, Mu_neg: 50, Vu: 40, Tu: 0, Pu: 0 };
    const r = designMember(beam16x24, mat4k, rebar3_8, load);
    expect(r.warnings.some(w => w.code === 'ACI §9.7.2.3')).toBe(false);
  });

  it('no throw for various fc values', () => {
    const load: LoadCase = { id: 'x', label: 'x', Mu_pos: 80, Mu_neg: 40, Vu: 30, Tu: 2, Pu: 0 };
    [3000, 4000, 5000, 6000, 8000].forEach(fc => {
      expect(() => designMember(beam16x24, { ...mat4k, fc }, rebar3_8, load)).not.toThrow();
    });
  });
});
