/**
 * Unit tests for ACI 318-19 concrete design engine.
 *
 * Key bugs fixed in this version that tests verify:
 *  1. effectiveDepth uses actual bar diameters (not bar size numbers)
 *  2. T-beam Mn uses correct stress-block split (overhang + web)
 *  3. Shear λs = 1.0 when stirrups ≥ Av,min
 *  4. Torsion φTn uses actual stirrup At/s
 *  5. Interaction diagram d' uses getBarDiam()
 */
import { describe, it, expect } from 'vitest';
import {
  getBarArea, getBarDiam,
  effectiveDepth, beta1, effectiveFlange,
  computeFlexure, computeShear, computeTorsion,
  requiredAs, designMember, computeInteractionDiagram,
  steelLimits,
} from '../concreteDesign';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mat4k: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat5k: MaterialProps = { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat6k: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };

const rectBeam: SectionDimensions   = { type: 'rectangular_beam', b: 12, h: 21, coverClear: 1.5, stirrupDia: 4 };
const beam16x24: SectionDimensions  = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 };
const tBeam: SectionDimensions      = { type: 'T_beam', b: 48, bw: 14, h: 24, hf: 5, coverClear: 1.5, stirrupDia: 4 };
const circCol: SectionDimensions    = { type: 'circular_column', b: 20, h: 20, diameter: 20, coverClear: 1.5, stirrupDia: 4 };
const rectCol: SectionDimensions    = { type: 'rectangular_column', b: 18, h: 18, coverClear: 1.5, stirrupDia: 4 };

const rebar3_8: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
};
const colRebar: RebarLayout = {
  topBars: [{ numBars: 4, barSize: 9 }],
  botBars: [{ numBars: 4, barSize: 9 }],
  ties: { barSize: 4, spacing: 9, legs: 4 },
};

// ── Bar properties ────────────────────────────────────────────────────────────

describe('Bar property tables', () => {
  it('returns correct areas for standard sizes', () => {
    expect(getBarArea(3)).toBeCloseTo(0.11, 2);
    expect(getBarArea(4)).toBeCloseTo(0.20, 2);
    expect(getBarArea(8)).toBeCloseTo(0.79, 2);
    expect(getBarArea(11)).toBeCloseTo(1.56, 2);
  });
  it('returns correct diameters per ASTM', () => {
    expect(getBarDiam(4)).toBeCloseTo(0.500, 3);
    expect(getBarDiam(8)).toBeCloseTo(1.000, 3);
    expect(getBarDiam(9)).toBeCloseTo(1.128, 3);
    expect(getBarDiam(11)).toBeCloseTo(1.410, 3);
  });
  it('returns 0 for unknown size', () => {
    expect(getBarArea(99)).toBe(0);
    expect(getBarDiam(99)).toBe(0);
  });
});

// ── effectiveDepth (bug-fix verification) ────────────────────────────────────

describe('effectiveDepth — uses actual bar diameters, not size numbers', () => {
  it('for #4 stirrups (#4 has diam=0.5"), uses 0.5" not 2"', () => {
    // h=24, cc=1.5, d_stir=0.5, d_bar(#8)=1.0 → d = 24-1.5-0.5-0.5 = 21.5
    const d = effectiveDepth(beam16x24, 8);
    expect(d).toBeCloseTo(21.5, 2);
  });
  it('larger bar gives smaller d', () => {
    const d8  = effectiveDepth(beam16x24, 8);   // d_bar = 1.0"
    const d11 = effectiveDepth(beam16x24, 11);  // d_bar = 1.41"
    expect(d8).toBeGreaterThan(d11);
  });
  it('d must be less than h', () => {
    expect(effectiveDepth(beam16x24, 8)).toBeLessThan(24);
    expect(effectiveDepth(tBeam, 9)).toBeLessThan(24);
  });
});

// ── beta1 ─────────────────────────────────────────────────────────────────────

describe('beta1', () => {
  it('= 0.85 for fc ≤ 4000 psi', () => {
    expect(beta1(3000)).toBe(0.85);
    expect(beta1(4000)).toBe(0.85);
  });
  it('decreases above 4000, min 0.65', () => {
    expect(beta1(5000)).toBeCloseTo(0.80, 3);
    expect(beta1(6000)).toBeCloseTo(0.75, 3);
    expect(beta1(9000)).toBe(0.65);
    expect(beta1(12000)).toBe(0.65);
  });
});

// ── effectiveFlange ───────────────────────────────────────────────────────────

describe('effectiveFlange', () => {
  it('returns b for rectangular section', () => {
    expect(effectiveFlange(beam16x24, 20)).toBe(16);
  });
  it('T-beam: returns bw + 16hf or span/4 or b, whichever is smallest', () => {
    // bw=14, hf=5, b=48, span=20ft
    // bw+16hf = 14+80=94  → clipped to min(94, 240/4=60, 48) = 48
    expect(effectiveFlange(tBeam, 20)).toBe(48);
  });
  it('T-beam beff ≤ actual flange width b', () => {
    expect(effectiveFlange(tBeam, 10)).toBeLessThanOrEqual(tBeam.b);
  });
  it('T-beam beff ≥ bw', () => {
    expect(effectiveFlange(tBeam, 10)).toBeGreaterThanOrEqual(tBeam.bw ?? tBeam.b);
  });
});

// ── Flexure ───────────────────────────────────────────────────────────────────

describe('computeFlexure — rectangular beam', () => {
  it('phi_Mn_pos > 0 with bottom steel', () => {
    const r = computeFlexure(beam16x24, mat4k, rebar3_8);
    expect(r.phi_Mn_pos).toBeGreaterThan(0);
  });
  it('phi_Mn_pos > phi_Mn_neg with more bottom steel', () => {
    // rebar3_8: 4 bot vs 3 top
    const r = computeFlexure(beam16x24, mat4k, rebar3_8);
    expect(r.phi_Mn_pos).toBeGreaterThan(r.phi_Mn_neg);
  });
  it('zero steel → zero capacity', () => {
    const noRebar: RebarLayout = { topBars: [{ numBars: 0, barSize: 8 }], botBars: [{ numBars: 0, barSize: 8 }] };
    const r = computeFlexure(beam16x24, mat4k, noRebar);
    expect(r.phi_Mn_pos).toBe(0);
    expect(r.phi_Mn_neg).toBe(0);
  });
  it('phi = 0.9 for tension-controlled section (light steel ratio)', () => {
    const lightRebar: RebarLayout = { topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 2, barSize: 5 }] };
    const r = computeFlexure(beam16x24, mat4k, lightRebar);
    expect(r.phi_pos).toBeCloseTo(0.9, 2);
  });
  it('more bottom steel → higher positive moment capacity', () => {
    const r3 = computeFlexure(beam16x24, mat4k, { ...rebar3_8, botBars: [{ numBars: 3, barSize: 8 }] });
    const r5 = computeFlexure(beam16x24, mat4k, { ...rebar3_8, botBars: [{ numBars: 5, barSize: 8 }] });
    expect(r5.phi_Mn_pos).toBeGreaterThan(r3.phi_Mn_pos);
  });
  it('higher fc: same steel, slightly higher capacity (larger moment arm)', () => {
    const r4k = computeFlexure(beam16x24, mat4k, rebar3_8);
    const r6k = computeFlexure(beam16x24, mat6k, rebar3_8);
    expect(r6k.phi_Mn_pos).toBeGreaterThanOrEqual(r4k.phi_Mn_pos * 0.99);
  });
});

describe('computeFlexure — T-beam (correct stress-block split)', () => {
  const tRebar: RebarLayout = {
    topBars: [{ numBars: 3, barSize: 9 }],
    botBars: [{ numBars: 5, barSize: 9 }],
    ties: { barSize: 4, spacing: 5, legs: 2 },
  };

  it('positive capacity exceeds equivalent rectangular (web-width) section', () => {
    const tResult = computeFlexure(tBeam, mat4k, tRebar);
    const rRect: SectionDimensions = { ...tBeam, type: 'rectangular_beam', b: 14 };
    const rResult = computeFlexure(rRect, mat4k, tRebar);
    expect(tResult.phi_Mn_pos).toBeGreaterThan(rResult.phi_Mn_pos);
  });

  it('stress block extends into web when beff is narrow enough (short span)', () => {
    // span=5ft → beff = min(14+16×5=94, 60/4=15, 48) = 15"
    // a_rect = 5×1.0×60000 / (0.85×4000×15) = 300000/51000 = 5.88" > hf=5" → T-behavior
    const r = computeFlexure(tBeam, mat4k, tRebar, 5);
    expect(r.isT_behavior_pos).toBe(true);
    expect(r.a_pos).toBeGreaterThan(tBeam.hf ?? 0);
  });

  it('negative moment uses web width (bw) only', () => {
    // Negative Mn should equal rectangular-web calc
    const tResult = computeFlexure(tBeam, mat4k, tRebar);
    const webRect: SectionDimensions = { ...tBeam, type: 'rectangular_beam', b: 14 };
    const rResult = computeFlexure(webRect, mat4k, tRebar);
    expect(tResult.phi_Mn_neg).toBeCloseTo(rResult.phi_Mn_neg, 1);
  });

  it('T-beam Mn_pos is finite and positive', () => {
    const r = computeFlexure(tBeam, mat4k, tRebar, 30);
    expect(r.Mn_pos).toBeGreaterThan(0);
    expect(isFinite(r.Mn_pos)).toBe(true);
  });
});

// ── Shear ─────────────────────────────────────────────────────────────────────

describe('computeShear', () => {
  it('Vc > 0 for standard beam', () => {
    expect(computeShear(beam16x24, mat4k, rebar3_8).Vc).toBeGreaterThan(0);
  });

  it('lambda_s = 1.0 when stirrups meet Av_min (size effect waived)', () => {
    // rebar3_8 has #4@6" with 2 legs: Av/s = 2×0.20/6 = 0.0667
    const r = computeShear(beam16x24, mat4k, rebar3_8);
    expect(r.has_min_stirrups).toBe(true);
    expect(r.lambda_s).toBe(1.0);
  });

  it('lambda_s < 1.0 for beam without adequate stirrups (d > 10")', () => {
    // beam16x24: d ≈ 21.5" → λs = √(2/(1+21.5/10)) = √(2/3.15) = 0.797 < 1.0
    const noStirRebar: RebarLayout = { topBars: rebar3_8.topBars, botBars: rebar3_8.botBars }; // no ties
    const r = computeShear(beam16x24, mat4k, noStirRebar);
    expect(r.has_min_stirrups).toBe(false);
    expect(r.lambda_s).toBeLessThan(1.0);
    expect(r.lambda_s).toBeCloseTo(Math.sqrt(2 / (1 + 21.5 / 10)), 2);
  });

  it('phi_Vn = 0.75*(Vc+Vs)', () => {
    const r = computeShear(beam16x24, mat4k, rebar3_8);
    expect(r.phi_Vn).toBeCloseTo(0.75 * (r.Vc + r.Vs), 3);
  });

  it('closer stirrup spacing → higher Vs', () => {
    const close = { ...rebar3_8, ties: { barSize: 4, spacing: 4,  legs: 2 } };
    const far   = { ...rebar3_8, ties: { barSize: 4, spacing: 12, legs: 2 } };
    expect(computeShear(beam16x24, mat4k, close).Vs).toBeGreaterThan(
      computeShear(beam16x24, mat4k, far).Vs
    );
  });

  it('lightweight concrete reduces Vc', () => {
    const normal = computeShear(beam16x24, mat4k, rebar3_8);
    const lw     = computeShear(beam16x24, { ...mat4k, lambdaConcrete: 0.75 }, rebar3_8);
    expect(lw.Vc).toBeLessThan(normal.Vc);
  });

  it('higher rho_w → higher Vc (ACI size-effect equation)', () => {
    const rHeavy = { ...rebar3_8, botBars: [{ numBars: 6, barSize: 9 }] };
    const rLight = { ...rebar3_8, botBars: [{ numBars: 2, barSize: 5 }] };
    expect(computeShear(beam16x24, mat4k, rHeavy).Vc).toBeGreaterThan(
      computeShear(beam16x24, mat4k, rLight).Vc
    );
  });
});

// ── Torsion ───────────────────────────────────────────────────────────────────

describe('computeTorsion', () => {
  it('Tcr > 0', () => {
    expect(computeTorsion(beam16x24, mat4k, rebar3_8).Tcr).toBeGreaterThan(0);
  });
  it('Tu_threshold = Tcr / 4', () => {
    const r = computeTorsion(beam16x24, mat4k, rebar3_8);
    expect(r.Tu_threshold).toBeCloseTo(r.Tcr / 4, 4);
  });
  it('phi_Tn uses actual stirrup At/s (not a placeholder)', () => {
    const r1 = computeTorsion(beam16x24, mat4k, rebar3_8);
    const r2 = computeTorsion(beam16x24, mat4k, { ...rebar3_8, ties: { barSize: 4, spacing: 3, legs: 2 } });
    // Halving spacing should double phi_Tn
    expect(r2.phi_Tn).toBeCloseTo(r1.phi_Tn * 2, 0);
  });
  it('larger section → higher Tcr', () => {
    const small = computeTorsion({ ...rectBeam, b: 10, h: 14 }, mat4k, rebar3_8);
    const large = computeTorsion(beam16x24, mat4k, rebar3_8);
    expect(large.Tcr).toBeGreaterThan(small.Tcr);
  });
  it('Aoh > 0', () => {
    expect(computeTorsion(beam16x24, mat4k, rebar3_8).Aoh).toBeGreaterThan(0);
  });
});

// ── Steel limits ──────────────────────────────────────────────────────────────

describe('steelLimits', () => {
  const d = effectiveDepth(beam16x24, 8);
  it('As_min > 0', () => {
    expect(steelLimits(beam16x24, mat4k, d).As_min).toBeGreaterThan(0);
  });
  it('As_max > As_min', () => {
    const { As_min, As_max } = steelLimits(beam16x24, mat4k, d);
    expect(As_max).toBeGreaterThan(As_min);
  });
  it('As_min increases with d', () => {
    const dSmall = effectiveDepth({ ...beam16x24, h: 16 }, 8);
    const dLarge = effectiveDepth({ ...beam16x24, h: 30 }, 8);
    const s1 = steelLimits(beam16x24, mat4k, dSmall);
    const s2 = steelLimits(beam16x24, mat4k, dLarge);
    expect(s2.As_min).toBeGreaterThan(s1.As_min);
  });
});

// ── requiredAs ────────────────────────────────────────────────────────────────

describe('requiredAs', () => {
  it('returns 0 for Mu=0', () => {
    expect(requiredAs(0, beam16x24, mat4k, false, 8)).toBe(0);
  });
  it('positive for Mu > 0', () => {
    expect(requiredAs(100, beam16x24, mat4k, false, 8)).toBeGreaterThan(0);
  });
  it('larger Mu → more steel', () => {
    expect(requiredAs(200, beam16x24, mat4k, false, 8)).toBeGreaterThan(
      requiredAs(50, beam16x24, mat4k, false, 8)
    );
  });
  it('higher fc → slightly less steel (larger moment arm)', () => {
    const lo = requiredAs(150, beam16x24, mat4k, false, 8);
    const hi = requiredAs(150, beam16x24, mat6k, false, 8);
    expect(hi).toBeLessThanOrEqual(lo);
  });
  it('result ≥ As_min', () => {
    const d   = effectiveDepth(beam16x24, 8);
    const { As_min } = steelLimits(beam16x24, mat4k, d);
    expect(requiredAs(5, beam16x24, mat4k, false, 8)).toBeGreaterThanOrEqual(As_min - 1e-9);
  });
});

// ── designMember ─────────────────────────────────────────────────────────────

describe('designMember', () => {
  const load: LoadCase = { id: 'lc1', label: 'LC1', Mu_pos: 140, Mu_neg: 90, Vu: 55, Tu: 6, Pu: 0 };

  it('returns valid status', () => {
    const r = designMember(beam16x24, mat4k, rebar3_8, load);
    expect(['OK', 'Warning', 'NG']).toContain(r.status);
  });

  it('all DCRs are non-negative', () => {
    const r = designMember(beam16x24, mat4k, rebar3_8, load);
    expect(r.DCR_flex_pos).toBeGreaterThanOrEqual(0);
    expect(r.DCR_flex_neg).toBeGreaterThanOrEqual(0);
    expect(r.DCR_shear).toBeGreaterThanOrEqual(0);
    expect(r.DCR_torsion).toBeGreaterThanOrEqual(0);
  });

  it('status = NG when loads vastly exceed capacity', () => {
    const big = { ...load, Mu_pos: 9999, Mu_neg: 9999, Vu: 9999 };
    const r   = designMember(beam16x24, mat4k, rebar3_8, big);
    expect(r.status).toBe('NG');
  });

  it('status = OK when loads are well within capacity', () => {
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

  it('does not throw for T-beam member', () => {
    const tRebar: RebarLayout = {
      topBars: [{ numBars: 3, barSize: 9 }],
      botBars: [{ numBars: 5, barSize: 9 }],
      ties: { barSize: 4, spacing: 5, legs: 2 },
    };
    expect(() => designMember(tBeam, mat5k, tRebar, load, 30)).not.toThrow();
  });

  it('does not throw for column member', () => {
    const colLoad = { ...load, Pu: 400 };
    expect(() => designMember(rectCol, mat5k, colRebar, colLoad)).not.toThrow();
  });
});

// ── Interaction diagram ───────────────────────────────────────────────────────

describe('computeInteractionDiagram', () => {
  it('returns ≥ 5 points', () => {
    expect(computeInteractionDiagram(rectCol, mat5k, colRebar).length).toBeGreaterThanOrEqual(5);
  });

  it('first point has highest axial Pn (pure compression)', () => {
    const pts = computeInteractionDiagram(rectCol, mat5k, colRebar);
    expect(pts[0].Pn).toBeGreaterThanOrEqual(Math.max(...pts.map(p => p.Pn)));
  });

  it('last point has negative Pn (pure tension)', () => {
    const pts = computeInteractionDiagram(rectCol, mat5k, colRebar);
    expect(pts[pts.length - 1].Pn).toBeLessThan(0);
  });

  it('all phi values are in [0.65, 0.9]', () => {
    const pts = computeInteractionDiagram(rectCol, mat5k, colRebar);
    pts.forEach(p => {
      expect(p.phi).toBeGreaterThanOrEqual(0.65 - 1e-9);
      expect(p.phi).toBeLessThanOrEqual(0.90 + 1e-9);
    });
  });

  it('phiPn = phi * Pn for all points except pure-compression (which applies 0.80 factor)', () => {
    const pts = computeInteractionDiagram(rectCol, mat5k, colRebar, 5);
    // Skip first point (pure compression) — phiPn there includes ACI 0.80 eccentricity cap
    pts.slice(1).forEach(p => expect(p.phiPn).toBeCloseTo(p.phi * p.Pn, 2));
  });

  it('circular column generates valid diagram', () => {
    const pts = computeInteractionDiagram(circCol, mat5k, colRebar);
    expect(pts.length).toBeGreaterThanOrEqual(5);
    expect(pts[0].Pn).toBeGreaterThan(0);
  });
});

// ── ACI code checks ───────────────────────────────────────────────────────────

describe('ACI 318-19 code compliance', () => {
  it('lightweight lambda=0.75 reduces Vc vs normal-weight', () => {
    const nw = computeShear(beam16x24, mat4k, rebar3_8);
    const lw = computeShear(beam16x24, { ...mat4k, lambdaConcrete: 0.75 }, rebar3_8);
    expect(lw.Vc).toBeCloseTo(nw.Vc * 0.75, 1);
  });

  it('design does not throw for fc=3000, 4000, 5000, 6000, 8000 psi', () => {
    const load: LoadCase = { id: 'x', label: 'x', Mu_pos: 80, Mu_neg: 40, Vu: 30, Tu: 2, Pu: 0 };
    [3000, 4000, 5000, 6000, 8000].forEach(fc => {
      expect(() => designMember(beam16x24, { ...mat4k, fc }, rebar3_8, load)).not.toThrow();
    });
  });

  it('Av_min_per_s computed correctly for #4 stirrups in 16" beam', () => {
    // Av,min/s = max(0.75√f'c/fyt, 50/fyt) × bw
    // = max(0.75√4000/60000, 50/60000) × 16
    // = max(0.000791, 0.000833) × 16 = 0.01333 in²/in
    const r = computeShear(beam16x24, mat4k, rebar3_8);
    expect(r.Av_min_per_s).toBeCloseTo(0.01333, 3);
  });

  it('beta1 = 0.75 for fc=6000 psi', () => {
    expect(beta1(6000)).toBeCloseTo(0.75, 3);
  });
});
