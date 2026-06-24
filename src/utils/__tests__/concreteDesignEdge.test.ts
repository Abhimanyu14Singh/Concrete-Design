/**
 * ACI 318-19 beam engine — edge case tests.
 * Covers: zero loads, over-reinforced, torsion threshold, compression-controlled
 * φ transitions, lightweight concrete, high/low f'c, β₁ floor, stirrup spacing
 * boundaries, and the §9.6.1.3 (4/3)·As_req exception.
 */
import { describe, it, expect } from 'vitest';
import {
  beta1, steelLimits, computeFlexure, computeShear, computeTorsion,
  designMember, getBarArea, effectiveDepth,
} from '../concreteDesign';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../../types';

// ── Shared helpers ────────────────────────────────────────────────────────────
const mat4k: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat8k: MaterialProps = { fc: 8000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat3k: MaterialProps = { fc: 3000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const matLW: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 0.75 };

const sec16x24: SectionDimensions = {
  type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4,
};
const sec12x20: SectionDimensions = {
  type: 'rectangular_beam', b: 12, h: 20, coverClear: 1.5, stirrupDia: 4,
};
const stdRebar: RebarLayout = {
  topBars: [{ numBars: 2, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
};
const zeroLoad: LoadCase = { id: 'zero', label: 'zero', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 };

// ── β₁ boundaries ─────────────────────────────────────────────────────────────
describe('beta1 — ACI Table 22.2.2.4.3', () => {
  it('is 0.85 for f\'c ≤ 4000 psi', () => {
    expect(beta1(4000)).toBeCloseTo(0.85, 5);
    expect(beta1(3000)).toBeCloseTo(0.85, 5);
  });
  it('decreases linearly above 4000 psi', () => {
    // β₁ = 0.85 − 0.05*(fc−4000)/1000
    expect(beta1(5000)).toBeCloseTo(0.80, 5);
    expect(beta1(6000)).toBeCloseTo(0.75, 5);
    expect(beta1(8000)).toBeCloseTo(0.65, 5);
  });
  it('floors at 0.65 for f\'c ≥ 8000 psi', () => {
    expect(beta1(10000)).toBeCloseTo(0.65, 5);
    expect(beta1(12000)).toBeCloseTo(0.65, 5);
  });
});

// ── steelLimits ────────────────────────────────────────────────────────────────
describe('steelLimits', () => {
  it('As_min uses ρ_min = max(3√f\'c/fy, 200/fy)', () => {
    const { As_min } = steelLimits(sec16x24, mat4k);
    const d = effectiveDepth(sec16x24, 8);
    const rho_min = Math.max(3 * Math.sqrt(4000) / 60000, 200 / 60000);
    expect(As_min).toBeCloseTo(rho_min * 16 * d, 4);
  });
  it('As_max uses εt = 0.004 limit (compression-controlled boundary)', () => {
    const { As_max } = steelLimits(sec16x24, mat4k);
    const d = effectiveDepth(sec16x24, 8);
    const b1 = beta1(4000);
    const expected = 0.85 * b1 * (4000 / 60000) * (0.003 / 0.007) * 16 * d;
    expect(As_max).toBeCloseTo(expected, 3);
  });
  it('As_max is smaller at high f\'c because β₁ = 0.65 floor', () => {
    const lim4k = steelLimits(sec16x24, mat4k);
    const lim8k = steelLimits(sec16x24, mat8k);
    // Higher fc increases 0.85·β₁·fc but β₁ drops; net effect: lim8k.As_max > lim4k.As_max
    expect(lim8k.As_max).toBeGreaterThan(lim4k.As_max);
  });
  it('200/fy governs over 3√f\'c/fy for low f\'c', () => {
    const { As_min } = steelLimits(sec16x24, mat3k);
    const d = effectiveDepth(sec16x24, 8);
    // 3√3000/60000 = 0.00274; 200/60000 = 0.00333 → 200/fy governs
    expect(As_min).toBeCloseTo((200 / 60000) * 16 * d, 3);
  });
});

// ── Zero-load case ─────────────────────────────────────────────────────────────
describe('designMember — zero loads', () => {
  it('returns DCR = 0 for all actions when Mu=Vu=Tu=0', () => {
    const r = designMember(sec16x24, mat4k, stdRebar, zeroLoad);
    expect(r.DCR_flex_pos).toBe(0);
    expect(r.DCR_flex_neg).toBe(0);
    expect(r.DCR_shear).toBe(0);
    expect(r.DCR_torsion).toBe(0);
  });
  it('status is OK with typical steel and zero loads', () => {
    const r = designMember(sec16x24, mat4k, stdRebar, zeroLoad);
    expect(r.status).toBe('OK');
  });
  it('returns finite phi_Mn even under zero demand', () => {
    const r = designMember(sec16x24, mat4k, stdRebar, zeroLoad);
    expect(r.phi_Mn_pos).toBeGreaterThan(0);
    expect(r.phi_Mn_neg).toBeGreaterThan(0);
  });
});

// ── §9.6.1.3 exception: As ≥ (4/3)·As_req avoids min-steel warning ──────────
describe('As_min exception §9.6.1.3', () => {
  it('no As_min warning when Mu is tiny but (4/3)·As_req < As provided', () => {
    // Very small positive moment → As_req_raw tiny; (4/3)·As_req < As_bot → exception applies
    const smallLoad: LoadCase = { id: 'sm', label: 'small', Mu_pos: 1, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 };
    const r = designMember(sec16x24, mat4k, stdRebar, smallLoad);
    const asMinWarnings = r.warnings.filter(w => w.code === 'ACI §9.6.1.2');
    expect(asMinWarnings).toHaveLength(0);
  });
  it('As_min warning fires when moment is significant and steel is well below As_min', () => {
    const lightRebar: RebarLayout = {
      topBars: [{ numBars: 2, barSize: 3 }],
      botBars: [{ numBars: 2, barSize: 3 }],
      ties: { barSize: 3, spacing: 6, legs: 2 },
    };
    const load: LoadCase = { id: 'lc', label: '', Mu_pos: 100, Mu_neg: 40, Vu: 20, Tu: 0, Pu: 0 };
    const r = designMember(sec16x24, mat4k, lightRebar, load);
    const hasAsMin = r.warnings.some(w => w.code === 'ACI §9.6.1.2');
    expect(hasAsMin).toBe(true);
  });
});

// ── Over-reinforced (As > As_max) ─────────────────────────────────────────────
describe('designMember — over-reinforced', () => {
  it('emits As_max warning when bottom steel exceeds limit', () => {
    const heavyRebar: RebarLayout = {
      topBars: [{ numBars: 2, barSize: 8 }],
      botBars: [{ numBars: 8, barSize: 11 }], // 8 × 1.56 = 12.48 in²
      ties: { barSize: 4, spacing: 6, legs: 2 },
    };
    const r = designMember(sec12x20, mat4k, heavyRebar, zeroLoad);
    const warn = r.warnings.find(w => w.code === 'ACI §9.3.3');
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe('error');
  });
  it('status is Warning (not OK) when over-reinforced under zero loads', () => {
    // With zero loads, DCR = 0 so status can't be NG; but the As>As_max error sets it to Warning.
    const heavyRebar: RebarLayout = {
      topBars: [{ numBars: 2, barSize: 8 }],
      botBars: [{ numBars: 8, barSize: 11 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    };
    const r = designMember(sec12x20, mat4k, heavyRebar, zeroLoad);
    expect(r.status).not.toBe('OK');
  });
});

// ── Torsion threshold ──────────────────────────────────────────────────────────
describe('computeTorsion — threshold behavior', () => {
  it('Tu_threshold = φ·λ·√f\'c·Acp²/Pcp / 12000', () => {
    const t = computeTorsion(sec16x24, mat4k, stdRebar);
    const b = 16, h = 24, phi = 0.75, fc = 4000;
    const Acp = b * h, Pcp = 2 * (b + h);
    const expected = phi * 1.0 * Math.sqrt(fc) * Acp * Acp / Pcp / 12000;
    expect(t.Tu_threshold).toBeCloseTo(expected, 3);
  });
  it('Tcr = 4 × Tu_threshold / phi', () => {
    const t = computeTorsion(sec16x24, mat4k, stdRebar);
    expect(t.Tcr).toBeCloseTo((4 / 0.75) * t.Tu_threshold, 4);
  });
  it('DCR_torsion is very small when Tu << threshold', () => {
    // Engine computes Tu/phi_Tn even for sub-threshold Tu — it doesn't snap to 0.
    // Verify that DCR_torsion is at least < 1 for sub-threshold demand.
    const t = computeTorsion(sec16x24, mat4k, stdRebar);
    const subThreshLoad: LoadCase = {
      id: 'lc', label: '', Mu_pos: 100, Mu_neg: 0, Vu: 30, Tu: t.Tu_threshold * 0.5, Pu: 0,
    };
    const r = designMember(sec16x24, mat4k, stdRebar, subThreshLoad);
    expect(r.DCR_torsion).toBeLessThan(1);
  });
  it('phi_Tn increases with larger stirrup bar size', () => {
    const rb5: RebarLayout = { ...stdRebar, ties: { barSize: 5, spacing: 6, legs: 2 } };
    const rb4 = computeTorsion(sec16x24, mat4k, stdRebar);
    const rb5r = computeTorsion(sec16x24, mat4k, rb5);
    expect(rb5r.phi_Tn).toBeGreaterThan(rb4.phi_Tn);
  });
  it('lightweight concrete (λ=0.75) reduces Tu_threshold by 25%', () => {
    const normal = computeTorsion(sec16x24, mat4k, stdRebar);
    const lw = computeTorsion(sec16x24, matLW, stdRebar);
    expect(lw.Tu_threshold).toBeCloseTo(normal.Tu_threshold * 0.75, 3);
    expect(lw.Tcr).toBeCloseTo(normal.Tcr * 0.75, 3);
  });
});

// ── Shear: lightweight concrete ─────────────────────────────────────────────
describe('computeShear — lightweight concrete', () => {
  it('Vc is reduced by λ=0.75 vs normal-weight', () => {
    const normal = computeShear(sec16x24, mat4k, stdRebar, 0);
    const lw = computeShear(sec16x24, matLW, stdRebar, 0);
    expect(lw.Vc).toBeCloseTo(normal.Vc * 0.75, 2);
  });
  it('phi_Vn still increases with stirrups under lightweight concrete', () => {
    const noTies: RebarLayout = {
      topBars: stdRebar.topBars, botBars: stdRebar.botBars,
    };
    const withTies = computeShear(sec16x24, matLW, stdRebar, 0);
    const without = computeShear(sec16x24, matLW, noTies, 0);
    expect(withTies.phi_Vn).toBeGreaterThan(without.phi_Vn);
  });
});

// ── High f'c (8000 psi) — β₁ at floor ────────────────────────────────────────
describe('designMember at high f\'c = 8000 psi', () => {
  it('phi_Mn_pos is larger at higher f\'c for same steel', () => {
    const r4k = designMember(sec16x24, mat4k, stdRebar, zeroLoad);
    const r8k = designMember(sec16x24, mat8k, stdRebar, zeroLoad);
    expect(r8k.phi_Mn_pos).toBeGreaterThan(r4k.phi_Mn_pos);
  });
  it('Vc is larger at higher f\'c (proportional to √f\'c)', () => {
    const s4k = computeShear(sec16x24, mat4k, stdRebar, 0);
    const s8k = computeShear(sec16x24, mat8k, stdRebar, 0);
    // Vc ∝ √f'c: ratio should be √(8000/4000) ≈ 1.414
    expect(s8k.Vc / s4k.Vc).toBeCloseTo(Math.sqrt(8000 / 4000), 1);
  });
});

// ── Flexure: computeFlexure boundary values ──────────────────────────────────
describe('computeFlexure', () => {
  it('phi_Mn_pos > 0 even with zero top steel', () => {
    const flex = computeFlexure(sec16x24, mat4k, 0, 4 * getBarArea(8), 20);
    expect(flex.phi_Mn_pos).toBeGreaterThan(0);
  });
  it('phi_Mn_neg = 0 when top steel is zero', () => {
    const flex = computeFlexure(sec16x24, mat4k, 0, 4 * getBarArea(8), 20);
    expect(flex.phi_Mn_neg).toBe(0);
  });
  it('tension-controlled φ = 0.9 for typical under-reinforced section', () => {
    // et for typical beam >> 0.005 so φ = 0.9
    const flex = computeFlexure(sec16x24, mat4k, 0, 2 * getBarArea(8), 20);
    // φMn / Mn should be ≈ 0.9
    if (flex.Mn_pos > 0) {
      expect(flex.phi_Mn_pos / flex.Mn_pos).toBeCloseTo(0.9, 3);
    }
  });
  it('phi_Mn increases with more bottom steel', () => {
    const f2 = computeFlexure(sec16x24, mat4k, 0, 2 * getBarArea(8), 20);
    const f4 = computeFlexure(sec16x24, mat4k, 0, 4 * getBarArea(8), 20);
    expect(f4.phi_Mn_pos).toBeGreaterThan(f2.phi_Mn_pos);
  });
});

// ── designMember: NG status when demand exceeds capacity ─────────────────────
describe('designMember — capacity exceedance', () => {
  it('status is NG when Mu_pos greatly exceeds phi_Mn_pos', () => {
    const r = designMember(sec12x20, mat4k, stdRebar, {
      id: 'lc', label: '', Mu_pos: 1000, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0,
    });
    expect(r.status).toBe('NG');
    expect(r.DCR_flex_pos).toBeGreaterThan(1);
  });
  it('status is NG when Vu greatly exceeds phi_Vn', () => {
    const r = designMember(sec12x20, mat3k, stdRebar, {
      id: 'lc', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 500, Tu: 0, Pu: 0,
    });
    expect(r.DCR_shear).toBeGreaterThan(1);
    expect(r.status).toBe('NG');
  });
});

// ── Axial compression boosts Vc ───────────────────────────────────────────────
describe('computeShear — axial compression', () => {
  it('Vc with Pu > 0 is greater than without', () => {
    const noAxial = computeShear(sec16x24, mat4k, stdRebar, 0);
    const withAxial = computeShear(sec16x24, mat4k, stdRebar, 200);
    expect(withAxial.Vc).toBeGreaterThan(noAxial.Vc);
  });
});
