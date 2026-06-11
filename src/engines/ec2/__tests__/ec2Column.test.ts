import { describe, it, expect } from 'vitest';
import {
  ec2InteractionCurve, ec2MomentAtAxial, biaxialExponent, designColumnEC2,
} from '../ec2Column';
import { mRd } from '../ec2Beam';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

const KIP_TO_KN = 4.44822;
const KIPFT_TO_KNM = 1.35582;

// 400×400 mm column, 8 Ø20 (As = 2513 mm²), fck = 30 MPa.
// Imperial boundary: 400mm = 15.748", fck 30 MPa = 4351.13 psi, fyk 500 = 72519 psi
const MM = 1 / 25.4;
const rect400: SectionDimensions = {
  type: 'rectangular_column', b: 400 * MM, h: 400 * MM,
  coverClear: 40 * MM, stirrupDia: -8, // Ø8 tie
};
const mat30: MaterialProps = {
  fc: 30 / 0.00689476, fy: 500 / 0.00689476, fyt: 500 / 0.00689476,
  Es: 200000 / 0.00689476, lambdaConcrete: 1.0,
};
const rebar8d20: RebarLayout = {
  topBars: [{ numBars: 3, barSize: -20 }],
  botBars: [{ numBars: 3, barSize: -20 }],
  sideBars: [{ numBars: 2, barSize: -20 }],
  ties: { barSize: -8, spacing: 250 * MM, legs: 2 },
};

const circ500: SectionDimensions = {
  type: 'circular_column', b: 500 * MM, h: 500 * MM, diameter: 500 * MM,
  coverClear: 40 * MM, stirrupDia: -8,
};
const circRebar: RebarLayout = {
  topBars: [{ numBars: 8, barSize: -20 }],
  botBars: [],
  ties: { barSize: -8, spacing: 200 * MM, legs: 2 },
};

describe('ec2InteractionCurve — NRd,max', () => {
  it('hand-check: 400×400, 8Ø20, fck 30 → NRd,max ≈ 4242 kN', () => {
    // fcd = 30/1.5 = 20 MPa, fyd = 500/1.15 = 434.78 MPa
    // As = 8·π·100 = 2513.3 mm², Ac = 160000 mm²
    // NRd = 20·(160000−2513.3) + 2513.3·434.78 = 3149734 + 1092737 N ≈ 4242 kN
    const curve = ec2InteractionCurve(rect400, mat30, rebar8d20);
    const top = curve[curve.length - 1];
    const NRdMax_kN = top.phiPn * KIP_TO_KN;
    expect(NRdMax_kN).toBeCloseTo(4242, -1); // within ~5 kN
  });

  it('phi = 1 everywhere (EC2 has no φ)', () => {
    const curve = ec2InteractionCurve(rect400, mat30, rebar8d20);
    expect(curve.every(p => p.phi === 1)).toBe(true);
  });

  it('pure tension anchor = −As·fyd', () => {
    const curve = ec2InteractionCurve(rect400, mat30, rebar8d20);
    const Nt_kN = curve[0].phiPn * KIP_TO_KN;
    const As = 8 * Math.PI * 100; // mm²
    expect(Nt_kN).toBeCloseTo(-As * (500 / 1.15) / 1000, 0);
  });

  it('curve P≈0 moment consistent with beam mRd for the same section', () => {
    // Bottom 3Ø20 as tension steel: compare interaction curve moment at N=0
    // with the beam M_Rd — interaction includes top/side steel so it should be
    // within a loose band ABOVE the single-layer beam value.
    const curve = ec2InteractionCurve(rect400, mat30, rebar8d20);
    const M0_kipft = ec2MomentAtAxial(curve, 0);
    const M0_kNm = M0_kipft * KIPFT_TO_KNM;

    const As3 = 3 * Math.PI * 100;
    const d = 400 - 40 - 8 - 10; // cover + tie + bar/2
    const beam = mRd(As3, d, 400, 30, 20, 500 / 1.15);
    expect(M0_kNm).toBeGreaterThan(beam.MRd * 0.9);
    expect(M0_kNm).toBeLessThan(beam.MRd * 2.0); // multi-layer adds capacity
  });

  it('circular column curve is well-formed', () => {
    const curve = ec2InteractionCurve(circ500, mat30, circRebar);
    expect(curve[0].phiPn).toBeLessThan(0);
    expect(curve[curve.length - 1].phiPn).toBeGreaterThan(0);
    expect(Math.max(...curve.map(p => p.phiMn))).toBeGreaterThan(0);
  });
});

describe('biaxialExponent (§5.8.9(4))', () => {
  it('circular always 2.0', () => {
    expect(biaxialExponent(0.5, true)).toBe(2.0);
  });
  it('rect interpolation anchors: 0.1→1.0, 0.7→1.5, 1.0→2.0', () => {
    expect(biaxialExponent(0.1, false)).toBeCloseTo(1.0, 6);
    expect(biaxialExponent(0.7, false)).toBeCloseTo(1.5, 6);
    expect(biaxialExponent(1.0, false)).toBeCloseTo(2.0, 6);
    expect(biaxialExponent(0.4, false)).toBeCloseTo(1.25, 6);
  });
  it('clamps below 0.1', () => {
    expect(biaxialExponent(0.05, false)).toBe(1.0);
  });
});

describe('designColumnEC2', () => {
  const load: LoadCase = {
    id: 'LC1', label: 'ULS', Mu_pos: 0, Mu_neg: 0, Tu: 0,
    Pu: 1500 / KIP_TO_KN,           // 1500 kN
    Mux: 150 / KIPFT_TO_KNM,        // 150 kN·m
    Muy: 80 / KIPFT_TO_KNM,         // 80 kN·m
    Vu: 100 / KIP_TO_KN,            // 100 kN
  };

  it('reasonable design passes', () => {
    const r = designColumnEC2(rect400, mat30, rebar8d20, load);
    expect(r.DCR_PM).toBeGreaterThan(0);
    expect(r.DCR_PM).toBeLessThan(1);
    expect(r.status).not.toBe('NG');
    expect(r.interaction).toBeDefined();
  });

  it('NG when grossly overloaded', () => {
    const heavy = { ...load, Pu: 5000 / KIP_TO_KN, Mux: 500 / KIPFT_TO_KNM };
    const r = designColumnEC2(rect400, mat30, rebar8d20, heavy);
    expect(r.status).toBe('NG');
  });

  it('minimum eccentricity applies when moment is tiny', () => {
    // e0 = max(400/30, 20) = 20mm → MEd,min = 1500·0.020 = 30 kN·m
    const axialOnly = { ...load, Mux: 0, Muy: 0 };
    const r = designColumnEC2(rect400, mat30, rebar8d20, axialOnly);
    expect(r.DCR_PM).toBeGreaterThan(0); // not zero despite zero input moment
  });

  it('axial compression increases shear capacity (σcp term)', () => {
    const r0 = designColumnEC2(rect400, mat30, rebar8d20, { ...load, Pu: 0 });
    const r1 = designColumnEC2(rect400, mat30, rebar8d20, load);
    // Both have ties so V_Rd = min(VRds, VRdmax) — compare V_Rd,c instead
    expect(r1.Vc).toBeGreaterThan(r0.Vc);
  });

  it('detailing: As,min governs with high axial', () => {
    const skinny: RebarLayout = {
      topBars: [{ numBars: 2, barSize: -10 }],
      botBars: [{ numBars: 2, barSize: -10 }],
      ties: { barSize: -8, spacing: 200 * MM, legs: 2 },
    };
    const r = designColumnEC2(rect400, mat30, skinny, load);
    expect(r.warnings.some(w => w.code.includes('9.5.2'))).toBe(true);
  });

  it('circular EC2 column designs successfully', () => {
    const r = designColumnEC2(circ500, mat30, circRebar, {
      ...load, Pu: 2000 / KIP_TO_KN, Mux: 120 / KIPFT_TO_KNM, Muy: 90 / KIPFT_TO_KNM,
    });
    expect(r.phi_Pn_max).toBeGreaterThan(0);
    expect(r.DCR_PM).toBeGreaterThan(0);
  });

  it('transverse spacing check fires when too wide', () => {
    const wide: RebarLayout = { ...rebar8d20, ties: { barSize: -8, spacing: 500 * MM, legs: 2 } };
    const r = designColumnEC2(rect400, mat30, wide, load);
    expect(r.warnings.some(w => w.code.includes('9.5.3(3)'))).toBe(true);
  });
});
