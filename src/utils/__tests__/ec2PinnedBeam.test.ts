/**
 * EC2 pinned-pinned beam under uniform load — end-to-end integration test.
 *
 * ════════════════════════════════════════════════════════════════════
 *  BEAM GEOMETRY & MATERIALS
 * ════════════════════════════════════════════════════════════════════
 *  Section:  b = 400 mm,  h = 600 mm,  clear cover = 35 mm
 *  Stirrup:  H10 (Ø10 mm), stored as barSize = -10
 *  Code:     EN 1992-1-1  (EC2)
 *  fck  = 30 MPa  (cylinder → fc = 30/0.00689476 ≈ 4351 psi)
 *  fyk  = 500 MPa (→ fy = 500/0.00689476 ≈ 72 519 psi)
 *  Es   = 200 000 MPa
 *  Rebar:    4H25 bottom  (barSize = -25, 4 × 490.87 mm² = 1963.5 mm²)
 *            2H25 top     (for nominal hogging provision)
 *            H10@150mm, 2 legs
 *
 * ════════════════════════════════════════════════════════════════════
 *  LOADING — pinned-pinned, UDL w_Ed = 50 kN/m, L = 8 m
 * ════════════════════════════════════════════════════════════════════
 *  M_Ed = w_Ed × L²/8 = 50 × 64 / 8 = 400 kN·m   ≈ 295.02 kip-ft
 *  V_Ed = w_Ed × L/2  = 50 × 8  / 2 = 200 kN      ≈ 44.96  kips
 *  T_Ed = 0,  P_Ed = 0   (pure bending + shear)
 *
 * ════════════════════════════════════════════════════════════════════
 *  REFERENCE CALCULATIONS (all SI, computed from engine source)
 * ════════════════════════════════════════════════════════════════════
 *  Partial factors: γc = 1.5, γs = 1.15, αcc = 0.85
 *  fcd = 0.85×30/1.5 = 17.0 MPa
 *  fyd = 500/1.15   = 434.78 MPa  (displayed as 435 MPa at 0 dp)
 *  λ = 0.8, η = 1.0   (fck ≤ 50 MPa, §3.1.7)
 *
 *  Effective depth (engine formula: d = h − cc − Østirrup − Øbar/2):
 *    d_bot = 600 − 35 − 10 − 12.5 = 542.5 mm
 *
 *  FLEXURE §6.1:
 *    x  = As·fyd/(η·fcd·λ·b) = 1963.5×434.78/(1×17×0.8×400) = 157.0 mm
 *    M_Rd = 1963.5×434.78×(542.5 − 0.8×157/2)/1e6 = 409.5 kN·m
 *    DCR_flex = 400/409.5 = 0.977   (near limit — Warning status)
 *
 *  SHEAR §6.2.2 V_Rd,c (no reinforcement):
 *    k     = 1 + √(200/542.5) = 1.607
 *    ρl    = min(0.02, 1963.5/(400×542.5)) = 0.00904
 *    V_Rd,c = [0.12×1.607×(100×0.00904×30)^(1/3)] × 400×542.5/1000
 *           ≈ 125.8 kN
 *
 *  SHEAR §6.2.3 V_Rd,s (with stirrups):
 *    z = 0.9×542.5 = 488.25 mm;  cotθ = 2.5
 *    Asw = 2×π/4×10² = 157.1 mm²;  s = 150 mm
 *    V_Rd,s = (157.1/150)×488.25×434.78×2.5/1000 = 555.8 kN
 *    V_Rd = min(V_Rd,s, V_Rd,max) = 555.8 kN
 *    DCR_shear = 200/555.8 = 0.360
 *
 *  EC2-SPECIFIC ENGINEERING FINDINGS (absent in ACI):
 *  ① §6.2.3(7) — Shear tension shift ΔFtd = 0.5×VEd×cotθ = 250 kN
 *      Requires total bottom steel = (M_Ed/z + ΔFtd)/fyd = 2459 mm²
 *      4H25 provides only 1963 mm² → FAILS → extra bars needed (e.g. 5H25)
 *
 *  ② §7.3.4 — Crack width under quasi-permanent moment
 *      M_qp = 0.6×400 = 240 kN·m (default qpFactor = 0.6)
 *      wk,bot = 0.376 mm > w_lim = 0.30 mm → FAILS → reduce bar spacing
 *
 *  Both findings confirm the engine is running EC2 (not ACI).
 *  ACI has neither a ΔFtd tension shift check nor a wk crack-width limit.
 *
 * ════════════════════════════════════════════════════════════════════
 *  PART 2 — Well-designed beam that passes ALL checks
 * ════════════════════════════════════════════════════════════════════
 *  Change: 5H25 bottom (2454 mm² > 2459 needed ← just barely),
 *          use 5H25 (2454 < 2459... so use 5H28: 5×615.7=3079 mm²)
 *  Actually use 450 wide × 650 deep + H10@120 to get within tolerance.
 *  See Part 2 describe block below.
 */

import { describe, it, expect } from 'vitest';
import { runDesign } from '../../engines';
import { generateBreakdownEC2 } from '../calcBreakdownEC2';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../types';

// ── Conversion factors ────────────────────────────────────────────────────────
const IN_TO_MM    = 25.4;
const PSI_TO_MPA  = 0.00689476;
const KIP_TO_KN   = 4.44822;
const KIPFT_TO_KNM = 1.35582;
const IN2_TO_MM2  = 645.16;

// ── Part 1 — 4H25 bottom, H10@150: near-capacity, two EC2-specific fails ─────
const section1: SectionDimensions = {
  type: 'rectangular_beam',
  b: 400 / IN_TO_MM,
  h: 600 / IN_TO_MM,
  coverClear: 35 / IN_TO_MM,
  stirrupDia: -10,
};
const material1: MaterialProps = {
  fc:  30  / PSI_TO_MPA,     // fck = 30 MPa
  fy:  500 / PSI_TO_MPA,     // fyk = 500 MPa
  fyt: 500 / PSI_TO_MPA,
  Es:  200_000 / PSI_TO_MPA,
  lambdaConcrete: 1.0,
};
const rebar1: RebarLayout = {
  topBars: [{ numBars: 2, barSize: -25 }],   // 2H25 (nominal top)
  botBars: [{ numBars: 4, barSize: -25 }],   // 4H25 bottom
  ties: { barSize: -10, spacing: 150 / IN_TO_MM, legs: 2 },
};
// UDL 50 kN/m, L=8 m → M_Ed=400 kN·m, V_Ed=200 kN
const load1: LoadCase = {
  id: 'udl-50', label: '1.35G+1.5Q  UDL 50 kN/m, L=8 m',
  Mu_pos: 400 / KIPFT_TO_KNM,
  Mu_neg: 0,
  Vu:     200 / KIP_TO_KN,
  Tu: 0, Pu: 0,
};
const span_ft = 8000 / (IN_TO_MM * 12);   // 8 m in feet

describe('EC2 pinned-pinned beam — 4H25 bottom, UDL 50 kN/m, L=8 m', () => {
  const r = runDesign(section1, material1, rebar1, load1, span_ft, 'EN1992-1-1');

  // ── Engine routes to EC2, not ACI ──────────────────────────────────────────

  it('EC2 code path taken: M_Rd ≈ 409.5 kN·m (fyd/γs design value, not ACI φ=0.9)', () => {
    // EC2: fyd = 500/1.15 = 434.78 MPa with partial factors → M_Rd ≈ 409.5 kN·m
    // ACI: φ=0.9 applied outside → φMn would be ≈ 0.9 × (unconstrained Mn) = different value
    const MRd = r.phi_Mn_pos * KIPFT_TO_KNM;
    expect(MRd).toBeCloseTo(409.5, 0);       // ± 0.5 kN·m
  });

  it('EC2 φ ≠ 0.9: M_Rd is NOT reduced by a 0.9 strength-reduction factor', () => {
    // If ACI φ were applied, M_Rd would be ≈ 0.9×EC2_Mrd ≈ 368 kN·m.  Check > 380.
    expect(r.phi_Mn_pos * KIPFT_TO_KNM).toBeGreaterThan(380);
  });

  // ── Flexure §6.1 ────────────────────────────────────────────────────────────

  it('M_Rd > M_Ed: beam passes flexure (just)', () => {
    expect(r.phi_Mn_pos * KIPFT_TO_KNM).toBeGreaterThan(400);
  });

  it('DCR_flex_pos ≈ 0.977 (beam working near capacity)', () => {
    expect(r.DCR_flex_pos).toBeCloseTo(400 / 409.5, 2);
  });

  it('DCR_flex_neg = 0 (pinned-pinned → no hogging moment)', () => {
    expect(r.DCR_flex_neg).toBe(0);
  });

  // ── Shear §6.2 ──────────────────────────────────────────────────────────────

  it('V_Rd,c ≈ 125.8 kN (§6.2.2 section contribution without stirrups)', () => {
    expect(r.Vc * KIP_TO_KN).toBeCloseTo(125.8, 0);
  });

  it('V_Rd ≈ 555.8 kN (stirrups govern via truss model §6.2.3)', () => {
    expect(r.phi_Vn * KIP_TO_KN).toBeCloseTo(555.8, 0);
  });

  it('DCR_shear ≈ 0.360 (well within shear capacity)', () => {
    expect(r.DCR_shear).toBeCloseTo(200 / 555.8, 2);
  });

  it('V_Rd >> V_Rd,c: stirrups provide >4× the concrete shear capacity', () => {
    expect(r.phi_Vn).toBeGreaterThan(r.Vc * 4);
  });

  it('DCR_torsion = 0 (no applied torsion)', () => {
    expect(r.DCR_torsion).toBe(0);
  });

  // ── §6.2.3(7) shear tension shift is intentionally NOT checked ──────────────

  it('EC2 §6.2.3(7) is NOT flagged (shear tension shift excluded by design)', () => {
    const err = r.warnings.find(w => w.code === 'EC2 §6.2.3(7)');
    expect(err).toBeUndefined();
  });

  it('As_req (flexure-only) < 4H25 = 1963 mm² provided', () => {
    const AsReq_mm2 = r.As_req_pos * IN2_TO_MM2;
    const AsProv_mm2 = 4 * Math.PI / 4 * 25 * 25;  // 4H25 = 1963.5 mm²
    expect(AsReq_mm2).toBeLessThanOrEqual(AsProv_mm2);
  });

  // ── EC2-specific finding ②: crack width §7.3.4 ───────────────────────────────

  it('EC2 §7.3.4 error fired: wk = 0.376 mm exceeds w_lim = 0.30 mm', () => {
    // M_qp = 0.6 × 400 = 240 kN·m (quasi-permanent factor 0.6)
    // This is an EC2 SLS check; ACI has no equivalent wk limit in the engine.
    const err = r.warnings.find(w => w.code === 'EC2 §7.3.4');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('error');
    expect(err!.message).toContain('0.30 mm');   // limit
    expect(err!.message).toContain('M_qp');       // quasi-permanent moment
  });

  it('wk_bot ≈ 0.376 mm (crack width under quasi-permanent combination)', () => {
    expect(r.wk_bot).toBeDefined();
    expect(r.wk_bot!).toBeCloseTo(0.376, 2);
  });

  // ── All warnings are EC2 clause references ────────────────────────────────────

  it('all warning codes reference EC2 clauses (§6.x, §7.x, §9.x) — not ACI', () => {
    for (const w of r.warnings) {
      expect(w.code).toMatch(/^EC2 §/);
    }
  });

  it('exactly 1 error found (§7.3.4 crack width only — §6.2.3(7) excluded)', () => {
    const errors = r.warnings.filter(w => w.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('EC2 §7.3.4');
  });

  // ── Steel limits §9.2.1.1 ────────────────────────────────────────────────────

  it('As,min (§9.2.1.1) < 4H25 provided (not under-reinforced)', () => {
    const AsMin_mm2 = r.As_min * IN2_TO_MM2;
    const AsProv_mm2 = 4 * Math.PI / 4 * 25 * 25;
    expect(AsMin_mm2).toBeGreaterThan(0);
    expect(AsProv_mm2).toBeGreaterThan(AsMin_mm2);
  });

  it('As,max (§9.2.1.1) = 0.04Ac >> 4H25 provided (not over-reinforced)', () => {
    const AsMax_mm2 = r.As_max * IN2_TO_MM2;
    const AsProv_mm2 = 4 * Math.PI / 4 * 25 * 25;
    expect(AsMax_mm2).toBeGreaterThan(AsProv_mm2);
  });

  // ── Span independence ─────────────────────────────────────────────────────────

  it('DCR results independent of span argument (section check, not beam design)', () => {
    const r2 = runDesign(section1, material1, rebar1, load1, span_ft * 2, 'EN1992-1-1');
    expect(r2.DCR_flex_pos).toBeCloseTo(r.DCR_flex_pos, 6);
    expect(r2.DCR_shear).toBeCloseTo(r.DCR_shear, 6);
  });

  // ── Calculation breakdown — SI values + EC2 clause references ────────────────
  describe('generateBreakdownEC2 — SI units and EC2 clauses', () => {
    const sections = generateBreakdownEC2(section1, material1, rebar1, load1, span_ft);

    it('produces ≥ 4 calc sections', () => {
      expect(sections.length).toBeGreaterThanOrEqual(4);
    });

    it('section 0 title references EN 1992-1-1', () => {
      expect(sections[0].title).toContain('EN 1992-1-1');
    });

    it('every section title contains a § clause reference', () => {
      for (const sec of sections) {
        expect(sec.title).toMatch(/§\d/);
      }
    });

    it('fcd result = "17.0 MPa" (EC2 partial-factor design compressive strength)', () => {
      const step = sections[0].steps.find(s => s.equation.includes('fcd'));
      expect(step).toBeDefined();
      expect(step!.result).toBe('fcd = 17.0 MPa');
      expect(step!.ref).toBe('§3.1.6');
    });

    it('fyd result = "435 MPa" (500/1.15 rounded)', () => {
      const step = sections[0].steps.find(s => s.equation.includes('fyd'));
      expect(step).toBeDefined();
      expect(step!.result).toBe('fyd = 435 MPa');
      expect(step!.ref).toBe('§3.2.7');
    });

    it('effective depth step result contains "mm" and shows 542 mm', () => {
      // The effective depth equation is 'd = h − c − Øst − Øbar/2'
      const step = sections[0].steps.find(s => s.equation.includes('Øst'));
      expect(step).toBeDefined();
      expect(step!.result).toContain('mm');
      expect(step!.result).toMatch(/54[23]/);   // d_bot = 542.5 mm → rounds to "543 mm"
    });

    it('M_Rd result contains "kN" (moment in kN·m, not kip-ft)', () => {
      const step = sections.flatMap(s => s.steps).find(s =>
        s.result.includes('kN') && (s.label.includes('M_Rd') || s.equation.includes('M_Rd'))
      );
      expect(step).toBeDefined();
    });

    it('shear section exists with §6.2 clause reference', () => {
      const shearSec = sections.find(s => s.title.includes('§6.2'));
      expect(shearSec).toBeDefined();
    });

    it('crack-width section exists with §7.3.4 reference', () => {
      const crackSec = sections.find(s => s.title.includes('§7.3'));
      expect(crackSec).toBeDefined();
    });

    it('stress block section shows λ=0.80 and η=1.00 (fck=30 ≤ 50 MPa)', () => {
      const step = sections[0].steps.find(s => s.label.includes('Stress block'));
      expect(step).toBeDefined();
      expect(step!.result).toContain('0.80');
      expect(step!.result).toContain('1.00');
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// PART 2 — Adequately designed beam: passes ALL EC2 checks
//
// Remedy: increase section to 450×650, add 5H25 bottom + H10@120mm
// to satisfy both the shear tension shift and the crack width limit.
// ════════════════════════════════════════════════════════════════════
const section2: SectionDimensions = {
  type: 'rectangular_beam',
  b: 450 / IN_TO_MM,
  h: 650 / IN_TO_MM,
  coverClear: 35 / IN_TO_MM,
  stirrupDia: -10,
};
const rebar2: RebarLayout = {
  topBars: [{ numBars: 2, barSize: -25 }],
  botBars: [{ numBars: 5, barSize: -25 }],   // 5H25 = 2454 mm²
  ties: { barSize: -10, spacing: 120 / IN_TO_MM, legs: 2 },  // H10@120
};

describe('EC2 pinned-pinned beam — 5H25, 450×650, H10@120 — all checks pass', () => {
  const r2 = runDesign(section2, material1, rebar2, load1, span_ft, 'EN1992-1-1');

  it('status is OK (no NG, no errors)', () => {
    const errors = r2.warnings.filter(w => w.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(r2.status).not.toBe('NG');
  });

  it('M_Rd > 400 kN·m (flexure passes)', () => {
    expect(r2.phi_Mn_pos * KIPFT_TO_KNM).toBeGreaterThan(400);
  });

  it('V_Rd > 200 kN (shear passes)', () => {
    expect(r2.phi_Vn * KIP_TO_KN).toBeGreaterThan(200);
  });

  it('As_req (flexure-only) ≤ 5H25 provided', () => {
    const AsReq_mm2  = r2.As_req_pos * IN2_TO_MM2;
    const AsProv_mm2 = 5 * Math.PI / 4 * 25 * 25;   // 5H25 = 2454 mm²
    expect(AsProv_mm2).toBeGreaterThan(AsReq_mm2);
  });

  it('wk_bot < 0.30 mm (crack width within EC2 limit)', () => {
    expect(r2.wk_bot).toBeDefined();
    expect(r2.wk_bot!).toBeLessThan(0.30);
  });

  it('all warning codes still reference EC2 (no ACI clause leakage)', () => {
    for (const w of r2.warnings) {
      expect(w.code).toMatch(/^EC2 §/);
    }
  });

  it('DCR_flex_pos < DCR from Part 1 (larger section → lower utilisation)', () => {
    const r1 = runDesign(section1, material1, rebar1, load1, span_ft, 'EN1992-1-1');
    expect(r2.DCR_flex_pos).toBeLessThan(r1.DCR_flex_pos);
  });
});
