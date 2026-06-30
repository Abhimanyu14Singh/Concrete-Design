/**
 * Confirms the app's inputs are reflected in the EC2 (S-Concrete 2026) .SCO:
 * header, section, materials, cover, bars, stirrups, crack-width limit, and the
 * Sectional Loads (forces) — including the SLS quasi-permanent crack row.
 */
import { describe, it, expect } from 'vitest';
import { buildEc2BeamSco, buildEc2ColumnSco, barIndex2026, memberToEc2BeamParams } from '../scoWriterEC2';
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
// Parse the Sectional Loads rows: c1=Nf c2=Tf c3=Vfz c4=Mfy … c14=SustFactor.
function loadRows(text: string) {
  const start = text.indexOf('@Table@16@');
  const end = text.indexOf('@EndTable@', start);
  return text.slice(start, end).split('\n')
    .filter(l => /^\s*\d+\t/.test(l))
    .map(l => { const c = l.split('\t').map(s => s.trim()); return { Nf: +c[1], Tf: +c[2], Vfz: +c[3], Mfy: +c[4], Mfz: +c[7], sust: +c[14] }; });
}

describe('barIndex2026', () => {
  it('maps US bars to the 2026 metric bar table', () => {
    expect(barIndex2026(4)).toBe(3);   // #4 ≈ 12.7 mm → index 3
    expect(barIndex2026(9)).toBe(8);   // #9 ≈ 28.65 mm → index 8
    expect(barIndex2026(-25)).toBe(7); // Ø25 mm → index 7 (25.4)
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

  it('reflects the materials (psi → MPa; fcu from cylinder fc)', () => {
    expect(+param(t, 'fy')!).toBeCloseTo(413.7, 1);     // 60 ksi
    expect(+param(t, 'fcu')!).toBeCloseTo(40, 1);       // 4641 psi cyl → 40 MPa cube
    expect(+param(t, 'Es')!).toBeCloseTo(199948, 0);
  });

  it('reflects the longitudinal bars (single position per face, rest zeroed)', () => {
    expect(param(t, 'Bm NT(1,1)')).toBe('3');
    expect(param(t, 'Bm NB(1,1)')).toBe('4');
    expect(param(t, 'Bm DT(1,1)')).toBe('8');   // #9
    expect(param(t, 'Bm NT(1,2)')).toBe('0');   // sample's 7 cleared
    expect(param(t, 'Bm NbmFace')).toBe('2');   // side bars
  });

  it('reflects the stirrups (size index, spacing mm, legs)', () => {
    expect(param(t, 'Bm Dstir')).toBe('3');     // #4
    expect(+param(t, 'Bm Sstir')!).toBe(152);   // 6 in ≈ 152.4
    expect(param(t, 'Bm NlegsZ')).toBe('2');
  });

  it('reflects the crack-width limit and enables the check', () => {
    expect(param(t, 'Bm CheckCracks')).toBe('1');
    expect(+param(t, 'Bm CrkWdthLmt')!).toBeCloseTo(0.3, 6);
  });

  it('transfers the forces (kips/kip-ft → kN/kN·m; sagging + hogging rows)', () => {
    const rows = loadRows(t);
    expect(rows).toHaveLength(2);                 // sagging + hogging, no SLS combo here
    expect(rows[0].Nf).toBeCloseTo(-17.79, 1);    // -Pu × 4.448
    expect(rows[0].Vfz).toBeCloseTo(756.2, 1);    // Vu × 4.448
    expect(rows[0].Mfy).toBeCloseTo(813.49, 1);   // +Mu_pos × 1.3558 (sagging)
    expect(rows[1].Mfy).toBeCloseTo(-406.75, 1);  // Mu_neg × 1.3558 (hogging)
  });

  it('appends the SLS quasi-permanent crack row from the selected combo', () => {
    const m = beam({ stationForces: [{ combo: 'QP', stations: [{ x: 0, V: 20, M: 150 }] }] });
    const rows = loadRows(buildEc2BeamSco(m, project({ slsCombo: 'QP' })));
    expect(rows).toHaveLength(3);                  // sagging + hogging + SLS
    const sls = rows[2];
    expect(sls.Mfy).toBeCloseTo(150 * 1.355818, 1);
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

function column(): Member {
  return {
    id: 'C1', label: 'C1', memberType: 'column',
    material: { fc: 4641, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
    section: { type: 'rectangular_column', b: 20, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 3, barSize: 9 }], botBars: [{ numBars: 3, barSize: 9 }],
      sideBars: [{ numBars: 4, barSize: 9 }], ties: { barSize: 4, spacing: 12, legs: 2 }, tieType: 'tied',
    },
    loads: [{ id: 'LC1', label: '1.35G+1.5Q', Mu_pos: 0, Mu_neg: 0, Vu: 40, Tu: 10, Pu: 600, Mux: 200, Muy: 120 }],
    span: 12,
  };
}

describe('buildEc2ColumnSco — app inputs reflected (Member Type 3)', () => {
  const t = buildEc2ColumnSco(column());

  it('writes the EC2 column header', () => {
    expect(param(t, 'Codes')).toBe('14');
    expect(param(t, 'Member Type')).toBe('3');   // column in the 2026 format
    expect(param(t, 'Units')).toBe('1');
  });

  it('reflects the column section (Cm bcol/hcol/Cover, in → mm)', () => {
    expect(+param(t, 'Cm bcol')!).toBe(508);   // 20 in
    expect(+param(t, 'Cm hcol')!).toBe(610);   // 24 in
    expect(+param(t, 'Cm Cover')!).toBe(38);   // 1.5 in
  });

  it('reflects the cage: Nzcol/Nycol, bar + tie indices, legs, spacing', () => {
    expect(param(t, 'Cm Nycol')).toBe('3');    // top-face bars
    expect(param(t, 'Cm Nzcol')).toBe('4');    // side/2 + 2
    expect(param(t, 'Cm DVert')).toBe('8');    // #9
    expect(param(t, 'Cm DHorz')).toBe('3');    // #4 tie
    expect(param(t, 'Cm NClegsZ')).toBe('2');
    expect(+param(t, 'Cm Stie')!).toBe(305);   // 12 in ≈ 304.8
  });

  it('forces the short-column check (Slender 0 — app supplies amplified forces)', () => {
    expect(param(t, 'Slender')).toBe('0');
  });

  it('transfers biaxial forces (Nf=-Pu, Mfy=Mux, Mfz=Muy, SustFactor 0.6)', () => {
    const rows = loadRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].Nf).toBeCloseTo(-600 * 4.448222, 1);
    expect(rows[0].Mfy).toBeCloseTo(200 * 1.355818, 1);   // Mux → major
    expect(rows[0].Mfz).toBeCloseTo(120 * 1.355818, 1);   // Muy → minor
    expect(rows[0].sust).toBeCloseTo(0.6, 6);
  });
});
