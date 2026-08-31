/**
 * What a re-imported set of forces has to change.
 *
 * The bug this exists to prevent shipped once and was invisible in exactly the wrong
 * way. A member carries the analysis output in TWO shapes: `stationForces` (raw, per
 * combo, per station) and `loads` (those stations expanded into one LoadCase each).
 * The force diagram reads the first; every DCR, the calc sheet and every applied-force
 * readout run off the second.
 *
 * Writing only `stationForces` after a re-analysis therefore moved the picture and left
 * the numbers — the design went on being checked against the demand from before the
 * sections were resized, which flatters exactly the members that were just enlarged.
 * Worse, the two halves of the screen then disagreed with nothing to say which was right.
 */
import { describe, it, expect } from 'vitest';
import { stationLoadCases } from '../../adapters/etabs';
import { designMemberAllRows } from '../design.js';
import type { ComboForces, Member } from '../../types';

const beam = (): Member => ({
  id: 'm1', label: 'B1', memberType: 'beam',
  material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
  section: { type: 'rectangular_beam', b: 18, h: 60, coverClear: 1.5, stirrupDia: 4 },
  rebar: {
    topBars: [{ numBars: 4, barSize: 9 }], botBars: [{ numBars: 4, barSize: 9 }],
    ties: { barSize: 4, spacing: 6, legs: 2 },
  },
  loads: [], span: 25,
  etabs: {
    frameName: 'F17', story: 'L2', groups: [], sectionName: 'B18X60',
    pt1: { x: 0, y: 0, z: 0 }, pt2: { x: 25, y: 0, z: 0 },
  },
});

const forces = (M: number, V: number): ComboForces[] => ([{
  combo: 'ENV_U',
  stations: [
    { x: 0, M: -M, V },
    { x: 12.5, M: M * 0.6, V: 0 },
    { x: 25, M: -M, V: -V },
  ],
}]);

/** The re-import, as the push step performs it: BOTH fields, from one set of forces. */
const reimport = (m: Member, f: ComboForces[]): Member =>
  ({ ...m, stationForces: f, loads: stationLoadCases(f, 'ETABS env (ENV_U)', m.span) });

describe('re-importing forces after a re-analysis', () => {
  it('changes the DCRs — not only the force diagram', () => {
    // This is the whole failure. `loads` is what the engine designs against.
    const before = reimport(beam(), forces(400, 90));
    const after = reimport(before, forces(900, 200));

    const dcrBefore = designMemberAllRows(before, 'ACI318-19', {}).dcr;
    const dcrAfter = designMemberAllRows(after, 'ACI318-19', {}).dcr;
    expect(dcrAfter).toBeGreaterThan(dcrBefore);
  });

  it('writes stationForces AND loads, so the picture and the numbers agree', () => {
    const m = reimport(beam(), forces(900, 200));
    expect(m.stationForces).toHaveLength(1);
    expect(m.loads.length).toBeGreaterThan(0);
    // Every load row must have come from the new forces, not survive from the old set.
    const worstMu = Math.max(...m.loads.map(l => Math.max(l.Mu_pos, l.Mu_neg)));
    expect(worstMu).toBeCloseTo(900, 0);
  });

  it('leaves nothing of the previous forces behind', () => {
    // A merge that appended rather than replaced would keep designing against the old
    // envelope, and the max-across-rows rule would hide it — the old worst case would
    // simply keep governing.
    const before = reimport(beam(), forces(900, 200));
    const after = reimport(before, forces(300, 60));
    const worstMu = Math.max(...after.loads.map(l => Math.max(l.Mu_pos, l.Mu_neg)));
    expect(worstMu).toBeLessThan(400);
    expect(after.stationForces!.flatMap(c => c.stations).every(st => Math.abs(st.M) <= 300 + 1e-6)).toBe(true);
  });

  it('carries the SAME combo set the model was imported under', () => {
    const m = reimport(beam(), forces(500, 100));
    expect(m.stationForces!.map(c => c.combo)).toEqual(['ENV_U']);
    expect(m.loads.every(l => l.label.includes('ENV_U'))).toBe(true);
  });

  it('a lighter re-analysis lowers the DCR, so the change is not one-way', () => {
    const heavy = reimport(beam(), forces(900, 200));
    const light = reimport(heavy, forces(200, 50));
    expect(designMemberAllRows(light, 'ACI318-19', {}).dcr)
      .toBeLessThan(designMemberAllRows(heavy, 'ACI318-19', {}).dcr);
  });
});

describe('matching members to the frames the forces came back for', () => {
  it('keys off the member’s own ETABS frame name', () => {
    const m = beam();
    const byFrame: Record<string, ComboForces[]> = { F17: forces(700, 150), F99: forces(1, 1) };
    const next = byFrame[m.etabs!.frameName];
    expect(next).toBeDefined();
    expect(Math.abs(next[0].stations[0].M)).toBe(700);
  });

  it('leaves a member alone when its frame is not in the result', () => {
    // Only the pushed frames are re-read; everything else keeps the forces it had, and
    // must not be blanked.
    const m = reimport(beam(), forces(400, 90));
    const byFrame: Record<string, ComboForces[]> = { SOMEONE_ELSE: forces(999, 999) };
    const next = byFrame[m.etabs!.frameName];
    const result = next?.length ? reimport(m, next) : m;
    expect(result).toBe(m);
    expect(Math.max(...result.loads.map(l => Math.max(l.Mu_pos, l.Mu_neg)))).toBeCloseTo(400, 0);
  });
});

/**
 * The baseline: what rev 1 is different FROM.
 *
 * A push freezes the working model — so after the first push, "Working model" and
 * "rev 1" hold the same members and the picker shows the same everything twice. The
 * state worth comparing against is the model as it was IMPORTED: original sections,
 * original forces, before the resize that prompted the push. Nothing was keeping it.
 *
 * These pin the two halves of that: the baseline must be a genuinely different design
 * from the pushed one, and switching between them must move the numbers an engineer
 * reads — not just the section dimensions.
 */
describe('as-imported baseline vs the pushed revision', () => {
  /** The model as imported: 18×60 on the original analysis. */
  const asImported = () => reimport(beam(), forces(400, 90));

  /** After resizing to 24×72 and re-analysing — stiffer, so it attracts more moment. */
  const rev1 = () => {
    const m = asImported();
    return reimport(
      { ...m, section: { ...m.section, b: 24, h: 72 } },
      forces(620, 130),
    );
  };

  it('holds different SECTIONS', () => {
    expect(asImported().section.h).toBe(60);
    expect(rev1().section.h).toBe(72);
  });

  it('holds different FORCES — the redistribution the re-analysis found', () => {
    const a = Math.max(...asImported().loads.map(l => Math.max(l.Mu_pos, l.Mu_neg)));
    const b = Math.max(...rev1().loads.map(l => Math.max(l.Mu_pos, l.Mu_neg)));
    expect(b).toBeGreaterThan(a);
  });

  it('and therefore different DCRs — which is what makes the picker worth having', () => {
    const a = designMemberAllRows(asImported(), 'ACI318-19', {}).dcr;
    const b = designMemberAllRows(rev1(), 'ACI318-19', {}).dcr;
    expect(a).not.toBeCloseTo(b, 3);
  });

  it('freezing does not alias — editing one must not move the other', () => {
    // The snapshot is a shallow copy per member. What must hold is that replacing a
    // member's fields on the live model leaves the frozen one alone; an in-place mutation
    // of a shared nested object would silently rewrite history.
    const base = asImported();
    const frozen = [base].map(m => ({ ...m }));
    const live = { ...base, section: { ...base.section, h: 72 }, loads: rev1().loads };
    expect(frozen[0].section.h).toBe(60);
    expect(Math.max(...frozen[0].loads.map(l => Math.max(l.Mu_pos, l.Mu_neg)))).toBeCloseTo(400, 0);
    expect(live.section.h).toBe(72);
  });
});
