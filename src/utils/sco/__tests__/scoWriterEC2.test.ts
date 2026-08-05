/**
 * Confirms the app's inputs are reflected in the EC2 (S-Concrete 2026) .SCO:
 * header, section, materials, cover, bars, stirrups, crack-width limit, and the
 * Sectional Loads (forces) — including the SLS quasi-permanent crack row.
 */
import { describe, it, expect } from 'vitest';
import { buildEc2BeamSco, barIndexEC2, memberToEc2BeamParams } from '../scoWriterEC2';
import type { Member, Project } from '../../../types';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p', name: 'Tower', code: 'EN1992-1-1', description: '', engineer: 'EOR', date: '2026-06-30',
  members: [], ...over,
});

function beam(over: { loads?: Member['loads']; stationForces?: Member['stationForces'] } = {}): Member {
  return {
    id: 'B1', label: 'B1', memberType: 'beam',
    material: { fc: 4641, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: 20, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 3, barSize: 9 }], botBars: [{ numBars: 4, barSize: 9 }],
      sideBars: [{ numBars: 2, barSize: 5 }], ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    loads: over.loads ?? [{ id: 'LC1', label: '1.35G+1.5Q', Mu_pos: 600, Mu_neg: -300, Vu: 170, Tu: 0, Pu: 4 }],
    span: 20, crackParams: { wLimitTop: 0.3, wLimitBot: 0.3, wLimitFace: 0.3, qpFactor: 0.6, kt: 0.4 },
    stationForces: over.stationForces,
  };
}

// Read a `Key\t value` field from the .SCO text.
function param(text: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`${esc}\\t ?([^\\t\\n]*)`));
  return m ? m[1].trim() : null;
}
// Parse the Sectional Loads rows: c1=Nf c2=Tf c3=Vfz c4=Mfy c6=Vfy c7=Mfz … c14=SustFactor.
function loadRows(text: string) {
  const start = text.indexOf('@Table@16@');
  const end = text.indexOf('@EndTable@', start);
  return text.slice(start, end).split('\n')
    .filter(l => /^\s*\d+\t/.test(l))
    .map(l => { const c = l.split('\t').map(s => s.trim()); return { Nf: +c[1], Tf: +c[2], Vfz: +c[3], Mfy: +c[4], Vfy: +c[6], Mfz: +c[7], sust: +c[14] }; });
}

describe('barIndexEC2', () => {
  it('maps metric bars to their S-Concrete European bar-table index (position)', () => {
    // The exact "European Reinforcing Bars" table from a real .SCRS report:
    // [Ø6, Ø8, Ø10, Ø12, Ø14, Ø16, Ø20, Ø25, Ø28, Ø32, Ø40, Ø50] (index 1–12).
    expect(barIndexEC2(-8)).toBe(2);   // Ø8  → 2
    expect(barIndexEC2(-10)).toBe(3);  // Ø10 → 3
    expect(barIndexEC2(-12)).toBe(4);  // Ø12 → 4
    expect(barIndexEC2(-14)).toBe(5);  // Ø14 → 5
    expect(barIndexEC2(-16)).toBe(6);  // Ø16 → 6 (a table missing Ø14 gave 5 = Ø14 — the bug)
    expect(barIndexEC2(-20)).toBe(7);  // Ø20 → 7
    expect(barIndexEC2(-25)).toBe(8);  // Ø25 → 8
    expect(barIndexEC2(-32)).toBe(10); // Ø32 → 10
  });
  it('maps US bars to the nearest European diameter', () => {
    expect(barIndexEC2(4)).toBe(4);    // #4 ≈ 12.7 mm → Ø12
    expect(barIndexEC2(8)).toBe(8);    // #8 ≈ 25.4 mm → Ø25
  });

  it('maps EVERY app metric bar to its exact S-Concrete index (no rounding)', () => {
    // The app's picker offers Ø8..Ø40 (utils/rebar METRIC_BAR_DIAMETERS); each is
    // an exact row in the .SCRS European table, so it must land on that exact index
    // — including the larger Ø25 → 8 and Ø32 → 10.
    const expected: Record<number, number> = { 8: 2, 10: 3, 12: 4, 16: 6, 20: 7, 25: 8, 32: 10, 40: 11 };
    for (const dia of Object.keys(expected).map(Number)) {
      expect(barIndexEC2(-dia)).toBe(expected[dia]);
    }
  });
});

describe('buildEc2BeamSco — app inputs are reflected', () => {
  const t = buildEc2BeamSco(beam(), project());

  it('writes the EC2 header (EN 1992-1-1, SI, beam)', () => {
    expect(param(t, 'Codes')).toBe('14');
    expect(param(t, 'Units')).toBe('1');
    expect(param(t, 'Bar Type')).toBe('8');
    expect(param(t, 'Member Type')).toBe('2');
  });

  it('reflects the section (in → mm)', () => {
    expect(+param(t, 'Bm b')!).toBe(508);          // 20 in
    expect(+param(t, 'Bm h')!).toBe(610);          // 24 in ≈ 609.6
    expect(param(t, 'Bm IgnoreFlange')).toBe('1'); // rectangular
    expect(+param(t, 'Bm Top')!).toBe(38);         // 1.5 in cover
  });

  it('reflects the materials — S-Concrete EN fcu field holds the CYLINDER fck', () => {
    expect(+param(t, 'fy')!).toBeCloseTo(413.7, 1);     // 60 ksi
    // 4641 psi = 32 MPa cylinder → pushed straight through (NOT ÷0.8 to a cube).
    // S-Concrete's EN files store fck there (its Ec is Ecm(fck), not Ecm(fck_cube)).
    expect(+param(t, 'fcu')!).toBeCloseTo(32, 1);
    expect(+param(t, 'Es')!).toBeCloseTo(199948, 0);
  });

  it('pushes the cylinder fck straight through (C40/50 → 40, C50/60 → 50)', () => {
    const m40 = beam(); m40.material = { ...m40.material, fc: 40 * 145.0377 }; // 40 MPa cyl
    expect(+param(buildEc2BeamSco(m40, project()), 'fcu')!).toBeCloseTo(40, 1);
    const m50 = beam(); m50.material = { ...m50.material, fc: 50 * 145.0377 }; // 50 MPa cyl (the sample)
    expect(+param(buildEc2BeamSco(m50, project()), 'fcu')!).toBeCloseTo(50, 1);
  });

  it('reflects the longitudinal bars (one layer when they fit the width)', () => {
    expect(param(t, 'Bm NT(1,1)')).toBe('3');
    expect(param(t, 'Bm NB(1,1)')).toBe('4');
    expect(param(t, 'Bm DT(1,1)')).toBe('9');   // #9 ≈ 28.65 mm → Ø28 (index 9)
    expect(param(t, 'Bm NT(1,2)')).toBe('0');   // 3 top bars fit one layer → 2nd layer empty
    expect(param(t, 'Bm NbmFace')).toBe('2');   // side bars
    expect(param(t, 'Bm ApplyFace')).toBe('1'); // cage has side bars → design face steel ON
  });

  it('turns face steel OFF for a beam with no side bars (no S-Concrete-invented skin)', () => {
    // The template ships Bm ApplyFace = 1, so without honouring the cage S-Concrete
    // designs face/skin steel even on shallow beams that carry none in the app.
    const m = beam();
    m.rebar = { ...m.rebar, sideBars: undefined };
    const noFace = buildEc2BeamSco(m, project());
    expect(param(noFace, 'Bm ApplyFace')).toBe('0');
    expect(param(noFace, 'Bm NbmFace')).toBe('0');
  });

  it('splits a face too wide for one row into stacked layers (NB(1,1)+NB(1,2))', () => {
    // 8 bottom bars in a 12" web: ≥ max(1", db) clear spacing fits 4 per layer,
    // so S-Concrete must receive two rows of 4 — not one impossible row of 8.
    const m = beam();
    m.section = { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 };
    m.rebar = { ...m.rebar, botBars: [{ numBars: 8, barSize: 9 }], topBars: [{ numBars: 3, barSize: 9 }] };
    const tt = buildEc2BeamSco(m, project());
    expect(param(tt, 'Bm NB(1,1)')).toBe('4');   // layer 1
    expect(param(tt, 'Bm NB(1,2)')).toBe('4');   // layer 2 (the bug emitted 0 here)
    expect(param(tt, 'Bm NB(1,3)')).toBe('0');
    expect(param(tt, 'Bm DB(1,2)')).toBe('9');   // both layers same bar size
    expect(param(tt, 'Bm NT(1,1)')).toBe('3');   // 3 top bars still fit one layer
    expect(param(tt, 'Bm NT(1,2)')).toBe('0');
  });

  it('reflects the stirrups (size index, spacing mm, legs)', () => {
    expect(param(t, 'Bm Dstir')).toBe('4');     // #4 ≈ 12.7 mm → Ø12 (index 4)
    expect(+param(t, 'Bm Sstir')!).toBe(152);   // 6 in ≈ 152.4
    expect(param(t, 'Bm NlegsZ')).toBe('2');
  });

  it('reflects the crack-width limit and enables the check', () => {
    expect(param(t, 'Bm CheckCracks')).toBe('1');
    expect(param(t, 'Bm CheckCracksF')).toBe('1');
    expect(+param(t, 'Bm CrkWdthLmt')!).toBeCloseTo(0.3, 6);
  });

  it('transfers the forces (kips/kip-ft → kN/kN·m; sagging + hogging rows)', () => {
    const rows = loadRows(t);
    expect(rows).toHaveLength(2);                 // sagging + hogging, no SLS combo here
    expect(rows[0].Nf).toBeCloseTo(-17.79, 1);    // -Pu × 4.448
    expect(rows[0].Vfz).toBeCloseTo(756.2, 1);    // Vu × 4.448
    expect(rows[0].Mfy).toBeCloseTo(813.49, 1);   // Mu_pos envelope → +My
    expect(rows[1].Mfy).toBeCloseTo(-406.75, 1);  // Mu_neg envelope → −My
  });

  it('appends the SLS quasi-permanent crack row from the selected combo', () => {
    const m = beam({ stationForces: [{ combo: 'QP', stations: [{ x: 0, V: 20, M: 150 }] }] });
    const rows = loadRows(buildEc2BeamSco(m, project({ slsCombo: 'QP' })));
    expect(rows).toHaveLength(3);                  // sagging + hogging + SLS
    const sls = rows[2];
    expect(sls.Mfy).toBeCloseTo(150 * 1.355818, 1);    // Mqp_pos envelope → +My
    expect(sls.Vfz).toBeCloseTo(20 * 4.448222, 1);
    expect(sls.sust).toBeCloseTo(0.6, 6);          // quasi-permanent factor
  });

  it('handles a T-beam flange (bf, hf, IgnoreFlange 0)', () => {
    const m = beam();
    m.section = { type: 'T_beam', b: 60, h: 24, bw: 14, hf: 5, coverClear: 1.5, stirrupDia: 4 };
    const params = memberToEc2BeamParams(m, project());
    expect(params.webMm).toBeCloseTo(14 * 25.4, 3);
    expect(params.flangeWidthMm).toBeCloseTo(60 * 25.4, 3);
    expect(params.ignoreFlange).toBe(false);
  });
});

