/**
 * Confirms that .SCO files can be extracted for the BEAM design groups the user
 * creates in the app, with every load case's forces actively transferred into
 * the S-Concrete Sectional Loads table. Forces are verified by PARSING the
 * emitted .SCO (not substring matching), so a regression in the force mapping
 * fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { buildScoFilesByGroup, buildGroupScoFiles, collectGroupScoFiles } from '../scoBatch';
import type { Member, DesignGroup, Project } from '../../../types';

// ── Sectional Loads (Table 16) parser ─────────────────────────────────────────
// Row layout (scoWriter lcRow): i, Nf(P), Tf(T), Vfz(V2), Mfy(M3), Cmy, Vfy(V3),
// Mfz(M2), … — tab-delimited.
interface SoLoadRow { Nf: number; Tf: number; Vfz: number; Mfy: number; Vfy: number; Mfz: number }
function sectionalLoadRows(sco: string): SoLoadRow[] {
  const start = sco.indexOf('@Table@16@');
  if (start < 0) return [];
  const end = sco.indexOf('@EndTable@', start);
  const block = sco.slice(start, end);
  return block.split('\n')
    .filter(l => /^\s*\d+\t/.test(l))            // data rows start " <i>\t"; header "LC\t…" excluded
    .map(l => {
      const c = l.split('\t').map(s => s.trim());
      return { Nf: +c[1], Tf: +c[2], Vfz: +c[3], Mfy: +c[4], Vfy: +c[6], Mfz: +c[7] };
    });
}

type LC = Member['loads'][number];
const lc = (over: Partial<LC>): LC => ({
  id: over.id ?? 'LC', label: over.label ?? 'combo',
  Mu_pos: over.Mu_pos ?? 0, Mu_neg: over.Mu_neg ?? 0, Vu: over.Vu ?? 0,
  Tu: over.Tu ?? 0, Pu: over.Pu ?? 0, ...over,
});

function beam(id: string, label: string, loads: LC[] = [lc({ Mu_pos: 180, Mu_neg: -90, Vu: 45, Tu: 8, Pu: 0 })]): Member {
  return {
    id, label, memberType: 'beam',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: { topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 3, barSize: 9 }], ties: { barSize: 4, spacing: 6, legs: 2 } },
    loads, span: 20,
  };
}
// A circular column. Under ACI it now routes to the Version-2026.0 (Type 4)
// writer; under EC2 it is still unsupported, so EC2 tests use it as the member
// the batch must skip.
const group = (id: string, label: string, memberIds: string[]): DesignGroup => ({ id, label, memberIds });

describe('buildScoFilesByGroup — group → .SCO extraction', () => {
  it('extracts one .SCO per beam in the group, keyed by member', () => {
    const members = [beam('b1', 'B1'), beam('b2', 'B2'), beam('bx', 'BX')];
    const bundles = buildScoFilesByGroup([group('g1', 'Perimeter', ['b1', 'b2'])], members, 'ACI318-19');
    expect(bundles).toHaveLength(1);
    expect(bundles[0].groupId).toBe('g1');
    expect(bundles[0].groupLabel).toBe('Perimeter');
    expect(bundles[0].files.map(f => f.fileName).sort()).toEqual(['B1.SCO', 'B2.SCO']);
    expect(bundles[0].files.map(f => f.memberId).sort()).toEqual(['b1', 'b2']);
  });

  it('resolves memberIds against the project and skips ids not present', () => {
    const members = [beam('b1', 'B1')];
    const bundles = buildScoFilesByGroup([group('g1', 'G', ['b1', 'ghost'])], members, 'ACI318-19');
    expect(bundles[0].files).toHaveLength(1);
    expect(bundles[0].files[0].memberId).toBe('b1');
  });

  it('returns one bundle per group, preserving id and label', () => {
    const members = [beam('b1', 'B1'), beam('b2', 'B2')];
    const bundles = buildScoFilesByGroup(
      [group('g1', 'G1', ['b1']), group('g2', 'G2', ['b2'])], members, 'ACI318-19');
    expect(bundles.map(b => b.groupLabel)).toEqual(['G1', 'G2']);
    expect(bundles[0].files[0].memberId).toBe('b1');
    expect(bundles[1].files[0].memberId).toBe('b2');
  });

  it('an empty group yields an empty file list', () => {
    const bundles = buildScoFilesByGroup([group('g1', 'Empty', [])], [beam('b1', 'B1')], 'ACI318-19');
    expect(bundles[0].files).toEqual([]);
  });
});

describe('force transfer — every load/force lands in the right field', () => {
  function rowsFor(m: Member): SoLoadRow[] {
    const files = buildScoFilesByGroup([group('g', 'G', [m.id])], [m], 'ACI318-19')[0].files;
    return sectionalLoadRows(files[0].text);
  }

  it('transfers Pu→Nf, Tu→Tf and Vu→Vfz — the shear that PAIRS with Mfy', () => {
    const rows = rowsFor(beam('b1', 'B1', [lc({ Mu_pos: 180, Mu_neg: -90, Vu: 45, Tu: 8, Pu: 25 })]));
    // The table pairs (Vfz, Mfy) and (Vfy, Mfz). A beam's major-axis moment goes to
    // Mfy, so its shear MUST go to Vfz — putting it in Vfy gave S-Concrete major
    // bending with no shear plus a minor-axis shear with no moment.
    expect(rows[0]).toEqual({ Nf: -25, Tf: 8, Vfz: 45, Mfy: 180, Vfy: 0, Mfz: 0 });
  });

  it('emits BOTH faces per load case: a sagging row and a signed hogging row', () => {
    // max(|M+|, |M−|) collapsed the two into one positive number, so only one face
    // was ever checked — a hogging moment was checked against the bottom steel.
    const rows = rowsFor(beam('b1', 'B1', [lc({ Mu_pos: 180, Mu_neg: -90, Vu: 45, Tu: 8, Pu: 25 })]));
    expect(rows).toHaveLength(2);
    expect(rows[0].Mfy).toBe(180);    // sagging → +My, checks the bottom cage
    expect(rows[1].Mfy).toBe(-90);    // hogging → −My, checks the top cage
    expect(rows[1]).toMatchObject({ Nf: -25, Tf: 8, Vfz: 45 });  // same shear/torsion/axial
  });

  it('emits a sagging-only row when there is no hogging moment', () => {
    const rows = rowsFor(beam('b', 'B', [lc({ Mu_pos: 120, Mu_neg: 0, Vu: 30 })]));
    expect(rows).toHaveLength(1);
    expect(rows[0].Mfy).toBe(120);
  });

  it('emits one pair per load case, in order, each carrying its own forces', () => {
    const rows = rowsFor(beam('b1', 'B1', [
      lc({ label: 'D+L', Mu_pos: 120, Mu_neg: -60, Vu: 30, Tu: 5, Pu: 10 }),
      lc({ label: 'D+W', Mu_pos: 200, Mu_neg: -150, Vu: 55, Tu: 9, Pu: 0 }),
      lc({ label: 'D+E', Mu_pos: 90, Mu_neg: -260, Vu: 70, Tu: 0, Pu: -15 }),
    ]));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ Nf: -10, Tf: 5, Vfz: 30, Mfy: 120, Vfy: 0, Mfz: 0 });
    expect(rows[1]).toEqual({ Nf: -10, Tf: 5, Vfz: 30, Mfy: -60, Vfy: 0, Mfz: 0 });
    expect(rows[2]).toEqual({ Nf: 0, Tf: 9, Vfz: 55, Mfy: 200, Vfy: 0, Mfz: 0 });
    expect(rows[3]).toEqual({ Nf: 0, Tf: 9, Vfz: 55, Mfy: -150, Vfy: 0, Mfz: 0 });
    // tension axial preserved; the heavy hogging keeps its own sign
    // Pu = −15 is TENSION, so it leaves as Nf = +15.
    expect(rows[4]).toEqual({ Nf: 15, Tf: 0, Vfz: 70, Mfy: 90, Vfy: 0, Mfz: 0 });
    expect(rows[5]).toEqual({ Nf: 15, Tf: 0, Vfz: 70, Mfy: -260, Vfy: 0, Mfz: 0 });
  });

  it('keeps sagging and hogging on OPPOSITE signs, whichever is larger', () => {
    expect(rowsFor(beam('b', 'B', [lc({ Mu_pos: 50, Mu_neg: -300, Vu: 20 })])).map(r => r.Mfy)).toEqual([50, -300]);
    expect(rowsFor(beam('b', 'B', [lc({ Mu_pos: 240, Mu_neg: -30, Vu: 20 })])).map(r => r.Mfy)).toEqual([240, -30]);
  });

  it('is an ACTIVE transfer — changing a force changes the emitted .SCO', () => {
    const a = rowsFor(beam('b', 'B', [lc({ Mu_pos: 100, Vu: 45 })]))[0];
    const b = rowsFor(beam('b', 'B', [lc({ Mu_pos: 100, Vu: 99 })]))[0];
    expect(a.Vfz).toBe(45);
    expect(b.Vfz).toBe(99);
    expect(a.Vfz).not.toBe(b.Vfz);
  });

  it('writes fractional forces at the 2026 row precision (3 dp)', () => {
    // The legacy V7 writer rounded every force to 1 decimal; the 2026 row format
    // keeps 3, so a 123.46 kip-ft demand is no longer quietly nudged to 123.5.
    const rows = rowsFor(beam('b', 'B', [lc({ Mu_pos: 123.456789, Vu: 45.27, Pu: 12.34 })]));
    expect(rows[0].Mfy).toBeCloseTo(123.457, 5);
    expect(rows[0].Vfz).toBeCloseTo(45.27, 5);
    expect(rows[0].Nf).toBeCloseTo(-12.34, 5);   // negated: compression-positive → compression-negative
  });
});

describe('the ACI beam .SCO carries the app\'s actual beam', () => {
  // Read a `Key\t value` field. The key must START a field (line start or after a
  // tab) so it cannot match the tail of a longer field name.
  function param(sco: string, key: string): string | null {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = sco.match(new RegExp(`(?:^|\\t)${esc}\\t ?([^\\t\\r\\n]*)`, 'm'));
    return m ? m[1].trim() : null;
  }
  const scoFor = (m: Member): string => buildGroupScoFiles([m], 'ACI318-19')[0].text;

  it('is a real S-Concrete 2026 ACI / imperial beam file', () => {
    // Matched against Examples/SCRS/Level_3_B14X28_S12.SCO, saved by S-Concrete
    // itself. The ACI beam file is the SAME 2026 format as the EN one, with
    // Member Type 2 — not the legacy Version-7 / Member-Type-1 file we used to emit.
    const t = scoFor(beam('b', 'B'));
    expect(t.includes('Version\t2026.0')).toBe(true);
    expect(param(t, 'Member Type')).toBe('2');
    expect(param(t, 'Codes')).toBe('18');        // ACI 318
    expect(param(t, 'Units')).toBe('0');         // imperial
    expect(param(t, 'Bar Type')).toBe('2');      // US #-bars
  });

  it('writes the REAL top/bottom cage, not the column writer\'s literals', () => {
    // The old writer built a column and swapped the member type, so every ACI beam
    // carried a hardcoded 2+3 top / 2+2 bottom of one bar size, whatever was designed.
    const m = beam('b', 'B');
    m.rebar = {
      topBars: [{ numBars: 3, barSize: 8 }],
      botBars: [{ numBars: 4, barSize: 9 }],
      ties: { barSize: 4, spacing: 6, legs: 4 },
    };
    const t = scoFor(m);
    expect(param(t, 'Bm NT(1,1)')).toBe('3');
    expect(param(t, 'Bm NB(1,1)')).toBe('4');
    expect(param(t, 'Bm NT(2,1)')).toBe('0');    // curtain 2 unused (was a stray 3)
    expect(param(t, 'Bm NB(2,1)')).toBe('0');    // (was a stray 2)
    expect(param(t, 'Bm DT(1,1)')).toBe('7');    // #8 → bar-table index 7
    expect(param(t, 'Bm DB(1,1)')).toBe('8');    // #9 → index 8, per FACE
    expect(param(t, 'Bm NlegsZ')).toBe('4');     // 4-leg ties (was hardcoded 2)
  });

  it('honours the cage on skin bars instead of letting S-Concrete invent them', () => {
    const bare = scoFor(beam('b', 'B'));
    expect(param(bare, 'Bm ApplyFace')).toBe('0');      // no side bars → face steel OFF
    expect(param(bare, 'Bm NbmFace')).toBe('0');

    const m = beam('b', 'B');
    m.section = { type: 'rectangular_beam', b: 14, h: 48, coverClear: 1.5, stirrupDia: 4 };
    m.rebar = { ...m.rebar, sideBars: [{ numBars: 3, barSize: 5 }] };   // 3 PER FACE
    const t = scoFor(m);
    expect(param(t, 'Bm ApplyFace')).toBe('1');
    expect(param(t, 'Bm NbmFace')).toBe('6');           // NbmFace counts both faces
    expect(param(t, 'Bm DbmFace')).toBe('4');           // #5 → index 4
    // Geometry closes on the real depth: 2·Z + (n−1)·S = h, as in the sample.
    const S = +param(t, 'Bm SbmFace')!, Z = +param(t, 'Bm ZbmFace')!;
    expect(2 * Z + 2 * S).toBeCloseTo(48, 3);
  });

  it('carries a T-beam flange and the per-face covers', () => {
    const m = beam('b', 'B');
    m.section = {
      type: 'T_beam', b: 48, h: 24, bw: 14, hf: 6, coverClear: 1.5,
      coverTop: 2, coverBottom: 1.75, coverSide: 1.5, stirrupDia: 4,
    };
    const t = scoFor(m);
    expect(param(t, 'Bm b')).toBe('14');              // web
    expect(param(t, 'Bm bf')).toBe('48');             // flange width (was collapsed to the web)
    expect(param(t, 'Bm hf')).toBe('6');              // (was a hardcoded 7)
    expect(param(t, 'Bm IgnoreFlange')).toBe('0');
    expect(param(t, 'Bm Top')).toBe('2');
    expect(param(t, 'Bm Bottom')).toBe('1.75');
  });

  it('keeps a metric-derived width instead of rounding it to whole inches', () => {
    const m = beam('b', 'B');
    m.section = { type: 'rectangular_beam', b: 11.811, h: 23.622, coverClear: 1.5, stirrupDia: 4 }; // 300×600
    expect(param(scoFor(m), 'Bm b')).toBe('11.811');
  });

  it('a rectangular beam ignores the flange', () => {
    const t = scoFor(beam('b', 'B'));
    expect(param(t, 'Bm IgnoreFlange')).toBe('1');
    expect(param(t, 'Bm hf')).toBe('0');
  });
});

describe('zoned stirrups — one .SCO per spacing, each with its own rows', () => {
  const zoned = (): Member => {
    const m = beam('b', 'B', [
      lc({ id: 'a', label: 'C1@0', Mu_neg: -200, Vu: 60, x: 0 }),
      lc({ id: 'b', label: 'C1@10', Mu_pos: 150, Vu: 6, x: 10 }),
      lc({ id: 'c', label: 'C1@20', Mu_neg: -190, Vu: -58, x: 20 }),
    ]);
    m.rebar = { ...m.rebar, ties: { barSize: 4, spacing: 4, legs: 2 },
      tieZones: [{ spacing: 4 }, { spacing: 8 }, { spacing: 4 }] };
    return m;
  };

  it('splits a 4/8/4 beam into an ends file and a mid file', () => {
    const files = buildGroupScoFiles([zoned()], 'ACI318-19');
    expect(files.map(f => f.fileName).sort()).toEqual(['B_ends.SCO', 'B_mid.SCO']);
    expect(files.every(f => f.memberId === 'b')).toBe(true);   // both still link to the member
  });

  it('gives each file its OWN spacing and only the rows in that zone', () => {
    const files = buildGroupScoFiles([zoned()], 'ACI318-19');
    const byName = Object.fromEntries(files.map(f => [f.fileName, f.text]));
    // End zones (x = 0 and x = 20) at 4"; mid (x = 10) at 8".
    expect(byName['B_ends.SCO']).toContain('Bm Sstir\t 4');
    expect(byName['B_mid.SCO']).toContain('Bm Sstir\t 8');
    expect(sectionalLoadRows(byName['B_ends.SCO']).map(r => r.Vfz)).toEqual([60, 60, -58, -58]);
    expect(sectionalLoadRows(byName['B_mid.SCO']).map(r => r.Vfz)).toEqual([6]);
  });

  it('does NOT split when the rows carry no station (the app falls back too)', () => {
    const m = zoned();
    m.loads = m.loads.map(l => ({ ...l, x: undefined }));
    const files = buildGroupScoFiles([m], 'ACI318-19');
    expect(files.map(f => f.fileName)).toEqual(['B.SCO']);
  });

  it('does NOT split when all three zones share one spacing', () => {
    const m = zoned();
    m.rebar = { ...m.rebar, tieZones: [{ spacing: 5 }, { spacing: 5 }, { spacing: 5 }] };
    const files = buildGroupScoFiles([m], 'ACI318-19');
    expect(files.map(f => f.fileName)).toEqual(['B.SCO']);
  });

  it('keeps every zone file when the member is collected across groups', () => {
    // collectGroupScoFiles dedupes; keying on memberId alone dropped all but the
    // first zone file.
    const files = collectGroupScoFiles(
      [group('g1', 'G1', ['b']), group('g2', 'G2', ['b'])], [zoned()], 'ACI318-19');
    expect(files.map(f => f.fileName).sort()).toEqual(['B_ends.SCO', 'B_mid.SCO']);
  });
});

describe('edge cases', () => {
  function rowsOf(members: Member[], ids: string[]): SoLoadRow[] {
    const files = buildScoFilesByGroup([group('g', 'G', ids)], members, 'ACI318-19')[0].files;
    return files.length ? sectionalLoadRows(files[0].text) : [];
  }

  it('a beam with no load cases still exports a file with a single zero row', () => {
    const m = beam('b', 'B', []);
    const files = buildScoFilesByGroup([group('g', 'G', ['b'])], [m], 'ACI318-19')[0].files;
    expect(files).toHaveLength(1);
    const rows = sectionalLoadRows(files[0].text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ Nf: 0, Tf: 0, Vfz: 0, Mfy: 0, Vfy: 0, Mfz: 0 });
  });

  it('zero forces produce a valid all-zero row (no NaN)', () => {
    const rows = rowsOf([beam('b', 'B', [lc({})])], ['b']);
    expect(rows[0]).toEqual({ Nf: 0, Tf: 0, Vfz: 0, Mfy: 0, Vfy: 0, Mfz: 0 });
    for (const v of Object.values(rows[0])) expect(Number.isNaN(v)).toBe(false);
  });

  it('sanitizes member labels into safe file names', () => {
    const files = buildScoFilesByGroup([group('g', 'G', ['b'])], [beam('b', 'B 2/A:x')], 'ACI318-19')[0].files;
    expect(files[0].fileName).toBe('B_2_A_x.SCO');
  });

  it('carries all combos through for a heavily-loaded member (12 combos)', () => {
    const loads = Array.from({ length: 12 }, (_, i) =>
      lc({ id: `LC${i}`, label: `C${i}`, Mu_pos: 50 + i * 10, Vu: 10 + i, Tu: i, Pu: i * 2 }));
    const rows = rowsOf([beam('b', 'B', loads)], ['b']);
    expect(rows).toHaveLength(12);
    expect(rows[0].Mfy).toBe(50);
    expect(rows[11].Mfy).toBe(160);
    expect(rows[11].Vfz).toBe(21);
  });

  it('routes EC2 beams to the EC2 writer when the project is supplied', () => {
    const proj: Project = { id: 'p', name: 'P', code: 'EN1992-1-1', description: '', engineer: 'E', date: 'd', members: [] };
    const files = buildScoFilesByGroup([group('g', 'G', ['b'])], [beam('b', 'B')], 'EN1992-1-1', proj)[0].files;
    expect(files).toHaveLength(1);
    expect(files[0].text).toContain('Codes\t 14');        // EC2 header (EN 1992-1-1)
    expect(files[0].text).toContain('Member Type\t 2');   // beam in the 2026 format
  });

  it('throws for EC2 without the project (crack-width combo needed)', () => {
    expect(() => buildScoFilesByGroup([group('g', 'G', ['b'])], [beam('b', 'B')], 'EN1992-1-1'))
      .toThrow(/needs the project/);
  });

  it('matches the direct buildGroupScoFiles output for the same members', () => {
    const members = [beam('b1', 'B1'), beam('b2', 'B2')];
    const viaGroup = buildScoFilesByGroup([group('g', 'G', ['b1', 'b2'])], members, 'ACI318-19')[0].files;
    const direct = buildGroupScoFiles(members, 'ACI318-19');
    expect(viaGroup.map(f => f.text)).toEqual(direct.map(f => f.text));
  });
});

describe('collectGroupScoFiles — the flat list fed to the batch run', () => {
  it('unions the groups, exporting each member once', () => {
    const members = [beam('b1', 'B1'), beam('b2', 'B2'), beam('b3', 'B3')];
    const files = collectGroupScoFiles(
      [group('g1', 'G1', ['b1', 'b2']), group('g2', 'G2', ['b3'])], members, 'ACI318-19');
    expect(files.map(f => f.memberId).sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('de-duplicates a member that belongs to several groups', () => {
    const members = [beam('b1', 'B1'), beam('b2', 'B2')];
    const files = collectGroupScoFiles(
      [group('g1', 'G1', ['b1', 'b2']), group('g2', 'G2', ['b1'])], members, 'ACI318-19');
    expect(files.filter(f => f.memberId === 'b1')).toHaveLength(1);   // not duplicated
    expect(files).toHaveLength(2);
  });

  it('scopes to grouped members only — ungrouped beams are excluded', () => {
    const members = [beam('b1', 'B1'), beam('ungrouped', 'BU')];
    const files = collectGroupScoFiles([group('g1', 'G1', ['b1'])], members, 'ACI318-19');
    expect(files.map(f => f.memberId)).toEqual(['b1']);
  });

  it('falls back to ALL members when no groups are defined', () => {
    const members = [beam('b1', 'B1'), beam('b2', 'B2'), beam('b3', 'B3')];
    const files = collectGroupScoFiles([], members, 'ACI318-19');
    expect(files.map(f => f.memberId).sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('routes EC2 through the group path when the project is supplied', () => {
    const proj: Project = { id: 'p', name: 'P', code: 'EN1992-1-1', description: '', engineer: 'E', date: 'd', members: [] };
    const files = collectGroupScoFiles([group('g', 'G', ['b1'])], [beam('b1', 'B1')], 'EN1992-1-1', proj);
    expect(files).toHaveLength(1);
    expect(files[0].text).toContain('Codes\t 14');
  });
});
