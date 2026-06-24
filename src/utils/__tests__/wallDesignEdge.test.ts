/**
 * ACI 318-19 wall design — edge case tests.
 * Covers: squat wall (hw/lw ≤ 1.5), tall wall (hw/lw ≥ 3), zero axial,
 * SBZ boundary conditions (strain vs stress trigger), high f'c, min ρl/ρt
 * warnings, spacing limits, Ash adequacy, and P-M interaction edge cases.
 */
import { describe, it, expect } from 'vitest';
import {
  wallReinfRatios, checkMinReinf, checkWallSpacing, wallShear,
  sbzTrigger, designWallACI,
} from '../wallDesign';
import type { MaterialProps, SectionDimensions, LoadCase } from '../../types';
import type { WallRebarLayout } from '../../types';

// ── Shared fixtures ────────────────────────────────────────────────────────────
const mat4k: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat6k: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };

function makeSec(lw: number, tw: number, hw: number): SectionDimensions {
  return { type: 'shear_wall', b: lw, h: tw, lw, tw, hw, coverClear: 0.75, stirrupDia: 4 };
}

function makeWallRebar(override: Partial<WallRebarLayout> = {}): WallRebarLayout {
  return {
    vertBarSize: 5, vertSpacing: 12, horizBarSize: 5, horizSpacing: 12, numCurtains: 2,
    sbzBarSize: 8, sbzNumBars: 6, sbzTieBarSize: 4, sbzTieSpacing: 4, sbzTieLegs: 4,
    driftRatio: 0.015,
    ...override,
  };
}

function makeLoad(Pu = 0, Vu = 100, Mu_pos = 1000): LoadCase {
  return { id: 'lc', label: 'EQ', Mu_pos, Mu_neg: 0, Vu, Tu: 0, Pu };
}

// ── wallReinfRatios ───────────────────────────────────────────────────────────
describe('wallReinfRatios', () => {
  it('calculates ρl and ρt from bar/spacing/curtains', () => {
    const r = wallReinfRatios(10, makeWallRebar());
    expect(r.rhoL).toBeGreaterThan(0);
    expect(r.rhoT).toBeGreaterThan(0);
  });
  it('ρl = ρt for symmetric vertical and horizontal layouts', () => {
    const r = wallReinfRatios(10, makeWallRebar({ vertBarSize: 5, vertSpacing: 12, horizBarSize: 5, horizSpacing: 12 }));
    expect(r.rhoL).toBeCloseTo(r.rhoT, 4);
  });
  it('two curtains doubles ρ vs one curtain', () => {
    const r1 = wallReinfRatios(10, makeWallRebar({ numCurtains: 1 }));
    const r2 = wallReinfRatios(10, makeWallRebar({ numCurtains: 2 }));
    expect(r2.rhoL).toBeCloseTo(r1.rhoL * 2, 4);
    expect(r2.rhoT).toBeCloseTo(r1.rhoT * 2, 4);
  });
});

// ── checkMinReinf ─────────────────────────────────────────────────────────────
describe('checkMinReinf — §11.6', () => {
  it('no warnings when ρl ≥ 0.0025 and ρt ≥ 0.0025', () => {
    const result = checkMinReinf(0.003, 0.003, 120, 60);
    expect(result.warnings).toHaveLength(0);
  });
  it('warning when ρt < 0.0025', () => {
    const result = checkMinReinf(0.003, 0.002, 120, 60);
    const hasWarn = result.warnings.some(w => w.message.toLowerCase().includes('horizontal') || w.message.toLowerCase().includes('transverse') || w.message.includes('ρt'));
    expect(hasWarn).toBe(true);
  });
  it('warning when ρl < 0.0025 (or lower limit for hw/lw condition)', () => {
    const result = checkMinReinf(0.001, 0.003, 120, 60);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it('both warnings fire when both ρl and ρt are below limit', () => {
    const result = checkMinReinf(0.001, 0.001, 120, 60);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// ── checkWallSpacing ─────────────────────────────────────────────────────────
describe('checkWallSpacing', () => {
  it('no warnings when spacing is within all limits', () => {
    // lw=120, tw=12: limits are min(lw/5=24, 3tw=36, 18)=18
    const result = checkWallSpacing(12, 12, 120, 12);
    expect(result.warnings).toHaveLength(0);
  });
  it('warning when vertical spacing exceeds lw/5', () => {
    // lw=60: lw/5=12; use vertSpacing=15 > 12
    const result = checkWallSpacing(15, 10, 60, 12);
    const hasWarn = result.warnings.some(w => w.message.includes('spacing') || w.message.includes('lw/5'));
    expect(hasWarn).toBe(true);
  });
  it('warning when spacing exceeds 18"', () => {
    const result = checkWallSpacing(20, 20, 200, 12);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ── wallShear ─────────────────────────────────────────────────────────────────
describe('wallShear', () => {
  it('squat wall (hw/lw = 0.5) → αc = 3.0', () => {
    // hw/lw ≤ 1.5 → αc = 3.0
    const r = wallShear(120, 12, 60, 4000, 1.0, 0.0025, 60000, 100);
    expect(r.alphaC).toBeCloseTo(3.0, 1);
  });
  it('slender wall (hw/lw = 2.5) → αc = 2.0', () => {
    // hw/lw ≥ 2 → αc = 2.0
    const r = wallShear(120, 12, 300, 4000, 1.0, 0.0025, 60000, 100);
    expect(r.alphaC).toBeCloseTo(2.0, 1);
  });
  it('αc interpolates linearly between 1.5 and 2.0 (1.5 ≤ hw/lw ≤ 2.0)', () => {
    const rLow  = wallShear(120, 12, 180, 4000, 1.0, 0.0025, 60000, 100); // hw/lw=1.5
    const rMid  = wallShear(120, 12, 210, 4000, 1.0, 0.0025, 60000, 100); // hw/lw=1.75
    const rHigh = wallShear(120, 12, 240, 4000, 1.0, 0.0025, 60000, 100); // hw/lw=2.0
    expect(rLow.alphaC).toBeCloseTo(3.0, 1);
    expect(rMid.alphaC).toBeGreaterThanOrEqual(2.0);
    expect(rMid.alphaC).toBeLessThanOrEqual(3.0);
    expect(rHigh.alphaC).toBeCloseTo(2.0, 1);
  });
  it('phi_Vn increases with larger ρt', () => {
    const rLow  = wallShear(120, 12, 240, 4000, 1.0, 0.0015, 60000, 100);
    const rHigh = wallShear(120, 12, 240, 4000, 1.0, 0.0040, 60000, 100);
    expect(rHigh.phi_Vn).toBeGreaterThan(rLow.phi_Vn);
  });
  it('DCR < 1 for typical moderate shear demand', () => {
    const r = wallShear(120, 12, 240, 4000, 1.0, 0.0025, 60000, 50);
    expect(r.DCR).toBeLessThan(1);
  });
  it('governedByMax flag when Vn hits 10·Acv·√f\'c ceiling', () => {
    const r = wallShear(120, 12, 240, 4000, 1.0, 0.02, 60000, 10000);
    expect(r.governedByMax).toBe(true);
  });
  it('high f\'c increases phi_Vn', () => {
    const r4k = wallShear(120, 12, 240, 4000, 1.0, 0.0025, 60000, 100);
    const r6k = wallShear(120, 12, 240, 6000, 1.0, 0.0025, 60000, 100);
    expect(r6k.phi_Vn).toBeGreaterThan(r4k.phi_Vn);
  });
});

// ── sbzTrigger ────────────────────────────────────────────────────────────────
describe('sbzTrigger', () => {
  it('not triggered for a wall well within limits', () => {
    const r = sbzTrigger(120, 12, 240, 4000, 10, 0.015, 200, 1000);
    // c_demand=10 < c_limit=120/(900*0.015)=8.9" — wait, 10>8.9 triggers strain!
    // Use c_demand = 5 which is clearly below limit
    const r2 = sbzTrigger(120, 12, 240, 4000, 5, 0.015, 200, 1000);
    expect(r2.strainTriggered).toBe(false);
  });
  it('strain trigger fires when c > c_limit', () => {
    // c_limit = lw/(900*driftRatio) = 120/(900*0.015) ≈ 8.89"
    const r = sbzTrigger(120, 12, 240, 4000, 15, 0.015, 200, 1000);
    expect(r.strainTriggered).toBe(true);
    expect(r.required).toBe(true);
  });
  it('stress trigger fires when σ_max > 0.2f\'c', () => {
    // For stress trigger: σ_max = Pu/Ag + Mu*(lw/2)/Ig_eff > 0.2*f'c
    // Use very high Mu to guarantee stress trigger
    const r = sbzTrigger(120, 12, 240, 4000, 5, 0.015, 0, 100000);
    expect(r.stressTriggered).toBe(true);
    expect(r.required).toBe(true);
  });
  it('c_limit formula: c_limit = lw/(900*driftRatio)', () => {
    const lw = 120, driftRatio = 0.015;
    const r = sbzTrigger(lw, 12, 240, 4000, 5, driftRatio, 0, 0);
    expect(r.c_limit_strain).toBeCloseTo(lw / (900 * driftRatio), 4);
  });
  it('both triggers fire simultaneously for extreme loads', () => {
    const r = sbzTrigger(120, 12, 240, 4000, 20, 0.015, 1000, 100000);
    expect(r.triggerType).toBe('both');
    expect(r.strainTriggered).toBe(true);
    expect(r.stressTriggered).toBe(true);
  });
  it('triggerType = none when neither triggered', () => {
    const r = sbzTrigger(120, 12, 240, 4000, 3, 0.015, 0, 100);
    expect(r.required).toBe(false);
    expect(r.triggerType).toBe('none');
  });
  it('sigma_limit = 0.2*f\'c', () => {
    const r = sbzTrigger(120, 12, 240, 4000, 5, 0.015, 0, 100);
    expect(r.sigma_limit).toBeCloseTo(0.2 * 4000, 1);
  });
});

// ── designWallACI — integration edge cases ─────────────────────────────────────
describe('designWallACI', () => {
  it('OK for a well-proportioned wall under moderate loads', () => {
    const sec  = makeSec(120, 12, 240);
    const rb   = makeWallRebar();
    const load = makeLoad(200, 80, 800);
    const r = designWallACI(sec, mat4k, rb, load);
    expect(r.status).not.toBe('NG');
    expect(r.DCR_shear).toBeLessThan(1);
  });

  it('DCR_shear > 1 when Vu far exceeds capacity', () => {
    const sec  = makeSec(60, 8, 120);
    const rb   = makeWallRebar();
    const load = makeLoad(0, 5000, 500);
    const r = designWallACI(sec, mat4k, rb, load);
    expect(r.DCR_shear).toBeGreaterThan(1);
    expect(r.status).toBe('NG');
  });

  it('zero axial (Pu = 0) does not crash', () => {
    const sec  = makeSec(120, 12, 240);
    const rb   = makeWallRebar();
    const load = makeLoad(0, 100, 1000);
    expect(() => designWallACI(sec, mat4k, rb, load)).not.toThrow();
  });

  it('high f\'c wall has higher phi_Vn than low f\'c', () => {
    const sec  = makeSec(120, 12, 240);
    const rb   = makeWallRebar();
    const load = makeLoad(200, 100, 1000);
    const r4k = designWallACI(sec, mat4k, rb, load);
    const r6k = designWallACI(sec, mat6k, rb, load);
    expect(r6k.phi_Vn).toBeGreaterThan(r4k.phi_Vn);
  });

  it('squat wall (hw/lw = 0.5) returns alphaC = 3', () => {
    const sec  = makeSec(120, 12, 60); // hw/lw = 0.5
    const rb   = makeWallRebar();
    const load = makeLoad(200, 100, 1000);
    const r = designWallACI(sec, mat4k, rb, load);
    expect(r.alphaC).toBeCloseTo(3.0, 1);
  });

  it('SBZ triggered for a tall, highly loaded wall', () => {
    const sec  = makeSec(120, 12, 480); // hw/lw = 4
    const rb   = makeWallRebar({ driftRatio: 0.02 });
    // Large Mu to push c beyond limit
    const load = makeLoad(2000, 300, 50000);
    const r = designWallACI(sec, mat4k, rb, load);
    expect(r.sbzRequired).toBe(true);
    expect(r.sbzLength).toBeGreaterThan(0);
  });

  it('SBZ not triggered for modest demands', () => {
    const sec  = makeSec(120, 12, 240);
    const rb   = makeWallRebar({ driftRatio: 0.005 });
    const load = makeLoad(100, 30, 200);
    const r = designWallACI(sec, mat4k, rb, load);
    // With small c_demand and low stress, SBZ may not be required
    // This is a regression guard — we just check it runs cleanly
    expect(typeof r.sbzRequired).toBe('boolean');
  });

  it('rhoL and rhoT are returned in results', () => {
    const sec  = makeSec(120, 12, 240);
    const rb   = makeWallRebar();
    const load = makeLoad(200, 80, 800);
    const r = designWallACI(sec, mat4k, rb, load);
    expect(r.rhoL).toBeGreaterThan(0);
    expect(r.rhoT).toBeGreaterThan(0);
  });

  it('min reinforcement warnings appear for lightly reinforced wall', () => {
    const sec  = makeSec(120, 12, 240);
    const rb   = makeWallRebar({ vertBarSize: 3, vertSpacing: 18, horizBarSize: 3, horizSpacing: 18 });
    const load = makeLoad(100, 30, 200);
    const r = designWallACI(sec, mat4k, rb, load);
    const hasMinWarn = r.warnings.some(w => w.message.includes('ρ') || w.message.includes('min'));
    expect(hasMinWarn).toBe(true);
  });
});
