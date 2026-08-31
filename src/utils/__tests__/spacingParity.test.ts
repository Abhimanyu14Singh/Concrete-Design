/**
 * §25.2.2, and the dashboards' warning lists.
 *
 * THE VERTICAL CLEAR-SPACING CHECK IS GONE. It required `max(1", db)` between bar
 * layers, which is §25.2.1's HORIZONTAL rule applied to the vertical direction — the
 * clause itself asks only for "a clear spacing between layers of at least 1 in.", and
 * S-CONCRETE agrees, printing "dz (min) 1.0 in" and accepting a 1.0" gap. So an
 * ordinary stacked cage of #9s or larger was being flagged against a limit no code sets.
 * The sweep below is the guard that neither the engine nor the Calc Sheet brings it back.
 *
 * It replaces a parity sweep written when the two surfaces disagreed ABOUT that check:
 * the sheet printed one pooled row for the whole section, taking db from the largest bar
 * anywhere in the beam including a single-layer face, and read ⚠ NG on 294 of the same
 * 20 736 cages where the engine stayed silent. Both halves are now simply absent.
 *
 * The second half of this file is unrelated to that clause and still live: both Group
 * Dashboards take their warning list off EVERY load row, not the governing one. Checks
 * that only run on some rows — §24.3.2 needs a sagging row, §22.7.x needs Tu past its
 * threshold — were otherwise shown or hidden depending on which row happened to govern
 * the DCR, while the Calc Sheet showed whichever row was selected.
 */
import { describe, expect, it } from 'vitest';
import { designMember } from '../concreteDesign';
import { generateBreakdown } from '../calcBreakdown';
import { designMemberAllRows, summaryMaps } from '../../workspace/design.js';
import type { LoadCase, MaterialProps, Member, RebarLayout, SectionDimensions } from '../../types';

const mat: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const sec: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 30, coverClear: 1.5, stirrupDia: 4 };
const load = { id: 'l', label: 'ULS', Mu_pos: 120, Mu_neg: 60, Vu: 30, Tu: 2, Pu: 0 } as LoadCase;
const SIZES = [4, 5, 6, 7, 8, 9, 10, 11];

/** The §25.2.2 rows the sheet prints, keyed by the face each one names. */
function sheetRows(cage: RebarLayout): Map<string, boolean> {
  const out = new Map<string, boolean>();   // face → does the row read OK?
  for (const st of generateBreakdown(sec, mat, cage, load, 20).flatMap(s => s.steps ?? [])) {
    if (!String(st.ref).includes('25.2.2')) continue;
    const face = /bottom/i.test(String(st.label)) ? 'Bottom' : 'Top';
    out.set(face, /OK/.test(String(st.result)));
  }
  return out;
}

/** The faces the engine raises a §25.2.2 warning for. */
function engineFaces(cage: RebarLayout): Set<string> {
  return new Set(
    designMember(sec, mat, cage, load, 20).warnings
      .filter(w => w.code === 'ACI §25.2.2')
      .map(w => (/^bottom/i.test(w.message) ? 'Bottom' : 'Top')),
  );
}

describe('§25.2.2 is not checked — neither surface may reintroduce it', () => {
  it('no cage in a 20 736-case sweep raises it, or prints a row for it', () => {
    const engineHits: string[] = [];
    const sheetHits: string[] = [];
    let checked = 0;
    for (const dz of [0.75, 1.0, 1.25, 1.5]) {
      for (const tA of SIZES) for (const tB of [0, ...SIZES]) {
        for (const bA of SIZES) for (const bB of [0, ...SIZES]) {
          const cage: RebarLayout = {
            topBars: tB ? [{ numBars: 3, barSize: tA }, { numBars: 2, barSize: tB }] : [{ numBars: 3, barSize: tA }],
            botBars: bB ? [{ numBars: 3, barSize: bA }, { numBars: 2, barSize: bB }] : [{ numBars: 3, barSize: bA }],
            ties: { barSize: 4, spacing: 6, legs: 2 }, layerClearSpacing: dz,
          };
          checked++;
          if (engineFaces(cage).size && engineHits.length < 4)
            engineHits.push(`dz=${dz} top=[${tA},${tB}] bot=[${bA},${bB}]`);
          if (sheetRows(cage).size && sheetHits.length < 4)
            sheetHits.push(`dz=${dz} top=[${tA},${tB}] bot=[${bA},${bB}]`);
        }
      }
    }
    expect(checked).toBe(20736);
    expect(engineHits).toEqual([]);
    expect(sheetHits).toEqual([]);
  });

  it('the layer gap still moves d, because it places the inner layers', () => {
    // Removing the VERDICT does not make the dimension inert. A wider gap pushes the
    // second layer deeper, the centroid with it, and the sagging capacity down — which
    // is why `layerClearSpacing` stays an input and stays in the Calc Sheet's
    // effective-depth derivation.
    const cage = (dz: number): RebarLayout => ({
      topBars: [{ numBars: 2, barSize: 5 }],
      botBars: [{ numBars: 3, barSize: 9 }, { numBars: 3, barSize: 9 }],
      ties: { barSize: 4, spacing: 6, legs: 2 }, layerClearSpacing: dz,
    });
    const tight = designMember(sec, mat, cage(0.5), load, 20);
    const wide = designMember(sec, mat, cage(2.5), load, 20);
    expect(wide.phi_Mn_pos).toBeLessThan(tight.phi_Mn_pos);
    expect(wide.warnings.some(w => w.code === 'ACI §25.2.2')).toBe(false);
  });
});

describe('the dashboards show every row', () => {
  // Two rows: one sagging (which is what §24.3.2 crack spacing needs) and one pure
  // shear that governs the DCR. Reading the warning list off the governing row alone
  // dropped whatever the sagging row raised.
  const member = {
    id: 'B1', label: 'B1', memberType: 'beam', span: 24,
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 },
    section: { type: 'rectangular_beam', b: 36, h: 20, coverClear: 2.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 2, barSize: 5 }],
      botBars: [{ numBars: 4, barSize: 9 }, { numBars: 4, barSize: 9 }],
      ties: { barSize: 4, spacing: 14, legs: 2 }, layerClearSpacing: 1.0,
    },
    loads: [
      { id: 'r1', label: 'sagging', Mu_pos: 700, Mu_neg: 0, Vu: 20, Tu: 0, Pu: 0 },
      { id: 'r2', label: 'shear', Mu_pos: 0, Mu_neg: 0, Vu: 260, Tu: 0, Pu: 0 },
    ],
  } as unknown as Member;

  it('the list shown is a superset of the governing row', () => {
    const d = designMemberAllRows(member, 'ACI318-19', {});
    const { resultById } = summaryMaps([d]);
    const shown = new Set(resultById.B1.warnings.map(w => w.code));
    const govOnly = new Set(d.governing.row.result.warnings.map(w => w.code));
    for (const c of govOnly) expect(shown.has(c)).toBe(true);
    expect(shown.size).toBeGreaterThanOrEqual(govOnly.size);
  });

  it('a clause raised on a non-governing row still reaches the dashboard', () => {
    const d = designMemberAllRows(member, 'ACI318-19', {});
    const { resultById } = summaryMaps([d]);
    const perRow = d.rows.map(r => new Set(r.result.warnings.map(w => w.code)));
    const union = new Set(perRow.flatMap(s => [...s]));
    const shown = new Set(resultById.B1.warnings.map(w => w.code));
    expect(shown).toEqual(union);
    // and the two rows really do raise different clauses, or this proves nothing
    expect(perRow[0]).not.toEqual(perRow[1]);
  });
});
