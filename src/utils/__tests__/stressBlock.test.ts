/**
 * The equivalent stress block `a` — ACI 318-19 §22.2.2 — and the φ that rides on it.
 *
 * Three defects lived here, all of them in how `a` was derived rather than in the
 * formula for Mn once `a` was known:
 *
 *  1. T/L beams in HOGGING took the flange + web split. The flange is in TENSION at
 *     a hogging section, so the compression zone is the plain rectangular web. The
 *     split ran with bFlange = bw, which made the flange force zero while
 *     `a = a_web + hf` still added the flange depth — `a` one whole hf too deep, the
 *     lever arm one whole hf too short, and c/φ dragged down with it.
 *  2. εt was read at d (the tension-steel CENTROID). §21.2.2 reads it at dt, the
 *     EXTREME layer, which on a two-layer cage is deeper.
 *  3. The φ transition band was hard-coded to Grade 60's 0.002 → 0.005 instead of
 *     εty → εty + 0.003, so Grade 75/80/100 got the wrong φ.
 *
 * Numbers below are hand-checked, per the repo rule on engine changes.
 */
import { describe, it, expect } from 'vitest';
import type { MaterialProps, RebarLayout, SectionDimensions } from '../../types';
import { beta1, computeFlexure, phiFlexure, steelLimits } from '../concreteDesign';
import { generateBreakdown } from '../calcBreakdown';

const mat4k: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 };
const mat8k75: MaterialProps = { fc: 8000, fy: 75000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 };

describe('φ per Table 21.2.2 — the band moves with the grade', () => {
  it('Grade 60: tension-controlled at εty + 0.003 = 0.00507, not 0.005', () => {
    const ety = 60000 / 29e6;                       // 0.0020690
    expect(phiFlexure(ety + 0.003, 60000)).toBeCloseTo(0.9, 9);
    expect(phiFlexure(ety, 60000)).toBeCloseTo(0.65, 9);
    // 0.005 used to read as fully tension-controlled; it is inside the band.
    expect(phiFlexure(0.005, 60000)).toBeLessThan(0.9);
    expect(phiFlexure(0.005, 60000)).toBeCloseTo(0.65 + 0.25 * (0.005 - ety) / 0.003, 9);
  });

  it('Grade 75: the whole band shifts up with εty', () => {
    const ety = 75000 / 29e6;                       // 0.0025862
    expect(phiFlexure(0.005, 75000)).toBeCloseTo(0.65 + 0.25 * (0.005 - ety) / 0.003, 9);
    // The Grade-60 hard-coding read 0.005 as φ = 0.90 here — 7% unconservative.
    expect(phiFlexure(0.005, 75000)).toBeLessThan(0.88);
    expect(phiFlexure(ety + 0.003, 75000)).toBeCloseTo(0.9, 9);
  });

  it('clamps outside the band and never leaves 0.65 … 0.90', () => {
    for (const et of [-1, 0, 0.001, 0.004, 0.01, 1]) {
      const phi = phiFlexure(et, 60000);
      expect(phi).toBeGreaterThanOrEqual(0.65);
      expect(phi).toBeLessThanOrEqual(0.9);
    }
  });
});

describe('εt is read at dt, the extreme tension layer (§21.2.2)', () => {
  // 12×28, f'c 6000, #5 stirrups, cc 1.5, bottom 4-#8 + 4-#8 (dz = 1").
  // d  = 24.375" (centroid), dt = 25.375" (outer layer) — the S-Concrete reference cage.
  const section: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 28, coverClear: 1.5, stirrupDia: 5 };
  const mat: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 };
  const topBars = [{ numBars: 4, barSize: 8 }];
  const botBars = [{ numBars: 4, barSize: 8 }, { numBars: 4, barSize: 8 }];

  it('reproduces the S-Concrete reference: a = 4.12", φMn⁺ = 629.3 kip-ft', () => {
    const r = computeFlexure(section, mat, 3.16, 6.32, 24, 8, 8, topBars, botBars, 1.0);
    expect(r.mode_pos).toBe('doubly');
    expect(r.a_pos).toBeCloseTo(4.116, 2);          // equilibrium with 4-#8 comp steel
    expect(r.phi_pos).toBeCloseTo(0.9, 6);
    expect(r.phi_Mn_pos).toBeCloseTo(629.3, 0);
  });

  it('εt at dt exceeds εt at d, so the sheet and the engine must both use dt', () => {
    const r = computeFlexure(section, mat, 3.16, 6.32, 24, 8, 8, topBars, botBars, 1.0);
    const c = r.a_pos / beta1(6000);
    const et_d = 0.003 * (24.375 - c) / c;
    const et_dt = 0.003 * (25.375 - c) / c;
    expect(et_dt).toBeGreaterThan(et_d);
    expect(r.phi_pos).toBeCloseTo(phiFlexure(et_dt, 60000), 9);
  });
});

describe('T/L beams: the flange only splits the block when it is in COMPRESSION', () => {
  // T-beam 60/12 × 24, hf = 4", f'c 4000, cc 1.5, #4 stirrups.
  // Hogging: tension = 4-#8 top (3.16 in², T = 189.6 kip) at d = 21.5";
  //          compression = the 12" web, plus the 6-#9 bottom cage at 2.564".
  // Hand check: c = 3.171" → a = 2.696",
  //   Cc = 0.85 × 4 × 12 × 2.696 = 110.0 kip
  //   ε's = 0.003(3.171 − 2.564)/3.171 = 0.000574 → f's = 16.6 ksi, bar inside the block
  //   Cs = 6.0 × (16.6 − 3.4) = 79.4 kip     ⇒  Cc + Cs = 189.4 ≈ T ✓
  // The old code added hf and reported a = 8.647".
  const tee: SectionDimensions = { type: 'T_beam', b: 60, bw: 12, h: 24, hf: 4, coverClear: 1.5, stirrupDia: 4 };
  const topBars = [{ numBars: 4, barSize: 8 }];
  const botBars = [{ numBars: 6, barSize: 9 }];

  it('hogging uses the rectangular web — a is NOT inflated by hf', () => {
    const r = computeFlexure(tee, mat4k, 3.16, 6.0, 24, 8, 9, topBars, botBars, 1.0);
    expect(r.mode_neg).not.toBe('flanged');
    expect(r.a_neg).toBeLessThan(tee.hf! + 4.65);   // 8.65" was the bug
    expect(r.a_neg).toBeCloseTo(2.696, 2);
  });

  it('equilibrium actually balances at the solved a (the fixed point used not to)', () => {
    const r = computeFlexure(tee, mat4k, 3.16, 6.0, 24, 8, 9, topBars, botBars, 1.0);
    const c = r.a_neg / beta1(4000);
    const yBar = 1.5 + 0.5 + 1.128 / 2;             // bottom cage centroid, #4 stirrup + #9
    const Cc = 0.85 * 4000 * 12 * r.a_neg;
    const fs = Math.min(0.003 * (c - yBar) / c * 29e6, 60000);
    const Cs = 6.0 * (fs - (yBar < r.a_neg ? 0.85 * 4000 : 0));
    expect((Cc + Cs) / (3.16 * 60000)).toBeCloseTo(1.0, 3);
  });

  it('hogging Mn⁻ matches the identical rectangular section (the flange is inert)', () => {
    const asRect: SectionDimensions = { ...tee, type: 'rectangular_beam', b: 12 };
    const t = computeFlexure(tee, mat4k, 3.16, 6.0, 24, 8, 9, topBars, botBars, 1.0);
    const r = computeFlexure(asRect, mat4k, 3.16, 6.0, 24, 8, 9, topBars, botBars, 1.0);
    expect(t.a_neg).toBeCloseTo(r.a_neg, 9);
    expect(t.Mn_neg).toBeCloseTo(r.Mn_neg, 9);
    expect(t.phi_Mn_neg).toBeCloseTo(r.phi_Mn_neg, 9);
  });

  it('sagging still splits flange + web once the block runs past hf', () => {
    // 10-#9 (10 in²) bottom: a = 10 × 60000 / (0.85 × 4000 × 60) = 2.94" ≤ hf → rectangular;
    // narrow the flange so it does split.
    const narrow: SectionDimensions = { ...tee, b: 24, hf: 2 };
    const r = computeFlexure(narrow, mat4k, 3.16, 8.0, 24, 8, 9, topBars,
      [{ numBars: 8, barSize: 9 }], 1.0);
    expect(r.mode_pos).toBe('flanged');
    expect(r.a_pos).toBeGreaterThan(narrow.hf!);
  });

  it('L-beam hogging, 8-#11 Grade 75 in f\'c 8000 — hand-checked φMn⁻ = 1877 kip-ft', () => {
    // b 40 / bw 16 × 36, hf 5, cc 1.5, #5 stirrups. d⁻ = 36 − (1.5 + 0.625 + 0.705) = 33.17"
    // a = 12.48 × 75000 / (0.85 × 8000 × 16) = 8.603", less the 2-#4 bottom credit → 8.367"
    // c = 8.367/0.65 = 12.87", εt = 0.003(33.17 − 12.87)/12.87 = 0.004732
    // φ = 0.65 + 0.25(0.004732 − 0.0025862)/0.003 = 0.829
    const ell: SectionDimensions = { type: 'L_beam', b: 40, h: 36, bw: 16, hf: 5, coverClear: 1.5, stirrupDia: 5 };
    const cage: RebarLayout = {
      topBars: [{ numBars: 8, barSize: 11 }], botBars: [{ numBars: 2, barSize: 4 }],
      ties: { barSize: 5, spacing: 6, legs: 4 }, layerClearSpacing: 1,
    };
    const r = computeFlexure(ell, mat8k75, 12.48, 0.4, 24, 11, 4, cage.topBars, cage.botBars, 1);
    expect(r.a_neg).toBeCloseTo(8.367, 2);
    expect(r.phi_neg).toBeCloseTo(0.829, 2);
    expect(r.Mn_neg).toBeCloseTo(2264.8, 0);
    expect(r.phi_Mn_neg).toBeCloseTo(1876.8, 0);
  });
});

describe('steelLimits uses the real cage depth, not a nominal single #8 layer', () => {
  // 12×28, f'c 6000, #5 stirrups, cc 1.5, bottom 4-#8 + 4-#8 → d = 24.375".
  // S-Concrete reports As,min = 1.13 in² for exactly this section.
  const section: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 28, coverClear: 1.5, stirrupDia: 5 };
  const mat: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 };
  const botBars = [{ numBars: 4, barSize: 8 }, { numBars: 4, barSize: 8 }];

  it('As,min = 1.13 in² with the real two-layer d (S-Concrete)', () => {
    expect(steelLimits(section, mat, 'bot', botBars, 1.0).As_min).toBeCloseTo(1.13, 2);
  });

  it('the nominal fallback is the deeper single-layer d, so it reads high', () => {
    const nominal = steelLimits(section, mat, 'bot').As_min;      // d = 25.375"
    const actual  = steelLimits(section, mat, 'bot', botBars, 1.0).As_min;
    expect(nominal).toBeGreaterThan(actual);
    expect(nominal / actual).toBeCloseTo(25.375 / 24.375, 3);
  });

  it('a single-layer cage leaves the old answer untouched', () => {
    const one = [{ numBars: 4, barSize: 8 }];
    expect(steelLimits(section, mat, 'bot', one, 1.0).As_min)
      .toBeCloseTo(steelLimits(section, mat, 'bot').As_min, 9);
  });
});

describe('As,max follows ACI 318-19 §9.3.3.1', () => {
  // 12x28, f'c 6000, #5 stirrups, cc 1.5, bottom 4-#8 + 4-#8.
  // d = 24.375" (centroid), dt = 25.375" (outer layer).
  const section: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 28, coverClear: 1.5, stirrupDia: 5 };
  const mat: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 };
  const botBars = [{ numBars: 4, barSize: 8 }, { numBars: 4, barSize: 8 }];
  const ety = 60000 / 29e6;

  it('caps εt at εty + 0.003 and measures it at d, the centroid', () => {
    // Changed from dt (the extreme layer) to d, to agree with S-CONCRETE — see
    // `steelLimits`. The two differ only on a multi-layer cage, and this is one:
    // d = 24.375", dt = 25.375". Using d is the lower, safer cap of the two.
    const { As_max } = steelLimits(section, mat, 'bot', botBars, 1.0);
    expect(As_max).toBeCloseTo(0.85 * beta1(6000) * (6000 / 60000) * (0.003 / (0.006 + ety)) * 12 * 24.375, 3);
    expect(As_max).not.toBeCloseTo(0.85 * beta1(6000) * (6000 / 60000) * (0.003 / (0.006 + ety)) * 12 * 25.375, 3);
    expect(8 * 0.79).toBeLessThan(As_max);      // the reference cage still passes
  });

  it('the Calc Sheet prints the engine number, not a second derivation', () => {
    const rebar: RebarLayout = {
      topBars: [{ numBars: 4, barSize: 8 }], botBars,
      ties: { barSize: 5, spacing: 9, legs: 2 }, layerClearSpacing: 1,
    };
    const { As_max } = steelLimits(section, mat, 'bot', botBars, 1.0);
    const step = generateBreakdown(section, mat, rebar,
      { id: '1', label: '1', Mu_pos: 340, Mu_neg: 120, Vu: 60, Tu: 0, Pu: 0 }, 24)
      .flatMap(sec => sec.steps)
      .find(st => st.ref === 'ACI 318-19 §9.3.3.1');
    expect(step).toBeDefined();
    expect(step!.result).toBe(`${As_max.toFixed(2)} in²`);
    expect(step!.equation).not.toContain('0.004');
  });
});
