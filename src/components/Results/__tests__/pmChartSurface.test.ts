/**
 * The N-vs-M window reads capacity off the surface. This pins that read to the ENGINE.
 *
 * `phiMnAtP` is what the crosshair's "φMn at this N" comes from. It walks the same
 * `AxialFlexureResult.points` array the check walked and takes the outermost crossing,
 * exactly as `beamAxialFlexure`'s own `interpAt` does — so the number under the cursor
 * has to agree with the number the engine reported. If the two ever drift, the window is
 * quoting a capacity nothing was designed to, which is worse than showing no number.
 *
 * Fixture is the same beam mark as axialFlexure.test.ts (B-07-04, 12×28, f'c 6000,
 * Grade 60), so a change to the surface shows up in both files rather than one.
 */
import { describe, it, expect } from 'vitest';
import type { MaterialProps, RebarLayout, SectionDimensions } from '../../../types';
import { beamAxialFlexure } from '../../../utils/axialFlexure';
import { computeFlexure } from '../../../utils/concreteDesign';
import { phiMnAtP } from '../InteractionChart';

const mat: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const section: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 28, coverClear: 1.5, stirrupDia: 5 };
const rebar: RebarLayout = {
  topBars: [{ numBars: 4, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }, { numBars: 4, barSize: 8 }],
  ties: { barSize: 5, spacing: 9, legs: 2 },
  layerClearSpacing: 1.0,
};

const As = rebar.botBars.reduce((s, g) => s + g.numBars * 0.79, 0);
const Asp = rebar.topBars.reduce((s, g) => s + g.numBars * 0.79, 0);
const phiMn0 = computeFlexure(section, mat, Asp, As, 24, 8, 8, rebar.topBars, rebar.botBars, 1.0).phi_Mn_pos;

const r = beamAxialFlexure(section, mat, rebar, 24, 'pos', phiMn0, 1000, 290);

describe('phiMnAtP — the capacity the crosshair reports', () => {
  // Both reads are interpolations across the PUBLISHED samples, while the engine solves
  // on its full 900-point sweep — so they sit a hair low, always, because a chord across
  // a convex curve cuts the corner. 1 kip-ft on a ~630 kip-ft section is 0.15%, and the
  // bound is deliberately tight: it is what would catch the sampling stride being
  // loosened back to where the two visibly disagreed (see the note in axialFlexure.ts).
  const TOL = 1.0;

  it('at P = 0 it returns the pure-flexure capacity the curve is pinned to', () => {
    // The whole surface is scaled so this point equals computeFlexure's φMn⁺. A reader
    // hovering the P = 0 axis must therefore see the same number the flexure check used.
    const v = phiMnAtP(r.points, 0) as number;
    expect(Math.abs(v - phiMn0)).toBeLessThan(TOL);
    expect(v).toBeLessThanOrEqual(phiMn0);        // low, never high
  });

  it('agrees with the engine at the applied axial load', () => {
    // r.phiMnAtPu is what the CHECK divided the demand by. A bigger gap than TOL would
    // mean the picture and the DCR beside it are telling different stories about the
    // same section.
    const v = phiMnAtP(r.points, 1000) as number;
    expect(Math.abs(v - r.phiMnAtPu)).toBeLessThan(TOL);
  });

  it('falls to zero capacity as the axial load approaches the squash cap', () => {
    const atCap = phiMnAtP(r.points, r.phiPnMax);
    expect(atCap).not.toBeNull();
    expect(atCap as number).toBeLessThan(phiMn0 * 0.35);
    expect(atCap as number).toBeGreaterThanOrEqual(0);
  });

  it('returns null past the ends of the surface rather than extrapolating', () => {
    // "No capacity here" is a real answer and the window prints it as "off surface".
    // Extrapolating would invent strength above the §22.4.2.1 cap.
    expect(phiMnAtP(r.points, r.phiPnMax * 1.5)).toBeNull();
    expect(phiMnAtP(r.points, r.phiPnTens * 1.5)).toBeNull();
  });

  it('takes the OUTERMOST crossing, as the engine does', () => {
    // The surface doubles back near the cap: the same φPn occurs twice, once on the way
    // up and once on the flat top where the moment is smaller. Reading the first crossing
    // instead of the largest would understate capacity by most of the plateau.
    const P = r.phiPnMax * 0.98;
    const crossings = r.points
      .map((p, i) => [r.points[i - 1], p])
      .filter(([a, b]) => a && (a.phiPn - P) * (b.phiPn - P) <= 0)
      .map(([a, b]) => a.phiMn + ((P - a.phiPn) / ((b.phiPn - a.phiPn) || 1e-12)) * (b.phiMn - a.phiMn));
    if (crossings.length > 1) {
      expect(phiMnAtP(r.points, P)).toBeCloseTo(Math.max(...crossings), 6);
    }
  });
});

describe('the hogging branch is its own surface', () => {
  // The window draws both, mirrored into ∓M, because they are separate solves. If they
  // came out identical the second curve would be decoration; this pins that they do not.
  const phiMn0Neg = computeFlexure(section, mat, Asp, As, 24, 8, 8, rebar.topBars, rebar.botBars, 1.0).phi_Mn_neg;
  const neg = beamAxialFlexure(section, mat, rebar, 24, 'neg', phiMn0Neg, 1000, 290);

  it('hogging is anchored to φMn⁻, not φMn⁺', () => {
    expect(phiMnAtP(neg.points, 0)).toBeCloseTo(phiMn0Neg, 0);
  });

  it('the two branches differ — this cage is not symmetric (8 bottom bars, 4 top)', () => {
    expect(Math.abs(phiMn0Neg - phiMn0)).toBeGreaterThan(1);
  });
});
