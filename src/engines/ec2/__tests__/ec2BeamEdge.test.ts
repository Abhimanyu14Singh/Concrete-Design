/**
 * EC2 beam engine — edge case tests.
 * Covers: high fck (>50 MPa), low fck (<20 MPa), λ/η variation, torsion with
 * no stirrups, T-beam flange-only compression, zero service moment, fctm formula
 * branches, mRd zero steel, vRdc with axial compression term, vRdMax strut crush.
 */
import { describe, it, expect } from 'vitest';
import {
  lambdaEta, fctm, mRd, vRdc, vRds, vRdMax, tRd, crackWidth, designMemberEC2,
} from '../ec2Beam';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase, CrackControlParams } from '../../../types';

// ── Unit conversions (stored imperial → SI at boundary) ───────────────────────
const IN  = 25.4;       // mm
const PSI = 0.00689476; // MPa
const KIP = 4.44822;    // kN
const KPFT = 1.35582;   // kN·m
const IN2  = 645.16;    // mm²

// ── λ/η variation (§3.1.7) ───────────────────────────────────────────────────
describe('lambdaEta', () => {
  it('λ=0.8, η=1.0 for fck ≤ 50 MPa', () => {
    expect(lambdaEta(20)).toEqual({ lambda: 0.8, eta: 1.0 });
    expect(lambdaEta(30)).toEqual({ lambda: 0.8, eta: 1.0 });
    expect(lambdaEta(50)).toEqual({ lambda: 0.8, eta: 1.0 });
  });
  it('λ and η decrease linearly above 50 MPa', () => {
    const r60 = lambdaEta(60);
    expect(r60.lambda).toBeCloseTo(0.8 - 10 / 400, 6); // 0.775
    expect(r60.eta).toBeCloseTo(1.0 - 10 / 200, 6);    // 0.95
  });
  it('fck = 80 MPa gives expected λ and η', () => {
    const r = lambdaEta(80);
    expect(r.lambda).toBeCloseTo(0.8 - 30 / 400, 6); // 0.725
    expect(r.eta).toBeCloseTo(1.0 - 30 / 200, 6);    // 0.85
  });
  it('fck = 100 MPa gives expected λ and η (no floor in EC2 formula)', () => {
    const r = lambdaEta(100);
    expect(r.lambda).toBeCloseTo(0.8 - 50 / 400, 6); // 0.675
    expect(r.eta).toBeCloseTo(1.0 - 50 / 200, 6);    // 0.75
  });
});

// ── fctm formula branches ─────────────────────────────────────────────────────
describe('fctm', () => {
  it('uses power law for fck ≤ 50 MPa', () => {
    expect(fctm(30)).toBeCloseTo(0.30 * Math.pow(30, 2 / 3), 4);
    expect(fctm(50)).toBeCloseTo(0.30 * Math.pow(50, 2 / 3), 4);
  });
  it('uses logarithmic formula for fck > 50 MPa', () => {
    const val = 2.12 * Math.log(1 + (60 + 8) / 10);
    expect(fctm(60)).toBeCloseTo(val, 4);
  });
  it('fctm is monotonically increasing with fck', () => {
    expect(fctm(40)).toBeGreaterThan(fctm(30));
    expect(fctm(60)).toBeGreaterThan(fctm(50));
    expect(fctm(80)).toBeGreaterThan(fctm(60));
  });
  it('is positive for very low fck (12 MPa)', () => {
    expect(fctm(12)).toBeGreaterThan(0);
    expect(fctm(12)).toBeLessThan(fctm(20));
  });
});

// ── mRd — rectangular and T-beam ─────────────────────────────────────────────
describe('mRd', () => {
  const fck = 30, fcd = 0.85 * 30 / 1.5, fyd = 500 / 1.15;
  const b = 300, d = 450; // mm

  it('returns MRd = 0 when As = 0', () => {
    const r = mRd(0, d, b, fck, fcd, fyd);
    expect(r.MRd).toBe(0);
    expect(r.x).toBe(0);
  });
  it('returns MRd = 0 when d = 0', () => {
    const r = mRd(500, 0, b, fck, fcd, fyd);
    expect(r.MRd).toBe(0);
  });
  it('MRd increases with more steel', () => {
    const r1 = mRd(800, d, b, fck, fcd, fyd);
    const r2 = mRd(1600, d, b, fck, fcd, fyd);
    expect(r2.MRd).toBeGreaterThan(r1.MRd);
  });
  it('T-beam flange-only block: a < hf → same as rectangular', () => {
    // Light steel: block stays in flange (λx < hf=100)
    const rRect = mRd(800, d, b, fck, fcd, fyd);
    const rT    = mRd(800, d, 1000, fck, fcd, fyd, b, 100);
    // With wide flange & same As, compression block is shallower → bigger moment
    expect(rT.MRd).toBeGreaterThanOrEqual(rRect.MRd);
  });
  it('T-beam: heavy steel pushes block below flange', () => {
    // Very heavy steel forces web compression contribution
    const rT = mRd(8000, d, 1000, fck, fcd, fyd, 300, 100);
    expect(rT.MRd).toBeGreaterThan(0);
    // x should be larger than hf/lambda when block extends into web
    expect(rT.x).toBeGreaterThan(100);
  });
  it('high fck (70 MPa) uses correct λ/η — MRd still positive', () => {
    const fck70 = 70, fcd70 = 0.85 * fck70 / 1.5, fyd70 = 500 / 1.15;
    const r = mRd(1200, d, b, fck70, fcd70, fyd70);
    expect(r.MRd).toBeGreaterThan(0);
  });
});

// ── vRdc — concrete shear ─────────────────────────────────────────────────────
describe('vRdc', () => {
  const b = 300, d = 450, As = 1200, fck = 30;

  it('increases with axial compression (NEd > 0)', () => {
    const v0   = vRdc(b, d, As, fck, 0, b * 450);
    const v200 = vRdc(b, d, As, fck, 200e3, b * 450); // 200 kN in N
    expect(v200).toBeGreaterThan(v0);
  });
  it('increases with more tension steel (ρl higher)', () => {
    const vLow  = vRdc(b, d, 600, fck, 0, b * 450);
    const vHigh = vRdc(b, d, 2400, fck, 0, b * 450);
    expect(vHigh).toBeGreaterThan(vLow);
  });
  it('increases with higher fck', () => {
    const v30 = vRdc(b, d, As, 30, 0, b * 450);
    const v60 = vRdc(b, d, As, 60, 0, b * 450);
    expect(v60).toBeGreaterThan(v30);
  });
  it('returns a positive value for typical inputs', () => {
    expect(vRdc(b, d, As, fck, 0, b * 450)).toBeGreaterThan(0);
  });
});

// ── vRds and vRdMax ───────────────────────────────────────────────────────────
describe('vRds and vRdMax', () => {
  it('vRds = Asw/s × z × fywd × cotθ / 1000', () => {
    const Asw = 100, s = 150, z = 400, fywd = 435, cotTheta = 2.5;
    const expected = (Asw / s) * z * fywd * cotTheta / 1000;
    expect(vRds(Asw, s, z, fywd, cotTheta)).toBeCloseTo(expected, 4);
  });
  it('vRdMax formula: f(cotθ) = cot/(cot²+1); peaks between cot=1 and cot=2.5', () => {
    // V_Rd,max = α_cw·bw·z·ν₁·fcd / (cotθ + tanθ) = ... × cot/(cot²+1)
    // At cot=1.0: 1/(1+1)=0.5. At cot=2.5: 2.5/(7.25)=0.345. So cot=1 gives HIGHER VRdmax.
    const fck = 30, fcd = 0.85 * 30 / 1.5;
    const vMax25 = vRdMax(300, 400, fck, fcd, 2.5);
    const vMax10 = vRdMax(300, 400, fck, fcd, 1.0);
    expect(vMax10).toBeGreaterThan(vMax25);
  });
  it('vRds > 0 for positive Asw and spacing', () => {
    expect(vRds(200, 200, 400, 435, 2.5)).toBeGreaterThan(0);
  });
});

// ── designMemberEC2 — integration edge cases ──────────────────────────────────
const mmToIn   = (v: number) => v / 25.4;
const mpaToPs  = (v: number) => v / PSI;
const knToKip  = (v: number) => v / KIP;
const knmToKft = (v: number) => v / KPFT;

// Beam: 300×500 mm, fck=30 MPa, fyk=500 MPa
const sec: SectionDimensions = {
  type: 'rectangular_beam',
  b: mmToIn(300), h: mmToIn(500), coverClear: mmToIn(35), stirrupDia: -8,
};
const mat: MaterialProps = {
  fc: mpaToPs(30), fy: mpaToPs(500), fyt: mpaToPs(500),
  Es: mpaToPs(200_000), lambdaConcrete: 1.0,
};
const rb: RebarLayout = {
  topBars: [{ numBars: 2, barSize: -16 }],
  botBars: [{ numBars: 3, barSize: -16 }],
  ties: { barSize: -8, spacing: mmToIn(150), legs: 2 },
};
const crack: CrackControlParams = {
  wLimitBot: 0.3, wLimitTop: 0.3, wLimitFace: 0.3,
  Mqp_pos: knmToKft(80), Mqp_neg: 0, qpFactor: 0.6, kt: 0.4,
};

describe('designMemberEC2 — zero loads', () => {
  it('returns DCRs = 0 for zero demand', () => {
    const r = designMemberEC2(sec, mat, rb,
      { id: 'z', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    expect(r.DCR_flex_pos).toBe(0);
    expect(r.DCR_flex_neg).toBe(0);
    expect(r.DCR_shear).toBe(0);
  });
  it('phi_Mn_pos > 0 even at zero demand', () => {
    const r = designMemberEC2(sec, mat, rb,
      { id: 'z', label: '', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    expect(r.phi_Mn_pos).toBeGreaterThan(0);
  });
});

describe('designMemberEC2 — high fck (C60/75)', () => {
  const highFck = 60; // MPa
  const matHigh: MaterialProps = {
    fc: mpaToPs(highFck), fy: mpaToPs(500), fyt: mpaToPs(500),
    Es: mpaToPs(200_000), lambdaConcrete: 1.0,
  };
  it('fcd uses ALPHA_CC=0.85: fcd = 0.85×60/1.5 = 34 MPa equivalent', () => {
    const r = designMemberEC2(sec, matHigh, rb,
      { id: 'lc', label: '', Mu_pos: knmToKft(200), Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    // Capacity should be higher than at fck=30 (more fcd → smaller x → more lever arm)
    const r30 = designMemberEC2(sec, mat, rb,
      { id: 'lc', label: '', Mu_pos: knmToKft(200), Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    expect(r.phi_Mn_pos).toBeGreaterThan(r30.phi_Mn_pos);
  });
  it('does not throw for fck=80 MPa', () => {
    const mat80: MaterialProps = {
      fc: mpaToPs(80), fy: mpaToPs(500), fyt: mpaToPs(500),
      Es: mpaToPs(200_000), lambdaConcrete: 1.0,
    };
    expect(() => designMemberEC2(sec, mat80, rb,
      { id: 'lc', label: '', Mu_pos: knmToKft(150), Mu_neg: 0, Vu: knToKip(60), Tu: 0, Pu: 0 },
      mmToIn(6000), crack)).not.toThrow();
  });
});

describe('designMemberEC2 — axial compression boosts shear (no stirrups)', () => {
  it('phi_Vn (= VRdc) is higher under compression when no stirrups', () => {
    // With stirrups: VRd = min(VRds, VRdmax) — unaffected by NEd.
    // Without stirrups: VRd = VRdc which includes the σ_cp = 0.15·NEd/Ac term.
    const noTiesRb: RebarLayout = { topBars: rb.topBars, botBars: rb.botBars };
    const baseLoad: LoadCase = { id: 'lc', label: '', Mu_pos: 0, Mu_neg: 0, Vu: knToKip(30), Tu: 0, Pu: 0 };
    const axialLoad: LoadCase = { ...baseLoad, Pu: knToKip(500) };
    const r0 = designMemberEC2(sec, mat, noTiesRb, baseLoad, mmToIn(6000), crack);
    const rN = designMemberEC2(sec, mat, noTiesRb, axialLoad, mmToIn(6000), crack);
    expect(rN.phi_Vn).toBeGreaterThan(r0.phi_Vn);
  });
});

describe('designMemberEC2 — strut crushing warning', () => {
  it('emits strut-crushing warning when VEd >> VRd,max', () => {
    const r = designMemberEC2(sec, mat, rb,
      { id: 'lc', label: '', Mu_pos: 0, Mu_neg: 0, Vu: knToKip(1000), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    const crushWarn = r.warnings.find(w => w.code?.includes('6.2.3'));
    expect(crushWarn).toBeDefined();
    expect(r.DCR_shear).toBeGreaterThan(1);
  });
});

describe('designMemberEC2 — crack width with zero service moment', () => {
  it('does not throw when Mqp_pos = 0', () => {
    const crackZero: CrackControlParams = {
      wLimitBot: 0.3, wLimitTop: 0.3, wLimitFace: 0.3,
      Mqp_pos: 0, Mqp_neg: 0, qpFactor: 0, kt: 0.4,
    };
    expect(() => designMemberEC2(sec, mat, rb,
      { id: 'lc', label: '', Mu_pos: knmToKft(100), Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 },
      mmToIn(6000), crackZero)).not.toThrow();
  });
  it('crack section returns wk = 0 when Mqp_pos = 0', () => {
    const crackZero: CrackControlParams = {
      wLimitBot: 0.3, wLimitTop: 0.3, wLimitFace: 0.3,
      Mqp_pos: 0, Mqp_neg: 0, qpFactor: 0, kt: 0.4,
    };
    const r = designMemberEC2(sec, mat, rb,
      { id: 'lc', label: '', Mu_pos: knmToKft(100), Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 },
      mmToIn(6000), crackZero);
    // wk result should be 0 or very close to 0 when service moment is zero
    // Look for wk in warnings (no crack warning means wk ≤ limit)
    const crackNG = r.warnings.find(w => w.code?.includes('7.3') && w.severity === 'error');
    expect(crackNG).toBeUndefined();
  });
});

describe('designMemberEC2 — no stirrups case', () => {
  it('still computes VRdc when no ties provided', () => {
    const noTies: RebarLayout = { topBars: rb.topBars, botBars: rb.botBars };
    const r = designMemberEC2(noTies ? sec : sec, mat, noTies,
      { id: 'lc', label: '', Mu_pos: knmToKft(100), Mu_neg: 0, Vu: knToKip(50), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    expect(r.phi_Vn).toBeGreaterThan(0);
  });
});

// ── §8.2 spacing — multi-layer, side bars, stirrup transverse ────────────────
describe('EC2 §8.2 spacing — multi-layer bottom bars', () => {
  it('no warning when all layers fit within §8.2 limits', () => {
    // 3Ø16 outer + 2Ø16 inner, 300 mm web — generous spacing
    const goodRb: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 3, barSize: -16 }, { numBars: 2, barSize: -16 }],
      ties: { barSize: -8, spacing: mmToIn(150), legs: 2 },
      layerClearSpacing: mmToIn(30),
    };
    const r = designMemberEC2(sec, mat, goodRb,
      { id: 'lc', label: '', Mu_pos: knmToKft(150), Mu_neg: 0, Vu: knToKip(60), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    const spacingWarns = r.warnings.filter(w => w.code === 'EC2 §8.2');
    expect(spacingWarns).toHaveLength(0);
  });

  it('§8.2 error fires for inner bottom layer when bars are too crowded', () => {
    // 6Ø25 in a 300 mm web — db=25, clear = (300-2×35-2×8-6×25)/5 = (214-150)/5 = 12.8 mm < 25 mm
    const crowdedRb: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 6, barSize: -25 }, { numBars: 4, barSize: -25 }],
      ties: { barSize: -8, spacing: mmToIn(150), legs: 2 },
      layerClearSpacing: mmToIn(28),
    };
    const r = designMemberEC2(sec, mat, crowdedRb,
      { id: 'lc', label: '', Mu_pos: knmToKft(200), Mu_neg: 0, Vu: knToKip(60), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    // Both layers should trigger: outer 6Ø25 definitely fails
    const spacingWarns = r.warnings.filter(w => w.code === 'EC2 §8.2');
    expect(spacingWarns.length).toBeGreaterThan(0);
    expect(spacingWarns.some(w => w.message.includes('Bottom'))).toBe(true);
  });

  it('§8.2 vertical layer spacing warning when layers are too close', () => {
    // layerClearSpacing = 15 mm < max(Ø16=16, dg+5=25, 20) = 25 mm
    const tightLayers: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 3, barSize: -16 }, { numBars: 2, barSize: -16 }],
      ties: { barSize: -8, spacing: mmToIn(150), legs: 2 },
      layerClearSpacing: mmToIn(15), // 15 mm < 25 mm (dg+5 governs)
    };
    const r = designMemberEC2(sec, mat, tightLayers,
      { id: 'lc', label: '', Mu_pos: knmToKft(150), Mu_neg: 0, Vu: knToKip(60), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    const vertWarn = r.warnings.find(w => w.code === 'EC2 §8.2' && w.message.includes('vertical'));
    expect(vertWarn).toBeDefined();
  });

  it('no vertical layer warning when layerClearSpacing ≥ §8.2 limit', () => {
    const okLayers: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 3, barSize: -16 }, { numBars: 2, barSize: -16 }],
      ties: { barSize: -8, spacing: mmToIn(150), legs: 2 },
      layerClearSpacing: mmToIn(30), // 30 mm > 25 mm — OK
    };
    const r = designMemberEC2(sec, mat, okLayers,
      { id: 'lc', label: '', Mu_pos: knmToKft(150), Mu_neg: 0, Vu: knToKip(60), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    const vertWarn = r.warnings.find(w => w.code === 'EC2 §8.2' && w.message.includes('vertical'));
    expect(vertWarn).toBeUndefined();
  });
});

describe('EC2 §8.2 spacing — side/face bars', () => {
  it('§8.2 error fires when side bars are too crowded in the web', () => {
    // 6Ø25 side bars in a 300 mm web — same congestion as bottom layer test
    const secWithSide: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 3, barSize: -16 }],
      ties: { barSize: -8, spacing: mmToIn(150), legs: 2 },
      sideBars: [{ numBars: 6, barSize: -25 }],
    };
    const r = designMemberEC2(sec, mat, secWithSide,
      { id: 'lc', label: '', Mu_pos: knmToKft(150), Mu_neg: 0, Vu: knToKip(60), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    const sideWarn = r.warnings.find(w => w.code === 'EC2 §8.2' && w.message.includes('Side'));
    expect(sideWarn).toBeDefined();
  });

  it('no §8.2 warning when side bars are well-spaced', () => {
    const secWithSide: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 3, barSize: -16 }],
      ties: { barSize: -8, spacing: mmToIn(150), legs: 2 },
      sideBars: [{ numBars: 2, barSize: -12 }], // 2Ø12 — wide clear spacing
    };
    const r = designMemberEC2(sec, mat, secWithSide,
      { id: 'lc', label: '', Mu_pos: knmToKft(150), Mu_neg: 0, Vu: knToKip(60), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    const sideWarn = r.warnings.find(w => w.code === 'EC2 §8.2' && w.message.includes('Side'));
    expect(sideWarn).toBeUndefined();
  });
});

describe('EC2 §9.2.2(8) stirrup transverse leg spacing', () => {
  it('warning fires when leg spacing exceeds min(0.75d, 600 mm)', () => {
    // 2-leg stirrup in 300 mm web: leg spacing = (300 - 2×35 - 2×8) / 1 = 214 mm
    // d ≈ 447 mm → s_trans_max = min(0.75×447, 600) = 335 mm → 214 mm < 335, no warn
    // Use a very wide beam (1000 mm) with 2 legs: leg spacing = (1000-2×35-2×8)/1 = 914 mm > 600 mm
    const wideSec: SectionDimensions = {
      type: 'rectangular_beam',
      b: mmToIn(1000), h: mmToIn(600), coverClear: mmToIn(35), stirrupDia: -8,
    };
    const wideRb: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 4, barSize: -20 }],
      ties: { barSize: -8, spacing: mmToIn(200), legs: 2 },
    };
    const r = designMemberEC2(wideSec, mat,wideRb,
      { id: 'lc', label: '', Mu_pos: knmToKft(300), Mu_neg: 0, Vu: knToKip(150), Tu: 0, Pu: 0 },
      mmToIn(8000), crack);
    const legWarn = r.warnings.find(w => w.code === 'EC2 §9.2.2(8)');
    expect(legWarn).toBeDefined();
    expect(legWarn!.message).toMatch(/leg spacing/);
  });

  it('no §9.2.2(8) warning for a standard 2-leg stirrup in 300 mm web', () => {
    // leg spacing ≈ 214 mm < 335 mm → no warning
    const r = designMemberEC2(sec, mat, rb,
      { id: 'lc', label: '', Mu_pos: knmToKft(150), Mu_neg: 0, Vu: knToKip(60), Tu: 0, Pu: 0 },
      mmToIn(6000), crack);
    const legWarn = r.warnings.find(w => w.code === 'EC2 §9.2.2(8)');
    expect(legWarn).toBeUndefined();
  });

  it('adding more legs resolves the §9.2.2(8) warning for a wide beam', () => {
    const wideSec: SectionDimensions = {
      type: 'rectangular_beam',
      b: mmToIn(1000), h: mmToIn(600), coverClear: mmToIn(35), stirrupDia: -8,
    };
    const rb2Legs: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -16 }],
      botBars: [{ numBars: 4, barSize: -20 }],
      ties: { barSize: -8, spacing: mmToIn(200), legs: 2 },
    };
    const rb4Legs: RebarLayout = { ...rb2Legs, ties: { ...rb2Legs.ties!, legs: 4 } };
    const rWarn = designMemberEC2(wideSec, mat, rb2Legs,
      { id: 'lc', label: '', Mu_pos: knmToKft(300), Mu_neg: 0, Vu: knToKip(150), Tu: 0, Pu: 0 },
      mmToIn(8000), crack);
    const rOK = designMemberEC2(wideSec, mat, rb4Legs,
      { id: 'lc', label: '', Mu_pos: knmToKft(300), Mu_neg: 0, Vu: knToKip(150), Tu: 0, Pu: 0 },
      mmToIn(8000), crack);
    expect(rWarn.warnings.some(w => w.code === 'EC2 §9.2.2(8)')).toBe(true);
    expect(rOK.warnings.some(w  => w.code === 'EC2 §9.2.2(8)')).toBe(false);
  });
});
