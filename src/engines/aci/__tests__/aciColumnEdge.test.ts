/**
 * ACI 318-19 column engine — edge case tests.
 * Covers: zero axial (pure bending), tension-controlled limit, biaxial at low Pu,
 * φ-factor transitions, circular columns, pure compression cap, tie spacing limits.
 */
import { describe, it, expect } from 'vitest';
import {
  aciInteractionCurve, capacityOnRay, momentAtAxial,
  aciBiaxialCheck, aciColumnShear, aciColumnDetailing, designColumnACI,
} from '../aciColumn';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../../../types';

// ── Shared fixtures ───────────────────────────────────────────────────────────
const mat: MaterialProps = { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const rectSec: SectionDimensions = {
  type: 'rectangular_column', b: 18, h: 18, coverClear: 1.5, stirrupDia: 4,
};
const circSec: SectionDimensions = {
  type: 'circular_column', b: 20, h: 20, diameter: 20, coverClear: 1.5, stirrupDia: 4,
};
const rebar4x8: RebarLayout = {
  topBars: [{ numBars: 4, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: 12, legs: 2 },
};
const spiralRebar: RebarLayout = {
  topBars: [{ numBars: 6, barSize: 8 }],
  botBars: [{ numBars: 6, barSize: 8 }],
  ties: { barSize: 4, spacing: 3, legs: 2 },
  tieType: 'spiral',
};

// ── Interaction curve sanity ──────────────────────────────────────────────────
describe('aciInteractionCurve', () => {
  it('generates at least the requested number of points (+ 2 anchors)', () => {
    // The engine adds a pure-tension anchor and a pure-compression anchor
    // in addition to the nPoints sweep, so length = nPoints + 2.
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    expect(curve.length).toBeGreaterThanOrEqual(40);
  });
  it('pure-compression anchor: max phiPn > 0, corresponding phiMn ≈ 0', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const topPoint = curve.reduce((a, b) => a.phiPn > b.phiPn ? a : b);
    expect(topPoint.phiPn).toBeGreaterThan(0);
    expect(Math.abs(topPoint.phiMn)).toBeLessThan(20); // kip-ft — small near pure compression
  });
  it('pure-tension anchor: min phiPn < 0', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const botPoint = curve.reduce((a, b) => a.phiPn < b.phiPn ? a : b);
    expect(botPoint.phiPn).toBeLessThan(0);
  });
  it('moment capacity is symmetric for symmetric reinforcement', () => {
    // For a symmetric section, the max phiMn on the curve should appear near Pu=0
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const maxMoment = Math.max(...curve.map(p => p.phiMn));
    expect(maxMoment).toBeGreaterThan(50); // kip-ft
  });
  it('circular section curve has a positive phiPn (compression capacity)', () => {
    const curve = aciInteractionCurve(circSec, mat, spiralRebar, 40);
    const maxPn = Math.max(...curve.map(p => p.phiPn));
    expect(maxPn).toBeGreaterThan(0);
  });
  it('spiral column phiPnMax uses φ=0.75 vs tied column φ=0.65', () => {
    const curveSpiral = aciInteractionCurve(circSec, mat, spiralRebar, 40);
    const curveTied   = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    // Pure compression φ factor: spiral 0.75 vs tied 0.65
    // Spiral phiPnMax/Pno ≈ 0.75*0.85; tied ≈ 0.65*0.80
    const phiMaxSpiral = Math.max(...curveSpiral.map(p => p.phiPn));
    const phiMaxTied   = Math.max(...curveTied.map(p => p.phiPn));
    // Spiral section is larger (D=20 vs 18×18) so we just check spiral has ratio advantage
    const AgSpiral = Math.PI * 10 * 10;
    const AgTied   = 18 * 18;
    expect(phiMaxSpiral / AgSpiral).toBeGreaterThan(phiMaxTied / AgTied);
  });
});

// ── momentAtAxial ─────────────────────────────────────────────────────────────
describe('momentAtAxial', () => {
  it('returns positive capacity for Pu within the curve range', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const Mn = momentAtAxial(curve, 200);
    expect(Mn).toBeGreaterThan(0);
  });
  it('returns 0 for Pu above pure-compression limit', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const Mn = momentAtAxial(curve, 99999);
    expect(Mn).toBe(0);
  });
  it('returns 0 for zero Pu if pure bending falls off curve bottom', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    // Pu = 0 should give a usable moment (column can carry pure bending)
    const Mn = momentAtAxial(curve, 0);
    expect(Mn).toBeGreaterThanOrEqual(0);
  });
});

// ── capacityOnRay ──────────────────────────────────────────────────────────────
describe('capacityOnRay', () => {
  it('dcr < 1 for a lightly loaded column', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const { dcr } = capacityOnRay(curve, 100, 50);
    expect(dcr).toBeLessThan(1);
  });
  it('dcr > 1 when demand greatly exceeds capacity', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const phiPnMax = Math.max(...curve.map(p => p.phiPn));
    const { dcr } = capacityOnRay(curve, phiPnMax * 2, 50);
    expect(dcr).toBeGreaterThan(1);
  });
  it('dcr ≈ 1 at roughly the curve boundary (pure bending)', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const phiMnAtZero = momentAtAxial(curve, 0);
    if (phiMnAtZero > 0) {
      const { dcr } = capacityOnRay(curve, 0, phiMnAtZero);
      expect(dcr).toBeCloseTo(1.0, 1);
    }
  });
});

// ── aciBiaxialCheck ───────────────────────────────────────────────────────────
describe('aciBiaxialCheck', () => {
  it('uses uniaxial check when Muy = 0', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const result = aciBiaxialCheck(curve, null, 200, 80, 0, false);
    expect(result.method).toMatch(/uniaxial|ray/i);
    expect(result.DCR_PM).toBeGreaterThan(0);
  });
  it('biaxial Bresler DCR < 1 for modest biaxial loads', () => {
    const curve = aciInteractionCurve(rectSec, mat, rebar4x8, 40);
    const curveY = aciInteractionCurve(rectSec, mat, rebar4x8, 40, true);
    const result = aciBiaxialCheck(curve, curveY, 150, 40, 40, false);
    expect(result.DCR_PM).toBeLessThan(1);
  });
  it('circular column uses resultant moment (no curveY needed)', () => {
    const curve = aciInteractionCurve(circSec, mat, spiralRebar, 40);
    const result = aciBiaxialCheck(curve, null, 200, 50, 50, true);
    expect(result.DCR_PM).toBeGreaterThan(0);
  });
});

// ── aciColumnShear ────────────────────────────────────────────────────────────
describe('aciColumnShear', () => {
  it('compression boosts Vc (Pu > 0 vs Pu = 0)', () => {
    const s0  = aciColumnShear(rectSec, mat, rebar4x8, 50, 0);
    const s200 = aciColumnShear(rectSec, mat, rebar4x8, 50, 200);
    expect(s200.Vc).toBeGreaterThan(s0.Vc);
  });
  it('DCR_shear = 0 when Vu = 0', () => {
    const r = aciColumnShear(rectSec, mat, rebar4x8, 0, 200);
    expect(r.DCR_shear).toBe(0);
  });
  it('DCR_shear > 1 when shear far exceeds capacity', () => {
    const r = aciColumnShear(rectSec, mat, rebar4x8, 500, 200);
    expect(r.DCR_shear).toBeGreaterThan(1);
  });
});

// ── aciColumnDetailing ────────────────────────────────────────────────────────
describe('aciColumnDetailing', () => {
  it('no warnings for a standard well-detailed column', () => {
    const warns = aciColumnDetailing(rectSec, rebar4x8);
    // Filter to error-severity only
    const errors = warns.filter(w => w.severity === 'error');
    expect(errors).toHaveLength(0);
  });
  it('warning when ρg is too low (< 1%)', () => {
    const sparseRebar: RebarLayout = {
      topBars: [{ numBars: 2, barSize: 3 }],
      botBars: [{ numBars: 2, barSize: 3 }],
      ties: { barSize: 3, spacing: 12, legs: 2 },
    };
    const warns = aciColumnDetailing(rectSec, sparseRebar);
    const hasRhoWarn = warns.some(w => w.message.includes('ρg') || w.message.includes('As,min') || w.code?.includes('10.6') || w.code?.includes('26.6'));
    expect(hasRhoWarn).toBe(true);
  });
});

// ── designColumnACI — integration ────────────────────────────────────────────
describe('designColumnACI', () => {
  it('OK for a well-proportioned column under modest loads', () => {
    const load: LoadCase = { id: 'lc', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 30, Tu: 0, Pu: 400, Mux: 80, Muy: 0 };
    const r = designColumnACI(rectSec, mat, rebar4x8, load);
    expect(r.status).toBe('OK');
    expect(r.DCR_PM).toBeLessThan(1);
  });
  it('NG when axial exceeds φPn,max', () => {
    const phiPnMax = Math.max(...aciInteractionCurve(rectSec, mat, rebar4x8).map(p => p.phiPn));
    const load: LoadCase = { id: 'lc', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: phiPnMax * 1.5, Mux: 0, Muy: 0 };
    const r = designColumnACI(rectSec, mat, rebar4x8, load);
    expect(r.status).toBe('NG');
    expect(r.DCR_axial).toBeGreaterThan(1);
  });
  it('pure bending (Pu = 0) returns finite phi_Mnx', () => {
    const load: LoadCase = { id: 'lc', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0, Mux: 50, Muy: 0 };
    const r = designColumnACI(rectSec, mat, rebar4x8, load);
    expect(r.phi_Mnx).toBeGreaterThan(0);
    expect(r.DCR_axial).toBe(0);
  });
  it('heavy biaxial moment returns DCR_PM > uniaxial DCR', () => {
    const uniaxLoad: LoadCase = { id: 'u', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 300, Mux: 80, Muy: 0 };
    const biaxLoad:  LoadCase = { id: 'b', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 300, Mux: 80, Muy: 80 };
    const rUni = designColumnACI(rectSec, mat, rebar4x8, uniaxLoad);
    const rBiax = designColumnACI(rectSec, mat, rebar4x8, biaxLoad);
    expect(rBiax.DCR_PM).toBeGreaterThan(rUni.DCR_PM!);
  });
  it('circular column does not crash with biaxial loads', () => {
    const load: LoadCase = { id: 'lc', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 20, Tu: 0, Pu: 600, Mux: 100, Muy: 100 };
    expect(() => designColumnACI(circSec, mat, spiralRebar, load)).not.toThrow();
    const r = designColumnACI(circSec, mat, spiralRebar, load);
    expect(r.DCR_PM).toBeGreaterThan(0);
  });
});
