/**
 * A characterisation lock on the P-M interaction, so it can be made FAST without
 * being allowed to move.
 *
 * axialFlexure.test.ts pins three S-Concrete reference cases — that is what says the
 * model is right. This file says something different and complementary: that 480
 * (section × material × cage × sense × load) combinations produce EXACTLY the numbers
 * they produced before the surface was memoised and the branch lookup was rewritten.
 * Bit-identical, not close: every optimisation in that file is meant to change how
 * long the answer takes and nothing else, and a tolerance would let a real drift hide
 * inside it.
 *
 * The matrix is deliberately awkward where the fast paths are delicate:
 *   · flanged sections, where the compression branch has a kink at the flange
 *   · a 8-#11 top / 2-#4 bottom cage, which is as asymmetric as a beam gets, so the
 *     two senses are nothing like each other
 *   · loads from deep tension through pure flexure to well past the squash cap, which
 *     is where the φPn plateau makes several samples share one axial load
 *   · Mu = 0.0001 with axial, which is the degenerate ray the solver special-cases
 *
 * If this fails, the question is not "what tolerance should it have" — it is which
 * number moved and why.
 *
 * REBASELINED ONCE, deliberately, when two engine defects were fixed:
 *   1. T/L beams in HOGGING ran the flange + web split even though the flange is in
 *      TENSION there. With bFlange = bw the flange force collapsed to zero but
 *      `a = a_web + hf` still added the flange depth, so `a` came out a whole hf too
 *      deep and the lever arm a whole hf too short — and the inflated `a` then drove
 *      c and φ down too. On the L-beam / 8-#11 / f'c 8000 row it read φMn⁻ = 1210
 *      kip-ft against a hand-checked 1877.
 *   2. φ's transition band is εty → εty + 0.003 (Table 21.2.2), not Grade 60's
 *      0.002 → 0.005 hard-coded. The f'y = 75 ksi rows move most, as they should.
 *   3. The doubly-reinforced equilibrium solve is a bisection, not a damped fixed
 *      point that diverged on heavy compression steel. On this matrix that is worth
 *      3.5e-8 relative — it only bites outside it — but the numbers did shift.
 * Everything the S-Concrete reference cases pin (axialFlexure.test.ts) is unchanged.
 */
import { describe, it, expect } from 'vitest';
import type { MaterialProps, RebarLayout, SectionDimensions } from '../../types';
import { beamAxialFlexure, clearAxialFlexureCache } from '../axialFlexure';
import { computeFlexure, getBarArea } from '../concreteDesign';
import GOLDEN from './fixtures/axialFlexureGolden.json';

const MATERIALS: MaterialProps[] = [
  { fc: 4000, fy: 60000, fyt: 60000, Es: 29e6, lambdaConcrete: 1 },
  { fc: 8000, fy: 75000, fyt: 60000, Es: 29e6, lambdaConcrete: 1 },
];

const SECTIONS: SectionDimensions[] = [
  { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 },
  { type: 'rectangular_beam', b: 30, h: 16, coverClear: 2.0, stirrupDia: 5 },
  { type: 'T_beam', b: 60, h: 30, bw: 14, hf: 6, coverClear: 1.5, stirrupDia: 4 },
  { type: 'L_beam', b: 40, h: 36, bw: 16, hf: 5, coverClear: 1.5, stirrupDia: 5 },
];

const CAGES: RebarLayout[] = [
  {
    topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 2, barSize: 5 }],
    ties: { barSize: 4, spacing: 8, legs: 2 }, layerClearSpacing: 1,
  },
  {
    topBars: [{ numBars: 8, barSize: 11 }], botBars: [{ numBars: 2, barSize: 4 }],
    ties: { barSize: 5, spacing: 6, legs: 4 }, layerClearSpacing: 1,
  },
  {
    topBars: [{ numBars: 3, barSize: 8 }, { numBars: 3, barSize: 8 }],
    botBars: [{ numBars: 4, barSize: 9 }, { numBars: 2, barSize: 6 }],
    ties: { barSize: 4, spacing: 12, legs: 2 }, layerClearSpacing: 1.5,
  },
];

/** [Pu (kips, +compression), Mu (kip-ft)] */
const LOADS: [number, number][] = [
  [0, 0], [0, 120], [-40, 0], [-120, 240], [25, 90],
  [150, 300], [600, 200], [2000, 50], [-800, 10], [40, 0.0001],
];

const SPAN = 24;
const As = (g: { numBars: number; barSize: number }[]) =>
  g.reduce((t, x) => t + x.numBars * getBarArea(x.barSize), 0);

/** Rebuild the matrix in the same order the fixture was generated in. */
function sweep(): unknown[][] {
  const out: unknown[][] = [];
  for (let si = 0; si < SECTIONS.length; si++) {
    for (let mi = 0; mi < MATERIALS.length; mi++) {
      for (let ci = 0; ci < CAGES.length; ci++) {
        const section = SECTIONS[si], material = MATERIALS[mi], rebar = CAGES[ci];
        const f = computeFlexure(
          section, material, As(rebar.topBars), As(rebar.botBars), SPAN,
          rebar.topBars[0].barSize, rebar.botBars[0].barSize,
          rebar.topBars, rebar.botBars, rebar.layerClearSpacing,
        );
        for (const sense of ['pos', 'neg'] as const) {
          const phiMn0 = sense === 'pos' ? f.phi_Mn_pos : f.phi_Mn_neg;
          for (const [Pu, Mu] of LOADS) {
            const r = beamAxialFlexure(section, material, rebar, SPAN, sense, phiMn0, Pu, Mu);
            out.push([si, mi, ci, sense, Pu, Mu,
              r.phiPnMax, r.phiPnTens, r.phiMnAtPu, r.axialUtil, r.nmUtil,
              r.phiPnAtRay, r.phiMnAtRay, r.points.length]);
          }
        }
      }
    }
  }
  return out;
}

const FIELDS = ['si', 'mi', 'ci', 'sense', 'Pu', 'Mu',
  'phiPnMax', 'phiPnTens', 'phiMnAtPu', 'axialUtil', 'nmUtil',
  'phiPnAtRay', 'phiMnAtRay', 'points.length'];

describe('beamAxialFlexure — 480-case characterisation lock', () => {
  it('reproduces every golden number exactly', () => {
    const got = sweep();
    expect(got.length).toBe(GOLDEN.length);
    const diffs: string[] = [];
    for (let i = 0; i < got.length; i++) {
      for (let j = 0; j < FIELDS.length; j++) {
        if (got[i][j] !== (GOLDEN as unknown[][])[i][j]) {
          diffs.push(`row ${i} (${GOLDEN[i].slice(0, 6).join(', ')}) · ${FIELDS[j]}: ${got[i][j]} ≠ ${GOLDEN[i][j]}`);
        }
      }
    }
    expect(diffs.slice(0, 12)).toEqual([]);
  });

  it('the memoised surface is what an unmemoised one would have been', () => {
    // The cache is keyed on a full value serialisation, so a hit can only be a genuine
    // repeat. Prove it the blunt way: run the sweep with the cache cleared before every
    // single call, and require the same numbers.
    const cached = sweep();
    const uncached: unknown[][] = [];
    for (let si = 0; si < SECTIONS.length; si++) {
      for (let mi = 0; mi < MATERIALS.length; mi++) {
        for (let ci = 0; ci < CAGES.length; ci++) {
          const section = SECTIONS[si], material = MATERIALS[mi], rebar = CAGES[ci];
          const f = computeFlexure(
            section, material, As(rebar.topBars), As(rebar.botBars), SPAN,
            rebar.topBars[0].barSize, rebar.botBars[0].barSize,
            rebar.topBars, rebar.botBars, rebar.layerClearSpacing,
          );
          for (const sense of ['pos', 'neg'] as const) {
            const phiMn0 = sense === 'pos' ? f.phi_Mn_pos : f.phi_Mn_neg;
            for (const [Pu, Mu] of LOADS) {
              clearAxialFlexureCache();
              const r = beamAxialFlexure(section, material, rebar, SPAN, sense, phiMn0, Pu, Mu);
              uncached.push([si, mi, ci, sense, Pu, Mu,
                r.phiPnMax, r.phiPnTens, r.phiMnAtPu, r.axialUtil, r.nmUtil,
                r.phiPnAtRay, r.phiMnAtRay, r.points.length]);
            }
          }
        }
      }
    }
    expect(uncached).toEqual(cached);
  });

  it('a changed cage is never served a stale surface', () => {
    // The failure mode a value key exists to prevent: same object shape, one bar
    // different. If the key ever narrows to object identity or a hand-listed subset of
    // fields, this is what catches it.
    const section = SECTIONS[0], material = MATERIALS[0];
    const a: RebarLayout = {
      topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }],
      ties: { barSize: 4, spacing: 8, legs: 2 }, layerClearSpacing: 1,
    };
    const b: RebarLayout = { ...a, botBars: [{ numBars: 5, barSize: 8 }] };
    const cap = (r: RebarLayout) =>
      beamAxialFlexure(section, material, r, SPAN, 'pos', 300, 100, 150).phiPnMax;
    const first = cap(a);
    const second = cap(b);
    const again = cap(a);
    expect(second).not.toBe(first);      // more steel, more squash capacity
    expect(again).toBe(first);           // and coming back gives the original
  });

  it('a changed section is never served a stale surface', () => {
    const material = MATERIALS[0], rebar = CAGES[0];
    const shallow = { ...SECTIONS[0], h: 24 };
    const deep = { ...SECTIONS[0], h: 36 };
    const cap = (s: SectionDimensions) =>
      beamAxialFlexure(s, material, rebar, SPAN, 'pos', 300, 100, 150).phiPnMax;
    expect(cap(deep)).not.toBe(cap(shallow));
  });
});
