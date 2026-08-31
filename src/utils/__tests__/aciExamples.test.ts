/**
 * The four `Examples/ACI` cases, back-checked against the S-CONCRETE 2026 captures
 * saved beside them.
 *
 * These are real runs of the same beams through S-CONCRETE, screenshotted — the
 * highest-authority reference in the repo. Every number below is read off one of those
 * captures, not off our own output, so the file is a benchmark rather than a snapshot.
 *
 * Tolerance follows the house style: 1% on capacities, 1.5% on the P-M interaction
 * (`axialFlexure.test.ts` states the same), and exact on anything that is a definition
 * rather than a derivation.
 *
 * SIGN CONVENTION. S-CONCRETE reports axial load compression-NEGATIVE; `LoadCase.Pu` is
 * compression-POSITIVE. Example 1's "N = −1000.0 kips" is 1000 kips of compression.
 *
 * Two engine defects were found by writing this file, and both are pinned here:
 *
 *   • Vc was capped at 5λ√f′c·bw·d only when Av ≥ Av,min. Table 22.5.5.1's limit sits
 *     under the whole table. Example 1 is the case that shows it — S-CONCRETE's
 *     ØVcz = 85.0 kips IS the cap; uncapped the axial term gives 99.8.
 *   • There was no combined shear + torsion link utilisation for ACI. S-CONCRETE
 *     headlines one on every report ("V & T Util") and it is simply the two
 *     utilisations added, because the same stirrup legs carry both actions.
 */
import { describe, expect, it } from 'vitest';
import {
  designMember, computeShear, computeTorsion, steelLimits, closedStirrupGeometry,
} from '../concreteDesign';
import type { LoadCase, MaterialProps, RebarLayout, SectionDimensions } from '../../types';

const GR60 = { fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat6: MaterialProps = { fc: 6000, ...GR60 };
const mat5: MaterialProps = { fc: 5000, ...GR60 };
const row = (o: Partial<LoadCase>): LoadCase =>
  ({ id: 'lc', label: 'ULS', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0, ...o } as LoadCase);
/** Within `pct` % of the S-CONCRETE figure. */
const near = (got: number, want: number, pct = 1) =>
  expect(Math.abs(got - want) / Math.abs(want) * 100).toBeLessThanOrEqual(pct);

// ── Examples 1 and 2 share a section: 12×28, f′c 6000, 4-#8 top, 4-#8 + 4-#8 bottom,
//    #5 @ 9" 2-leg, cover 1.5". d = 24.375", d′ = 2.625".
const sect28: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 28, coverClear: 1.5, stirrupDia: 5 };
const cage28: RebarLayout = {
  topBars: [{ numBars: 4, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }, { numBars: 4, barSize: 8 }],
  ties: { barSize: 5, spacing: 9, legs: 2 },
  layerClearSpacing: 1.0,
};

describe('Example 1 — 12×28, 1000 kip compression, Mu 290 k-ft, Vu 60 kips', () => {
  const load = row({ Pu: 1000, Vu: 60, Mu_pos: 290 });
  const r = designMember(sect28, mat6, cage28, load, 20);
  const sh = computeShear(sect28, mat6, cage28, load.Pu);
  const to = computeTorsion(sect28, mat6, cage28, undefined, load.Pu);

  it('shear: ØVcz 85.0, ØVsz 75.6, ØVnz 160.5 kips', () => {
    near(0.75 * sh.Vc, 85.0);
    near(0.75 * sh.Vs, 75.6);
    near(sh.phi_Vn, 160.5);
    near(r.DCR_shear, 0.374);
  });

  it('ØVcz IS the §22.5.5.1 cap — 5λ√f′c·bw·d, not the raw axial expression', () => {
    // 2√f′c + Nu/(6Ag) with the 0.05f′c footnote gives 454.9 psi; the cap is 5√f′c =
    // 387.3 psi. Without the cap this reads 99.8 kips against S-CONCRETE's 85.0.
    const cap = 5 * Math.sqrt(6000) * 12 * 24.375 / 1000;
    expect(sh.Vc).toBeCloseTo(cap, 1);
    near(0.75 * cap, 85.0);
  });

  it('torsion: ØTcr 89.0, ØTth 22.2, ØTn 44.8 kip-ft — the axial modifier is applied', () => {
    // §22.7.5.1's √(1 + Nu/(4·Acp·λ√f′c)) is what lifts Tcr from 36.4 to 118.7 kip-ft
    // here; without it ØTcr reads 27.3 against S-CONCRETE's 89.0.
    near(0.75 * to.Tcr, 89.0);
    near(to.Tu_threshold, 22.2);
    near(to.phi_Tn, 44.8);
  });

  it('cross-section limit §22.7.7.1: utilisation 0.272', () => near(r.DCR_crushing!, 0.272));

  it('As,min = 1.13 in² (§9.6.1.2 on d = 24.375")', () => {
    near(steelLimits(sect28, mat6, 'bot', cage28.botBars, 1.0).As_min, 1.13);
  });

  it('axial–flexure: ØMn 307.8 k-ft, moment util 0.942, N-vs-M 0.982, axial 0.861', () => {
    near(r.phi_Mn_pos, 307.8);
    near(r.DCR_flex_pos, 0.942);
    near(r.DCR_PM!, 0.982, 1.5);
    near(r.DCR_axial!, 0.861, 1.5);
  });

  it('status: acceptable, and no warnings', () => {
    expect(r.warnings).toHaveLength(0);
    expect(r.status).toBe('OK');
  });
});

describe('Example 2 — same section, 50 kip TENSION, Mu 340 k-ft', () => {
  const load = row({ Pu: -50, Vu: 60, Mu_pos: 340 });
  const r = designMember(sect28, mat6, cage28, load, 20);

  it('V & T util 0.556 — axial tension eats the concrete shear contribution', () => {
    near(r.DCR_shear, 0.556);
    // Tension drops ØVcz from 85.0 (Ex 1, compression) to 32.4 on the same section.
    expect(r.VT_util).toBeCloseTo(r.DCR_shear, 6);   // no torsion ⇒ V&T reduces to shear
  });

  it('N vs M util 0.638', () => near(r.DCR_PM!, 0.638, 1.5));
  it('As,min unchanged at 1.13 in² — it does not depend on the load', () =>
    near(steelLimits(sect28, mat6, 'bot', cage28.botBars, 1.0).As_min, 1.13));
});

describe('Example 3 — 12×40 deep beam, 50 kip TENSION, Mu 340 k-ft', () => {
  const sect: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 40, coverClear: 1.5, stirrupDia: 5 };
  const cage: RebarLayout = {
    topBars: [{ numBars: 4, barSize: 8 }],
    botBars: [{ numBars: 4, barSize: 8 }, { numBars: 2, barSize: 8 }],
    ties: { barSize: 5, spacing: 13, legs: 2 },
    layerClearSpacing: 1.0,
  };
  const r = designMember(sect, mat6, cage, row({ Pu: -50, Vu: 60, Mu_pos: 340 }), 20);

  it('V & T util 0.483, N vs M 0.581', () => {
    near(r.DCR_shear, 0.483);
    near(r.DCR_PM!, 0.581, 1.5);
  });

  it('As,min = 1.71 in² on d = 36.708"', () =>
    near(steelLimits(sect, mat6, 'bot', cage.botBars, 1.0).As_min, 1.71));

  it('raises §9.7.2.3 skin steel — S-CONCRETE Message 27, "h > 36 in"', () => {
    // The only warning either tool raises on this beam, and both raise it.
    expect(r.warnings.map(w => w.code)).toEqual(['ACI §9.7.2.3']);
    expect(r.status).toBe('Warning');
  });
});

describe('Example 4 — 19.69×23.62, Tu 147.5 kip-ft: the torsion case', () => {
  const sect: SectionDimensions = { type: 'rectangular_beam', b: 19.69, h: 23.62, coverClear: 1.575, stirrupDia: 4 };
  const cage: RebarLayout = {
    topBars: [{ numBars: 6, barSize: 8 }],
    botBars: [{ numBars: 4, barSize: 8 }],
    ties: { barSize: 4, spacing: 7.874, legs: 2 },
    sideBars: [{ numBars: 2, barSize: 5 }],
  };
  // The capture reports "Axial Comp. Util 0.261" but not Nu itself. Nu ≈ 68 kips is
  // back-figured from its own ØVcz = 51.5, so the shear assertions below are pinned at
  // that value and are a check on the Nu/(6Ag) term rather than on Nu.
  const load = row({ Pu: 68, Vu: 22.5, Tu: 147.5 });
  const r = designMember(sect, mat5, cage, load, 20);
  const sh = computeShear(sect, mat5, cage, load.Pu);
  const to = computeTorsion(sect, mat5, cage, undefined, load.Pu);

  it('stirrup geometry matches to the digit — S-CONCRETE quotes x₁ = 16.04 in', () => {
    const g = closedStirrupGeometry(sect);
    expect(g.Ph / 2 - 19.97).toBeCloseTo(16.04, 1);   // x₁ + y₁ = Ph/2, y₁ = 19.97
    expect(g.Aoh).toBeCloseTo(320.3, 0);
  });

  it('the torsion link demand matches: At/s 0.0722 in²/in, s required 2.77 in', () => {
    // S-CONCRETE prints "At/S (req'd) = 0.07225 in" and "S (req'd) = 2.77 in".
    const AtS_req = load.Tu * 12000 / (0.75 * 2 * (0.85 * 320.3) * 60000);
    near(AtS_req, 0.07225);
    near(0.20 / AtS_req, 2.77);
  });

  it('ØVcz 51.5, ØVnz 99.6 kips', () => {
    near(0.75 * sh.Vc, 51.5);
    near(sh.phi_Vn, 99.6);
  });

  it('§22.7.7.1 crushing utilisation 1.337 — the section, not the links', () => {
    near(r.DCR_crushing!, 1.337);
    expect(r.warnings.some(w => w.code === 'ACI §22.7.7.1' && /ENLARGE THE SECTION/.test(w.message))).toBe(true);
  });

  it('V & T util 3.070 — shear and torsion demands ADD on the same legs', () => {
    // The headline number, and the one the engine had no equivalent for. It is exactly
    // DCR_shear + DCR_torsion: 0.226 + 2.844. Each alone is not the whole story —
    // DCR_shear here is a comfortable 0.23.
    expect(r.VT_util).toBeCloseTo(r.DCR_shear + r.DCR_torsion, 6);
    near(r.VT_util!, 3.070);
    expect(r.DCR_shear).toBeLessThan(0.3);
    near(to.phi_Tn, 51.9);
  });

  it('and it is reported as a §22.7.6.1 error, distinct from the §22.7.7.1 one', () => {
    const codes = r.warnings.map(w => w.code);
    expect(codes).toContain('ACI §22.7.6.1');   // more links would fix this
    expect(codes).toContain('ACI §22.7.7.1');   // only a bigger section fixes this
  });
});

describe('V & T util is inert on the members that should not see it', () => {
  it('no torsion ⇒ it reduces to the shear utilisation exactly', () => {
    const r = designMember(sect28, mat6, cage28, row({ Vu: 60, Mu_pos: 290 }), 20);
    expect(r.VT_util).toBeCloseTo(r.DCR_shear, 6);
  });

  it('below φ·T_th it stays at the shear utilisation — §22.7.1.1 lets torsion be neglected', () => {
    const to = computeTorsion(sect28, mat6, cage28);
    const small = to.Tu_threshold * 0.5;
    const r = designMember(sect28, mat6, cage28, row({ Vu: 60, Mu_pos: 290, Tu: small }), 20);
    expect(r.DCR_torsion).toBeGreaterThan(0);        // the raw ratio is still reported…
    expect(r.VT_util).toBeCloseTo(r.DCR_shear, 6);   // …but it does not join the sum
  });

  it('just above the threshold it does join, and only then', () => {
    const to = computeTorsion(sect28, mat6, cage28);
    const r = designMember(sect28, mat6, cage28, row({ Vu: 60, Mu_pos: 290, Tu: to.Tu_threshold * 1.01 }), 20);
    expect(r.VT_util!).toBeGreaterThan(r.DCR_shear);
  });
});
