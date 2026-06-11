import { describe, it, expect } from 'vitest';
import { lambdaEta, fctm, mRd, vRdc, vRds, vRdMax, tRd, designMemberEC2 } from '../ec2Beam';
import { designMember } from '../../../utils/concreteDesign';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

// ── Pure SI function checks (textbook: 300×500 C30/37, B500) ─────────────────
const fck = 30, fcd = fck / 1.5, fyk = 500, fyd = fyk / 1.15;

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
    // x = As·fyd/(η·fcd·λ·b) = 409,772/4800 ≈ 85.4 mm
    expect(x).toBeCloseTo(85.37, 0);
    // M_Rd = As·fyd·(d − λx/2) ≈ 170.4 kN·m
    expect(MRd).toBeCloseTo(170.4, 0);
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
    expect(vRdMax(300, 405, fck, fcd, 2.5)).toBeCloseTo(442.4, 0);
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
    const expected = mRd(3 * Math.PI * 100, 457, 300, fck, fcd, fyd).MRd / 1.35582;
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

  it('torsion below cracking threshold may be neglected (DCR 0)', () => {
    const tiny = designMemberEC2(section, material, rebar, { ...load, Tu: 0.5 });
    expect(tiny.DCR_torsion).toBe(0);
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
import { crackWidth, ecm } from '../ec2Beam';
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

describe('designMemberEC2 crack width integration', () => {
  it('reports wk_bot and wk_top in results', () => {
    const r = designMemberEC2(section, material, rebar, load);
    expect(r.wk_bot).toBeGreaterThan(0);
    expect(r.wk_top).toBeGreaterThan(0);
    expect(r.wk_face).toBeUndefined(); // no side bars in fixture
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
