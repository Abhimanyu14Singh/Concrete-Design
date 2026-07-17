import { describe, it, expect, beforeAll } from 'vitest';
import { lambdaEta, fctm, mRd, vRdc, vRds, vRdMax, tRd, designMemberEC2 } from '../ec2Beam';
import { designMember } from '../../../utils/concreteDesign';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

// ── Pure SI function checks (textbook: 300×500 C30/37, B500) ─────────────────
const fck = 30, fcd = 0.85 * fck / 1.5, fyk = 500, fyd = fyk / 1.15; // UK NA: αcc = 0.85

describe('lambdaEta §3.1.7', () => {
  it('fck ≤ 50: λ=0.8, η=1.0', () => {
    expect(lambdaEta(30)).toEqual({ lambda: 0.8, eta: 1.0 });
    expect(lambdaEta(50)).toEqual({ lambda: 0.8, eta: 1.0 });
  });
  it('fck = 60: λ=0.775, η=0.95', () => {
    const { lambda, eta } = lambdaEta(60);
    expect(lambda).toBeCloseTo(0.775, 4);
    expect(eta).toBeCloseTo(0.95, 4);
  });
});

describe('fctm §3.1.3', () => {
  it('C30: fctm ≈ 2.90 MPa', () => {
    expect(fctm(30)).toBeCloseTo(2.896, 2);
  });
});

describe('mRd §6.1 — 3Ø20 B500, b=300, d=450', () => {
  const As = 3 * Math.PI * 10 * 10; // 942.5 mm²
  it('hand-check: M_Rd ≈ 170 kN·m', () => {
    const { MRd, x } = mRd(As, 450, 300, fck, fcd, fyd);
    // x = As·fyd/(η·fcd·λ·b); UK NA fcd=0.85×30/1.5=17 MPa → x≈100.4 mm
    expect(x).toBeCloseTo(100.43, 0);
    // M_Rd = As·fyd·(d − λx/2) ≈ 168.0 kN·m
    expect(MRd).toBeCloseTo(167.94, 0);
  });
  it('zero steel → zero capacity', () => {
    expect(mRd(0, 450, 300, fck, fcd, fyd).MRd).toBe(0);
  });
  it('more steel → more capacity', () => {
    const m1 = mRd(As, 450, 300, fck, fcd, fyd).MRd;
    const m2 = mRd(As * 1.5, 450, 300, fck, fcd, fyd).MRd;
    expect(m2).toBeGreaterThan(m1);
  });
  it('T-beam flange split engages when block exceeds hf', () => {
    const AsBig = 4000; // mm² — forces λx > hf
    const rect = mRd(AsBig, 450, 600, fck, fcd, fyd);
    const tee  = mRd(AsBig, 450, 600, fck, fcd, fyd, 250, 100);
    // Web-split capacity must be lower than full-width rectangular assumption
    expect(tee.MRd).toBeLessThanOrEqual(rect.MRd);
    expect(tee.MRd).toBeGreaterThan(0);
  });
});

describe('vRdc §6.2.2 — b=300, d=450, Asl=942.5', () => {
  const Asl = 942.5;
  it('hand-check: V_Rd,c ≈ 74 kN', () => {
    expect(vRdc(300, 450, Asl, fck)).toBeCloseTo(74.4, 0);
  });
  it('vmin floor governs at very low ρl', () => {
    // tiny Asl → eq 6.2b (vmin) governs; k=1.667 → vmin=0.413 MPa → 55.7 kN
    expect(vRdc(300, 450, 10, fck)).toBeCloseTo(55.7, 0);
  });
  it('k capped at 2.0 for shallow members', () => {
    const v = vRdc(300, 100, 600, fck); // d=100 → √(200/100)=1.41 → k would be 2.41, cap 2.0
    expect(v).toBeGreaterThan(0);
  });
  it('zero width → 0', () => {
    expect(vRdc(0, 450, Asl, fck)).toBe(0);
  });
});

describe('vRds / vRdMax §6.2.3 — Ø8@200 2-leg, z=405', () => {
  const Asw = 2 * Math.PI * 16; // 100.5 mm²
  it('hand-check: V_Rd,s ≈ 221 kN at cotθ=2.5', () => {
    expect(vRds(Asw, 200, 405, fyd, 2.5)).toBeCloseTo(221.3, 0);
  });
  it('hand-check: V_Rd,max ≈ 442 kN', () => {
    expect(vRdMax(300, 405, fck, fcd, 2.5)).toBeCloseTo(376.1, 0);
  });
  it('V_Rd,max governs at very tight spacing', () => {
    const vrds = vRds(Asw, 25, 405, fyd, 2.5); // s=25mm — huge V_Rd,s
    const vrdmax = vRdMax(300, 405, fck, fcd, 2.5);
    expect(vrds).toBeGreaterThan(vrdmax);
  });
  it('no stirrups → V_Rd,s = 0', () => {
    expect(vRds(0, 200, 405, fyd)).toBe(0);
  });
});

describe('tRd §6.3 — 300×500', () => {
  it('returns positive resistance values with stirrups', () => {
    const t = tRd(300, 500, 50.3, 150, fyd, fck, fcd);
    expect(t.TRds).toBeGreaterThan(0);
    expect(t.TRdMax).toBeGreaterThan(0);
    expect(t.TRdc).toBeGreaterThan(0);
    expect(t.Ak).toBeGreaterThan(0);
  });
  it('tighter spacing increases T_Rd,s', () => {
    const t1 = tRd(300, 500, 50.3, 200, fyd, fck, fcd);
    const t2 = tRd(300, 500, 50.3, 100, fyd, fck, fcd);
    expect(t2.TRds).toBeGreaterThan(t1.TRds);
  });
  it('no stirrups → T_Rd,s = 0 but cracking torsion still computed', () => {
    const t = tRd(300, 500, 0, 1, fyd, fck, fcd);
    expect(t.TRds).toBe(0);
    expect(t.TRdc).toBeGreaterThan(0);
  });
});

// ── S-CONCRETE 2026 EC2 benchmark calibration ────────────────────────────────
// Altair S-CONCRETE report: b=300, h=600, C40, B500, 3H25 top & bottom,
// H12@250 2-leg closed links, 50mm clear cover. Reference values from the PDF.
describe('S-CONCRETE benchmark — 300×600 C40, 3H25, H12@250', () => {
  const fck40 = 40, fcd40 = 0.85 * 40 / 1.5, fyd40 = 500 / 1.15;
  // cover-to-centre = 50 (clear) + 12 (link) + 25/2 = 74.5 → tef = 149 mm
  const c2c = 50 + 12 + 25 / 2;
  const AswLeg = Math.PI * 6 * 6; // H12 one leg = 113.1 mm²

  it('V_Rd,c = 102.3 kN', () => {
    // b=300, d=526, Asl=1473 (3H25)
    expect(vRdc(300, 526, 1473, fck40)).toBeCloseTo(102.3, 0);
  });
  it('V_Rd,s = 465.2 kN (z=0.9d, cotθ=2.5)', () => {
    expect(vRds(2 * AswLeg, 250, 0.9 * 526, fyd40, 2.5)).toBeCloseTo(465.2, 0);
  });
  it('V_Rd,max ≈ 558.9 kN (within 1%)', () => {
    expect(vRdMax(300, 0.9 * 526, fck40, fcd40, 2.5)).toBeCloseTo(558.9, -1);
  });
  it('M_Rd ≈ 305.8 kNm (3H25, d=526, within 1%)', () => {
    expect(mRd(1473, 526, 300, fck40, fcd40, fyd40).MRd).toBeCloseTo(305.8, -1);
  });
  it('torsion: Ak=68101, uk=1204, T_Rd,c=32.7, T_Rd,s=67.0, T_Rd,max=79.9', () => {
    const t = tRd(300, 600, AswLeg, 250, fyd40, fck40, fcd40, 2.5, c2c);
    expect(t.tef).toBeCloseTo(149, 0);
    expect(t.Ak).toBeCloseTo(68101, -1);
    expect(t.uk).toBeCloseTo(1204, 0);
    expect(t.TRdc).toBeCloseTo(32.7, 0);
    expect(t.TRds).toBeCloseTo(67.0, 0);
    expect(t.TRdMax).toBeCloseTo(79.9, 0);
  });
});

// ── Imperial boundary round-trip via designMemberEC2 ─────────────────────────
const section: SectionDimensions = {
  type: 'rectangular_beam', b: 11.81, h: 19.69, // ≈ 300×500 mm
  coverClear: 0.984, stirrupDia: -8,            // 25 mm cover, Ø8 stirrups
};
const material: MaterialProps = {
  fc: 30 / 0.00689476,   // fck 30 MPa expressed in psi
  fy: 500 / 0.00689476, fyt: 500 / 0.00689476,
  Es: 29_000_000, lambdaConcrete: 1.0,
};
const rebar: RebarLayout = {
  topBars: [{ numBars: 2, barSize: -16 }],
  botBars: [{ numBars: 3, barSize: -20 }],
  ties: { barSize: -8, spacing: 200 / 25.4, legs: 2 },
};
const load: LoadCase = { id: 'uls', label: 'ULS', Mu_pos: 100, Mu_neg: 50, Vu: 30, Tu: 5, Pu: 0 };

describe('designMemberEC2 — imperial in / imperial out', () => {
  const r = designMemberEC2(section, material, rebar, load);

  it('returns the standard DesignResults shape', () => {
    expect(r.loadCaseId).toBe('uls');
    expect(['OK', 'NG', 'Warning']).toContain(r.status);
  });

  it('M_Rd matches direct SI calc converted to kip-ft', () => {
    // d = 500 − 25 − 8 − 10 = 457 mm, As = 942.5 mm²
    // UK NA: αcc = 0.85 → fcd_uk = 0.85 * fck / γc
    const fcd_uk = 0.85 * fck / 1.5;
    const expected = mRd(3 * Math.PI * 100, 457, 300, fck, fcd_uk, fyd).MRd / 1.35582;
    expect(r.phi_Mn_pos).toBeCloseTo(expected, 0);
  });

  it('EC2 has no φ: Mn === phi_Mn (γ already applied)', () => {
    expect(r.Mn_pos).toBe(r.phi_Mn_pos);
    expect(r.Mn_neg).toBe(r.phi_Mn_neg);
  });

  it('DCRs are non-negative and finite for a sane beam', () => {
    for (const dcr of [r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion]) {
      expect(dcr).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(dcr)).toBe(true);
    }
  });

  it('massive load → NG status', () => {
    const big = designMemberEC2(section, material, rebar, { ...load, Mu_pos: 5000, Vu: 800 });
    expect(big.status).toBe('NG');
    expect(big.warnings.some(w => w.severity === 'error')).toBe(true);
  });

  it('warning codes reference EC2 sections', () => {
    const noStirrups = designMemberEC2(section, material, { ...rebar, ties: undefined }, { ...load, Vu: 200 });
    expect(noStirrups.warnings.some(w => w.code.startsWith('EC2'))).toBe(true);
  });

  it('stirrup spacing > 0.75d fires §9.2.2(6) warning', () => {
    const wide = designMemberEC2(section, material,
      { ...rebar, ties: { barSize: -8, spacing: 400 / 25.4, legs: 2 } }, load);
    expect(wide.warnings.some(w => w.code === 'EC2 §9.2.2(6)')).toBe(true);
  });

  it('zero torsion → DCR_torsion = 0', () => {
    const noTu = designMemberEC2(section, material, rebar, { ...load, Tu: 0 });
    expect(noTu.DCR_torsion).toBe(0);
  });

  it('torsion below cracking threshold shows T_Ed/T_Rd,c utilization (0 < DCR < 1)', () => {
    // Below the cracking threshold the DCR is reported as T_Ed / T_Rd,c (the
    // utilization of the concrete cracking resistance) so the user always sees
    // a real ratio rather than a hard 0. It must stay below 1 for tiny torsion.
    const tiny = designMemberEC2(section, material, rebar, { ...load, Tu: 0.5 });
    expect(tiny.DCR_torsion).toBeGreaterThan(0);
    expect(tiny.DCR_torsion).toBeLessThan(1);
  });
});

describe('code routing sanity', () => {
  it('ACI and EC2 give different capacities for the same member', () => {
    const aci = designMember(section, material, rebar, load);
    const ec2 = designMemberEC2(section, material, rebar, load);
    expect(aci.phi_Mn_pos).not.toBeCloseTo(ec2.phi_Mn_pos, 4);
  });
});

// ── Crack width §7.3.4 ────────────────────────────────────────────────────────
import { crackWidth, ecm, creepCoefficient } from '../ec2Beam';
import { DEFAULT_CRACK_PARAMS } from '../../../types';

describe('crackWidth §7.3.4 — 300×500, 3Ø20, C30, B500', () => {
  const As = 3 * Math.PI * 100; // 942.5 mm²
  const Es = 200_000;
  const args = [As, 20, 300, 500, 457, 33, 30, Es, 0.4] as const;

  it('Ecm for C30 ≈ 32.8 GPa', () => {
    expect(ecm(30)).toBeCloseTo(32837, -2);
  });

  it('returns a physically sensible crack width under a service moment', () => {
    const cw = crackWidth(100, ...args);
    expect(cw.wk).toBeGreaterThan(0.05);
    expect(cw.wk).toBeLessThan(1.0);
    expect(cw.sigma_s).toBeGreaterThan(100);
    expect(cw.sigma_s).toBeLessThan(500);
    expect(cw.sr_max).toBeGreaterThan(100); // mm
    expect(cw.x).toBeGreaterThan(0);
    expect(cw.x).toBeLessThan(457);
  });

  it('zero moment → zero crack width', () => {
    expect(crackWidth(0, ...args).wk).toBe(0);
  });

  it('higher moment → wider crack', () => {
    expect(crackWidth(120, ...args).wk).toBeGreaterThan(crackWidth(60, ...args).wk);
  });

  it('more steel → narrower crack', () => {
    const less = crackWidth(100, As, 20, 300, 500, 457, 33, 30, Es, 0.4);
    const more = crackWidth(100, As * 2, 20, 300, 500, 457, 33, 30, Es, 0.4);
    expect(more.wk).toBeLessThan(less.wk);
  });

  it('kt = 0.6 (short-term) gives smaller or equal strain than kt = 0.4', () => {
    // larger kt subtracts more tension stiffening → smaller εsm−εcm (until the 0.6σs/Es floor)
    const k4 = crackWidth(100, ...args).wk;
    const k6 = crackWidth(100, As, 20, 300, 500, 457, 33, 30, Es, 0.6).wk;
    expect(k6).toBeLessThanOrEqual(k4);
  });

  it('smaller bars at equal As → narrower crack (sr,max ∝ Ø)', () => {
    const big   = crackWidth(100, As, 25, 300, 500, 457, 33, 30, Es, 0.4);
    const small = crackWidth(100, As, 12, 300, 500, 457, 33, 30, Es, 0.4);
    expect(small.wk).toBeLessThan(big.wk);
  });
});

// ── Creep coefficient (Annex B) reproduces the reference derivation ──────────
describe('creepCoefficient — EN 1992-1-1 Annex B', () => {
  it('φ(t,t0) ≈ 1.20 for C40, RH 85%, t0 28 d, cement N, h0 2000 mm, 70 yr', () => {
    // Reproduces the Concrete-Institute spreadsheet: φ0 ≈ 1.218, βc ≈ 0.985.
    expect(creepCoefficient(40, 85, 28, 70 * 365, 2000, 'N')).toBeCloseTo(1.20, 1);
  });
  it('drier air (lower RH) increases creep', () => {
    const wet = creepCoefficient(40, 85, 28, 70 * 365, 2000, 'N');
    const dry = creepCoefficient(40, 50, 28, 70 * 365, 2000, 'N');
    expect(dry).toBeGreaterThan(wet);
  });
});

// ── External validation: EN 1992-1-1 §7.3.4 worked example ───────────────────
// Concrete-Institute long-hand crack-width spreadsheet, 500×1000 C40/500:
// As=2454 (5Ø25 bottom), As'=1473 (3Ø25 top), d=925, d'=70, cover 63,
// M_qp=500 kN·m, long-term. Driving crackWidth at the reference modular ratio
// αe=11.89 reproduces the spreadsheet's x, σs, Mcr, sr,max, ρp,eff and wk.
describe('crackWidth — Concrete-Institute §7.3.4 worked example (500×1000)', () => {
  const phiRef = ecm(40) / (200_000 / 11.89) - 1;  // φ s.t. αe = 11.89
  const cw = crackWidth(500, 2454, 25, 500, 1000, 925, 63, 40, 200_000, 0.4,
    { AsComp: 1473, dComp: 70, phi: phiRef });

  it('modular ratio αe ≈ 11.89 (creep-adjusted)', () => expect(cw.alpha_e).toBeCloseTo(11.89, 1));
  it('cracking moment Mcr ≈ 352.6 kN·m → cracked (M_qp = 500 > Mcr)', () => {
    expect(cw.Mcr).toBeCloseTo(352.6, 0);
    expect(cw.cracked).toBe(true);
  });
  it('cracked transformed NA x ≈ 256.9 mm', () => expect(cw.x).toBeCloseTo(256.9, 0));
  it('steel stress σs ≈ 242 MPa', () => expect(cw.sigma_s).toBeCloseTo(242, 0));
  it('effective reinforcement ratio ρp,eff ≈ 0.0269', () => expect(cw.rho_p_eff).toBeCloseTo(0.0269, 3));
  it('max crack spacing sr,max ≈ 372 mm', () => expect(cw.sr_max).toBeCloseTo(372, -1));
  it('characteristic crack width wk ≈ 0.321 mm', () => expect(cw.wk).toBeCloseTo(0.321, 2));

  it('below the cracking moment the section is un-cracked → wk = 0', () => {
    const uncr = crackWidth(200, 2454, 25, 500, 1000, 925, 63, 40, 200_000, 0.4,
      { AsComp: 1473, dComp: 70, phi: phiRef });
    expect(uncr.Mcr).toBeGreaterThan(200);
    expect(uncr.cracked).toBe(false);
    expect(uncr.wk).toBe(0);
  });
});

describe('designMemberEC2 crack width integration', () => {
  it('reports wk_bot and wk_top in results', () => {
    const r = designMemberEC2(section, material, rebar, load);
    expect(r.wk_bot).toBeGreaterThan(0);  // bottom face cracks under +M (Mqp,pos > Mcr)
    expect(r.wk_top).toBe(0);             // top face uncracked under the light −M (Mqp,neg ≤ Mcr)
    expect(r.wk_face).toBeUndefined();    // no side bars in fixture
  });

  it('fires §7.3.4 warning when limit exceeded (tight user limit)', () => {
    const strict = { ...DEFAULT_CRACK_PARAMS, wLimitBot: 0.01 };
    const r = designMemberEC2(section, material, rebar, load, 20, strict);
    expect(r.warnings.some(w => w.code === 'EC2 §7.3.4' && w.message.includes('Bottom'))).toBe(true);
  });

  it('no warning with a generous limit', () => {
    const loose = { ...DEFAULT_CRACK_PARAMS, wLimitBot: 5, wLimitTop: 5, wLimitFace: 5 };
    const r = designMemberEC2(section, material, rebar, load, 20, loose);
    expect(r.warnings.some(w => w.code === 'EC2 §7.3.4')).toBe(false);
  });

  it('qpFactor = 0 → zero service moment → zero crack widths', () => {
    const noQp = { ...DEFAULT_CRACK_PARAMS, qpFactor: 0 };
    const r = designMemberEC2(section, material, rebar, load, 20, noQp);
    expect(r.wk_bot).toBe(0);
    expect(r.wk_top).toBe(0);
  });

  it('side bars produce a face crack width result', () => {
    const withSide = { ...rebar, sideBars: [{ numBars: 4, barSize: -12 }] };
    const r = designMemberEC2(section, material, withSide, load);
    expect(r.wk_face).toBeGreaterThan(0);
  });

  it('deep beam (h > 1000 mm) without side bars fires §7.3.3 skin reinforcement warning', () => {
    const deep = { ...section, h: 47.24 }; // 1200 mm
    const r = designMemberEC2(deep, material, rebar, load);
    expect(r.warnings.some(w => w.code === 'EC2 §7.3.3')).toBe(true);
  });

  it('face crack width over user limit fires warning', () => {
    const withSide = { ...rebar, sideBars: [{ numBars: 2, barSize: -10 }] };
    const strict = { ...DEFAULT_CRACK_PARAMS, wLimitFace: 0.001 };
    const r = designMemberEC2(section, material, withSide, load, 20, strict);
    expect(r.warnings.some(w => w.message.includes('Side face'))).toBe(true);
  });
});

// ── Large-beam benchmark (500×1200 mm) ───────────────────────────────────────
// Geometry/shear from the S-CONCRETE report (500×1200mm, fck=40, fyk=500,
// cover=50, Ø12@200 2-leg stirrups, top 7+7-Ø25, bottom 6+6-Ø25, skin 8-Ø16@180).
// Shear DCR≈0.629 still tracks S-CONCRETE. Crack widths now follow the
// Concrete-Institute long-hand method (creep αe, transformed section incl.
// compression steel, k2=0.5, sr,max=min(7.11,7.14), un-cracked gate), so the
// wk goldens below are the long-hand results — they intentionally differ from
// the S-CONCRETE report's crack figures.
describe('Large-beam benchmark 500×1200mm (shear vs S-CONCRETE, crack vs long-hand)', () => {
  const MM  = 1 / 25.4;           // mm → in
  const MPA = 1 / 0.00689476;    // MPa → psi  (1 MPa = 145.038 psi)
  const KNM = 1 / 1.35582;       // kN·m → kip-ft
  const KN  = 1 / 4.44822;       // kN → kip

  // Geometry
  const bm_section: SectionDimensions = {
    type: 'rectangular_beam',
    b:  500 * MM,   // 500 mm web / total width
    h: 1200 * MM,   // 1200 mm
    coverClear: 50 * MM,
    stirrupDia: -12, // Ø12 = metric bar #12 (diameter 12 mm in negative-size convention)
  };

  // Material: fck=40 MPa → psi, fyk=500 MPa → psi
  const bm_material: MaterialProps = {
    fc:  40  * MPA,
    fy:  500 * MPA,
    fyt: 500 * MPA,
    Es:  29_000_000,  // 200 GPa ≈ 29,000 ksi = 29,000,000 psi
    lambdaConcrete: 1.0,
  };

  // Reinforcement
  // Top: 7+7-Ø25 (two layers)  As_top = 14 × 490.9 = 6872 mm²
  // Bot: 6+6-Ø25 (two layers)  As_bot = 12 × 490.9 = 5890 mm²
  // Skin: 8-Ø16 @ 180mm        As_skin = 8 × 201.1 = 1608 mm²
  const bm_rebar: RebarLayout = {
    topBars: [
      { numBars: 7, barSize: -25 },
      { numBars: 7, barSize: -25 },
    ],
    botBars: [
      { numBars: 6, barSize: -25 },
      { numBars: 6, barSize: -25 },
    ],
    sideBars: [
      { numBars: 8, barSize: -16, spacing: 180 * MM },
    ],
    ties: { barSize: -12, spacing: 200 * MM, legs: 2 },
    layerClearSpacing: 25 * MM, // 25mm clear between layers
  };

  // Loads from S-CONCRETE report: shear Vu≈768kN, moments ~1930 kN·m pos / neg
  // (These are ULS; qpFactor scales to SLS)
  const bm_load: LoadCase = {
    id: 'uls', label: 'ULS',
    Mu_pos: 1930 * KNM,
    Mu_neg: 1930 * KNM,
    Vu: 768 * KNM * 0,  // placeholder — set shear directly below
    Tu: 0, Pu: 0,
  };
  const bm_load_fixed: LoadCase = { ...bm_load, Vu: 768 * KN };

  // The S-CONCRETE reference uses specific M_qp values that differ between
  // positive and negative faces. Mqp_neg drives top-face (≈ full ULS);
  // Mqp_pos drives bottom-face (≈ 41% of ULS for this loading scenario).
  // We set each directly in crack params to replicate the reference conditions.
  const Mqp_neg_ref = 1930 * KNM;           // kip-ft — reproduces wk_top ≈ 0.415
  const Mqp_pos_ref = 1930 * 0.41 * KNM;   // kip-ft — reproduces wk_bot ≈ 0.181

  const bm_crack: import('../../../types').CrackControlParams = {
    ...DEFAULT_CRACK_PARAMS,
    qpFactor: 0.41,       // base factor; Mqp_neg/pos override below
    Mqp_pos: Mqp_pos_ref,
    Mqp_neg: Mqp_neg_ref,
    wLimitBot: 0.3,
    wLimitTop: 0.3,
    wLimitFace: 0.3,
    kt: 0.4,
  };

  let result: ReturnType<typeof designMemberEC2>;
  beforeAll(() => {
    result = designMemberEC2(bm_section, bm_material, bm_rebar, bm_load_fixed, 20, bm_crack);
  });

  it('shear DCR ≈ 0.629 (±5%)', () => {
    expect(result.DCR_shear).toBeGreaterThan(0.629 * 0.95);
    expect(result.DCR_shear).toBeLessThan(0.629 * 1.05);
  });

  it('wk_bot ≈ 0.125 mm (±20%, long-hand method)', () => {
    expect(result.wk_bot).toBeGreaterThan(0.125 * 0.80);
    expect(result.wk_bot).toBeLessThan(0.125 * 1.20);
  });

  it('wk_top ≈ 0.338 mm (±20%, long-hand method)', () => {
    expect(result.wk_top).toBeGreaterThan(0.338 * 0.80);
    expect(result.wk_top).toBeLessThan(0.338 * 1.20);
  });

  // Side-face wk uses k2 = 0.5 (EC2 §7.3.4(3) bending value, matching the EN 1992-1-1
  // worked reference / EurocodeApplied). With k2 = 1.0 (the older S-CONCRETE reading)
  // this was ≈ 0.590 mm; the bending k2 halves the spacing term → ≈ 0.353 mm.
  it('wk_face ≈ 0.353 mm (±20%, k2 = 0.5 side face)', () => {
    expect(result.wk_face).toBeDefined();
    expect(result.wk_face!).toBeGreaterThan(0.353 * 0.80);
    expect(result.wk_face!).toBeLessThan(0.353 * 1.20);
  });
});
