/**
 * The Group Dashboard's mode columns must ACCOUNT FOR the DCR column.
 *
 * Reported as "M and shear DCR are 0.6 at max but the DCR column says 1.59". The DCR
 * column is worstOf(), which takes the max over flexure, shear, torsion, P-M, axial and
 * the combined shear+torsion link utilisation. modeDCRs() — which feeds the M⁺/M⁻/V
 * chips beside it — returned only flexure and shear, and folded in neither torsion nor
 * VT_util. So a torsion-governed beam showed three green chips next to a red number
 * with nothing on the row to explain it. In the demo's 174-beam model that was 43 beams.
 *
 * The invariant worth pinning is not "torsion is a field" but the relationship: for a
 * beam, every term worstOf() can pick must be visible in some column. If a future check
 * is added to worstOf() without a column, this fails.
 */
import { describe, it, expect } from 'vitest';
import { modeDCRs, worstOf } from '../dashboardShared';
import type { DesignResults } from '../../../types';

/** A DesignResults with only the fields these two functions read. */
function results(over: Partial<DesignResults>): DesignResults {
  return {
    DCR_flex_pos: 0, DCR_flex_neg: 0, DCR_shear: 0, DCR_torsion: 0,
    ...over,
  } as DesignResults;
}

/** The largest number the beam row can actually show, across its columns. */
const shown = (r: DesignResults, code: 'ACI318-19' | 'EN1992-1-1' = 'ACI318-19') => {
  const m = modeDCRs(r, code);
  return Math.max(m.flexPos, m.flexNeg, m.shear, m.torsion, m.wk ?? 0);
};

describe('modeDCRs vs worstOf — the DCR column must be explainable', () => {
  it('reports torsion, so a torsion-governed beam is not three green chips beside 1.59', () => {
    // The reported shape, to the reported numbers.
    const r = results({ DCR_flex_pos: 0.52, DCR_flex_neg: 0.60, DCR_shear: 0.47, DCR_torsion: 1.59 });
    expect(modeDCRs(r, 'ACI318-19').torsion).toBeCloseTo(1.59, 6);
    expect(worstOf(r)).toBeCloseTo(1.59, 6);
    expect(shown(r)).toBeCloseTo(worstOf(r), 6);   // ← the column now explains the number
  });

  it('folds the combined shear+torsion utilisation into V, as the Dashboard tab does', () => {
    // VT_util alone used to be invisible here while still driving worstOf().
    const r = results({ DCR_flex_pos: 0.3, DCR_shear: 0.4, VT_util: 0.97 });
    expect(modeDCRs(r, 'ACI318-19').shear).toBeCloseTo(0.97, 6);
    expect(shown(r)).toBeCloseTo(worstOf(r), 6);
  });

  it('no beam-mode result can govern without a column to show it', () => {
    // One case per term worstOf() takes the max of that a BEAM can produce.
    const cases: Partial<DesignResults>[] = [
      { DCR_flex_pos: 1.4 },
      { DCR_flex_neg: 1.4 },
      { DCR_shear: 1.4 },
      { DCR_torsion: 1.4 },
      { VT_util: 1.4 },
      { DCR_flex_pos: 0.6, DCR_flex_neg: 0.6, DCR_shear: 0.6, DCR_torsion: 1.59 }, // the report
    ];
    for (const c of cases) {
      const r = results(c);
      expect(shown(r), `governing term unexplained by any column: ${JSON.stringify(c)}`)
        .toBeCloseTo(worstOf(r), 6);
    }
  });

  it('crack width still only appears under EC2', () => {
    const r = results({ DCR_flex_pos: 0.4, DCR_crack: 1.2 });
    expect(modeDCRs(r, 'EN1992-1-1').wk).toBeCloseTo(1.2, 6);
    expect(modeDCRs(r, 'ACI318-19').wk).toBeUndefined();
  });
});
