/**
 * ACI 318-19 axial–flexure interaction, back-checked against S-Concrete 2026.0.
 *
 * All three reference cases are the SAME beam mark (B-07-04, f'c 6000 psi,
 * Grade 60, #5 closed stirrups, 1.5" cover all round) so the only thing moving
 * between them is the axial load and the section depth:
 *
 *   Example 1  12×28  Pu = +1000 kip COMPRESSION, Mu = 290 kip-ft
 *   Example 2  12×28  Pu =   −50 kip TENSION,     Mu = 340 kip-ft
 *   Example 3  12×40  Pu =   −50 kip TENSION,     Mu = 340 kip-ft
 *
 * S-Concrete reports axial as +tension; the engine's LoadCase.Pu is
 * +compression, so its N is negated here.
 */
import { describe, it, expect } from 'vitest';
import type { LoadCase, MaterialProps, RebarLayout, SectionDimensions } from '../../types';
import { beamAxialFlexure } from '../axialFlexure';
import { computeFlexure, computeShear, computeTorsion, designMember, torsionCrushing } from '../concreteDesign';

const mat: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };

const sec = (h: number): SectionDimensions =>
  ({ type: 'rectangular_beam', b: 12, h, coverClear: 1.5, stirrupDia: 5 });

/** 4-#8 top; bottom in two layers, outermost first. */
const cage = (botOuter: number, botInner: number, spacing: number): RebarLayout => ({
  topBars: [{ numBars: 4, barSize: 8 }],
  botBars: [{ numBars: botOuter, barSize: 8 }, { numBars: botInner, barSize: 8 }],
  ties: { barSize: 5, spacing, legs: 2 },
  layerClearSpacing: 1.0,
});

const load = (Pu: number, Mu: number, Vu: number): LoadCase =>
  ({ id: 'LC1', label: 'LC1', Mu_pos: Mu, Mu_neg: 0, Vu, Tu: 0, Pu });

/** Pure-flexure φMn⁺ for a section+cage — the anchor the curve is pinned to. */
function phiMn0(section: SectionDimensions, rebar: RebarLayout): number {
  const As = rebar.botBars.reduce((s, g) => s + g.numBars * 0.79, 0);
  const Asp = rebar.topBars.reduce((s, g) => s + g.numBars * 0.79, 0);
  return computeFlexure(section, mat, Asp, As, 24, 8, 8, rebar.topBars, rebar.botBars, 1.0).phi_Mn_pos;
}

function run(section: SectionDimensions, rebar: RebarLayout, Pu: number, Mu: number) {
  return beamAxialFlexure(section, mat, rebar, 24, 'pos', phiMn0(section, rebar), Pu, Mu);
}

describe('Example 1 — 12×28, Pu = 1000 kip COMPRESSION, Mu = 290 kip-ft', () => {
  const section = sec(28), rebar = cage(4, 4, 9);
  const r = run(section, rebar, 1000, 290);

  it('φPn,max = 1161.7 kips — §22.4.2.1, 0.80 cap with φ = 0.65 (tied)', () => {
    expect(r.phiPnMax).toBeCloseTo(1161.7, 1);
  });

  it('φMn at Pu = 307.8 kip-ft (S-Concrete "Max Resultant Mom." ØMn)', () => {
    expect(r.phiMnAtPu).toBeCloseTo(307.8, 0);
  });

  it('the compression branch collapses the moment capacity to ~49% of pure bending', () => {
    // Pure flexure gives 629 kip-ft; at 1000 kips the section is
    // compression-controlled (φ → 0.65) and the capacity halves.
    expect(r.phiMn0).toBeCloseTo(629.3, 0);
    expect(r.phiMnAtPu / r.phiMn0).toBeLessThan(0.5);
  });

  it('radial N-vs-M point = (1018.6 kips, 295.4 kip-ft), utilisation 0.982', () => {
    expect(r.phiPnAtRay).toBeCloseTo(1018.6, 0);
    expect(r.phiMnAtRay).toBeCloseTo(295.4, 0);
    expect(r.nmUtil).toBeCloseTo(0.982, 2);
  });

  it('axial-alone utilisation = 0.861', () => {
    expect(r.axialUtil).toBeCloseTo(0.861, 2);
  });
});

describe('Example 2 — 12×28, Pu = 50 kip TENSION, Mu = 340 kip-ft', () => {
  const section = sec(28), rebar = cage(4, 4, 9);
  const r = run(section, rebar, -50, 340);

  it('φPnt = −511.9 kips — the whole cage yielding, φ = 0.9', () => {
    expect(r.phiPnTens).toBeCloseTo(-511.9, 1);
  });

  it('φMn at Pu = 567.8 kip-ft (S-Concrete ØMn)', () => {
    expect(r.phiMnAtPu).toBeCloseTo(567.8, 0);
  });

  it('N-vs-M utilisation = 0.638 — the straight-line tension interaction', () => {
    // util = Mu/φMn0 + |Pu|/|φPnt| = 0.540 + 0.098
    expect(r.nmUtil).toBeCloseTo(0.638, 3);
  });

  it('the combined check is 18% worse than pure bending alone', () => {
    expect(340 / r.phiMn0).toBeCloseTo(0.540, 3);   // what the app used to report
    expect(r.nmUtil / (340 / r.phiMn0)).toBeGreaterThan(1.15);
  });
});

describe('Example 3 — 12×40, Pu = 50 kip TENSION, Mu = 340 kip-ft', () => {
  const section = sec(40), rebar = cage(4, 2, 13);
  const r = run(section, rebar, -50, 340);

  it('φPnt = −426.6 kips', () => {
    expect(r.phiPnTens).toBeCloseTo(-426.6, 1);
  });

  // Examples 1 and 2 land on S-Concrete exactly; this one sits 1.2% high. The
  // gap traces to the pure-flexure anchor — S-Concrete's implied φMn0 here is
  // 733 kip-ft against our 742, on a cage with UNEQUAL bottom layers (4-#8 outer
  // + 2-#8 inner). Equal-layer sections (Examples 1 and 2) agree to the digit,
  // so the difference is in how the two tools resolve an unequal layer pair, not
  // in the interaction itself. 1.2% unconservative — recorded, not papered over.
  it('φMn at Pu is within 1.5% of S-Concrete (647.5 kip-ft)', () => {
    expect(Math.abs(r.phiMnAtPu - 647.5) / 647.5).toBeLessThan(0.015);
    expect(r.phiMnAtPu).toBeGreaterThan(647.5);   // and it is the high side
  });

  it('N-vs-M utilisation ≈ 0.581 (within 1.5% of S-Concrete)', () => {
    expect(Math.abs(r.nmUtil - 0.581) / 0.581).toBeLessThan(0.015);
  });
});

describe('continuity and the Pu = 0 guarantee', () => {
  const section = sec(28), rebar = cage(4, 4, 9);

  it('Pu = 0 leaves φMn exactly as the pure-flexure check computed it', () => {
    const pure = designMember(section, mat, rebar, load(0, 340, 60), 24);
    const flex = computeFlexure(section, mat, 3.16, 6.32, 24, 8, 8, rebar.topBars, rebar.botBars, 1.0);
    expect(pure.phi_Mn_pos).toBe(flex.phi_Mn_pos);
    expect(pure.DCR_PM).toBeUndefined();
  });

  it('φMn is continuous through Pu = 0 — no step from either side', () => {
    const m0 = phiMn0(section, rebar);
    const eps = 0.01;   // kips
    const comp = run(section, rebar, +eps, 340).phiMnAtPu;
    const tens = run(section, rebar, -eps, 340).phiMnAtPu;
    expect(comp).toBeCloseTo(m0, 1);
    expect(tens).toBeCloseTo(m0, 1);
  });

  it('a tension load reduces φMn and a small compression raises it', () => {
    const m0 = phiMn0(section, rebar);
    expect(run(section, rebar, -100, 340).phiMnAtPu).toBeLessThan(m0);
    // Below the balance point modest compression ADDS moment capacity.
    expect(run(section, rebar, 100, 340).phiMnAtPu).toBeGreaterThan(m0);
  });
});

/**
 * ACI §22.7.5.1 — axial load moves the torsional cracking torsion and, with it,
 * the threshold below which torsion may be neglected. φ = 0.75 throughout.
 * S-Concrete's ØTcr / ØTth for the three reference cases:
 *   Example 1  (+1000 comp, 12×28)  89.0 / 22.2 kip-ft
 *   Example 2  (  −50 tens, 12×28)  19.7 /  4.9
 *   Example 3  (  −50 tens, 12×40)  35.0 /  8.7
 */
describe('torsion — §22.7.5.1 axial modifier', () => {
  const PHI = 0.75;

  it('Example 1: 1000 kip compression raises φTcr to 89.0 kip-ft', () => {
    const t = computeTorsion(sec(28), mat, cage(4, 4, 9), 9, 1000);
    expect(PHI * t.Tcr).toBeCloseTo(89.0, 1);
    expect(t.Tu_threshold).toBeCloseTo(22.2, 1);
  });

  it('Example 2: 50 kip tension drops φTcr to 19.7 kip-ft', () => {
    const t = computeTorsion(sec(28), mat, cage(4, 4, 9), 9, -50);
    expect(PHI * t.Tcr).toBeCloseTo(19.7, 1);
    expect(t.Tu_threshold).toBeCloseTo(4.9, 1);
  });

  it('Example 3: 50 kip tension on the 12×40 gives φTcr 35.0 kip-ft', () => {
    const t = computeTorsion(sec(40), mat, cage(4, 2, 13), 13, -50);
    expect(PHI * t.Tcr).toBeCloseTo(35.0, 1);
    expect(t.Tu_threshold).toBeCloseTo(8.7, 1);
  });

  it('the threshold stays exactly φTcr/4 whatever the axial load', () => {
    for (const Nu of [-200, -50, 0, 500, 1000]) {
      const t = computeTorsion(sec(28), mat, cage(4, 4, 9), 9, Nu);
      expect(t.Tu_threshold).toBeCloseTo(PHI * t.Tcr / 4, 6);
    }
  });

  it('Nu = 0 reproduces the pre-fix values exactly — no axial, no change', () => {
    const withArg = computeTorsion(sec(28), mat, cage(4, 4, 9), 9, 0);
    const without = computeTorsion(sec(28), mat, cage(4, 4, 9), 9);
    expect(withArg.axialFactor).toBe(1);
    expect(withArg.Tcr).toBe(without.Tcr);
    expect(PHI * withArg.Tcr).toBeCloseTo(27.33, 2);   // the value the app used to print
  });

  it('φTn is untouched by axial — only cracking moves', () => {
    const comp = computeTorsion(sec(28), mat, cage(4, 4, 9), 9, 1000);
    const tens = computeTorsion(sec(28), mat, cage(4, 4, 9), 9, -50);
    expect(comp.phi_Tn).toBeCloseTo(tens.phi_Tn, 9);
    expect(comp.phi_Tn).toBeCloseTo(44.8, 1);          // S-Concrete ØTn, all three cases
  });

  it('enough tension wipes the concrete contribution out rather than going imaginary', () => {
    // Radicand 1 + Nu/(4·Ag·λ√f'c) goes negative past ≈ −104 kips here.
    const t = computeTorsion(sec(28), mat, cage(4, 4, 9), 9, -400);
    expect(t.axialFactor).toBe(0);
    expect(t.Tcr).toBe(0);
    expect(t.Tu_threshold).toBe(0);
    expect(Number.isFinite(t.Tcr)).toBe(true);
  });

  it('designMember passes the row Pu through to the torsion check', () => {
    const r = designMember(sec(28), mat, cage(4, 4, 9), load(-50, 340, 60), 24);
    expect(PHI * r.Tcr).toBeCloseTo(19.7, 1);
    expect(r.Tu_threshold).toBeCloseTo(4.9, 1);
  });
});

/**
 * ACI §22.7.7.1 — cross-sectional dimensions for combined shear + torsion.
 * S-Concrete calls this "Crushing Util" and reports, for the three references
 * (all at Tu = 0, so the shear term alone drives it):
 *   Example 1  0.272     Example 2  0.356     Example 3  0.240
 */
describe('torsion — §22.7.7.1 cross-section (crushing) limit', () => {
  /** util for a case, using the same Vc the shear check produced. */
  function util(h: number, rebar: RebarLayout, spacing: number, Pu: number, Vu: number, Tu: number) {
    const section = sec(h);
    const sh = computeShear(section, mat, rebar, Pu, spacing);
    return torsionCrushing(section, mat, Vu, sh.Vc, Tu, sh.d_shear);
  }

  it('Example 1 (+1000 kip compression): utilisation 0.272', () => {
    expect(util(28, cage(4, 4, 9), 9, 1000, 60, 0).util).toBeCloseTo(0.272, 3);
  });

  it('Example 2 (−50 kip tension): utilisation 0.356', () => {
    expect(util(28, cage(4, 4, 9), 9, -50, 60, 0).util).toBeCloseTo(0.356, 3);
  });

  it('Example 3 (−50 kip tension, 12×40): utilisation 0.240', () => {
    expect(util(40, cage(4, 2, 13), 13, -50, 60, 0).util).toBeCloseTo(0.240, 3);
  });

  it('axial flows through: compression raises the limit, tension lowers it', () => {
    // Same section, same Vu — only the axial changes, via Vc inside the limit.
    const comp = util(28, cage(4, 4, 9), 9, 1000, 60, 0);
    const tens = util(28, cage(4, 4, 9), 9, -50, 60, 0);
    expect(comp.limit).toBeGreaterThan(tens.limit);
    expect(comp.util).toBeLessThan(tens.util);
  });

  // Tn,max is a back-solved convenience number, not the check itself. S-Concrete
  // reports 68.1 / 50.7 / 83.4 kip-ft; ours lands 3–4% BELOW — the conservative
  // side. The utilisation above, which IS the check, matches to 0.2%.
  it('reports the torsion headroom left alongside the concurrent shear', () => {
    const e2 = util(28, cage(4, 4, 9), 9, -50, 60, 0);
    expect(e2.Tn_max).toBeCloseTo(48.5, 1);
    expect(e2.Tn_max).toBeLessThan(50.7);
    const e1 = util(28, cage(4, 4, 9), 9, 1000, 60, 0);
    expect(e1.Tn_max).toBeGreaterThan(e2.Tn_max);   // compression buys headroom
  });

  it('adding torsion raises the utilisation as a root-sum-square, not linearly', () => {
    const t0 = util(28, cage(4, 4, 9), 9, -50, 60, 0).util;
    const t30 = util(28, cage(4, 4, 9), 9, -50, 60, 30).util;
    expect(t30).toBeGreaterThan(t0);
    // RSS: adding a torsion stress equal to the shear stress multiplies by √2,
    // so a modest Tu must move it by far less than the linear sum would.
    expect(t30).toBeLessThan(t0 * 2);
  });

  it('torsion at exactly Tn,max lands on utilisation 1.0', () => {
    const r = util(28, cage(4, 4, 9), 9, -50, 60, 0);
    expect(util(28, cage(4, 4, 9), 9, -50, 60, r.Tn_max).util).toBeCloseTo(1.0, 6);
  });

  it('Tn,max is zero when shear alone already reaches the limit', () => {
    expect(util(28, cage(4, 4, 9), 9, -50, 400, 0).Tn_max).toBe(0);
  });

  it('designMember raises a §22.7.7.1 error and goes NG when the section is too small', () => {
    const r = designMember(sec(28), mat, cage(4, 4, 9), load(0, 100, 60), 24);
    const over = designMember(sec(28), mat, cage(4, 4, 9),
      { ...load(0, 100, 60), Tu: 120 }, 24);
    expect(r.DCR_crushing!).toBeLessThan(1);
    expect(over.DCR_crushing!).toBeGreaterThan(1);
    expect(over.warnings.some(w => w.code === 'ACI §22.7.7.1' && /ENLARGE THE SECTION/.test(w.message))).toBe(true);
    expect(over.status).toBe('NG');
  });

  it('the check reaches DesignResults on every row, axial or not', () => {
    const r = designMember(sec(28), mat, cage(4, 4, 9), load(0, 340, 60), 24);
    expect(r.DCR_crushing).toBeGreaterThan(0);
    expect(r.phi_Tn_max).toBeGreaterThan(0);
  });
});

describe('designMember reports the interaction', () => {
  const section = sec(28), rebar = cage(4, 4, 9);

  it('Example 2 governs on N-vs-M, not on flexure alone', () => {
    const r = designMember(section, mat, rebar, load(-50, 340, 60), 24);
    expect(r.phi_Mn_pos).toBeCloseTo(567.8, 0);
    expect(r.DCR_flex_pos).toBeCloseTo(340 / 567.8, 3);
    expect(r.DCR_PM).toBeCloseTo(0.638, 3);
    expect(r.DCR_axial_tens).toBeCloseTo(0.098, 3);
  });

  it('Example 1 reports the compression cap and a near-unity combined check', () => {
    const r = designMember(section, mat, rebar, load(1000, 290, 60), 24);
    expect(r.phi_Pn_max).toBeCloseTo(1161.7, 1);
    expect(r.DCR_axial).toBeCloseTo(0.861, 2);
    expect(r.DCR_PM).toBeCloseTo(0.982, 2);
    // The old pure-bending answer was 0.46 — less than half the real number.
    expect(r.DCR_PM! / (290 / 629.3)).toBeGreaterThan(2);
  });

  it('exceeding the interaction surface raises a §22.4 error', () => {
    const r = designMember(section, mat, rebar, load(1200, 290, 60), 24);
    expect(r.warnings.some(w => w.code.startsWith('ACI §22.4'))).toBe(true);
    expect(r.status).toBe('NG');
  });

  it('no axial load raises no §22.4 message at all', () => {
    const r = designMember(section, mat, rebar, load(0, 340, 60), 24);
    expect(r.warnings.some(w => w.code.startsWith('ACI §22.4'))).toBe(false);
  });
});
