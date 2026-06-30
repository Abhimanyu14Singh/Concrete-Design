/**
 * Per-group ENVELOPE extraction: ONE .SCO per design group, carrying the group's
 * representative section/rebar plus EVERY member's load cases pooled into the
 * Sectional Loads table. This is the "8 groups → 8 files" workflow: S-Concrete
 * checks the single group section against the group's full force envelope and the
 * batch summary reports the governing case per group.
 *
 * Forces are verified by PARSING the emitted .SCO (not substring matching), so a
 * regression in the pooling or the force mapping fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { buildGroupEnvelopeScoFiles } from '../scoBatch';
import type { Member, DesignGroup, Project, RebarLayout } from '../../../types';

// ── Sectional Loads (Table 16) parser — beam/column ACI row layout ────────────
// Row (scoWriter lcRow): i, Nf, Tf, Vfz, Mfy, Cmy, Vfy, Mfz, Cmz, Pdistr, CheckLC,
// LoadType, Comment, … — tab-delimited. Comment is column 12.
interface SoRow { Nf: number; Tf: number; Vfz: number; Mfy: number; Vfy: number; Mfz: number; comment: string }
function rowsOf(sco: string): SoRow[] {
  const start = sco.indexOf('@Table@16@');
  if (start < 0) return [];
  const end = sco.indexOf('@EndTable@', start);
  return sco.slice(start, end).split('\n')
    .filter(l => /^\s*\d+\t/.test(l))
    .map(l => {
      const c = l.split('\t');
      const t = (i: number) => c[i]?.trim() ?? '';
      return { Nf: +t(1), Tf: +t(2), Vfz: +t(3), Mfy: +t(4), Vfy: +t(6), Mfz: +t(7), comment: t(12) };
    });
}

type LC = Member['loads'][number];
const lc = (over: Partial<LC>): LC => ({
  id: over.id ?? 'LC', label: over.label ?? 'combo',
  Mu_pos: over.Mu_pos ?? 0, Mu_neg: over.Mu_neg ?? 0, Vu: over.Vu ?? 0,
  Tu: over.Tu ?? 0, Pu: over.Pu ?? 0, ...over,
});

const MAT = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 } as const;
function beam(id: string, label: string, loads: LC[], over: Partial<Member['section']> = {}): Member {
  return {
    id, label, memberType: 'beam', material: { ...MAT },
    section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4, ...over },
    rebar: { topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 3, barSize: 9 }], ties: { barSize: 4, spacing: 6, legs: 2 } },
    loads, span: 20,
  };
}
function col(id: string, label: string, loads: LC[], over: Partial<Member['section']> = {}): Member {
  return {
    id, label, memberType: 'column', material: { ...MAT, fc: 5000 },
    section: { type: 'rectangular_column', b: 20, h: 24, coverClear: 1.5, stirrupDia: 4, ...over },
    rebar: { topBars: [{ numBars: 3, barSize: 9 }], botBars: [{ numBars: 3, barSize: 9 }], sideBars: [{ numBars: 4, barSize: 9 }], ties: { barSize: 4, spacing: 12, legs: 2 }, tieType: 'tied' },
    loads, span: 12,
  };
}
function circ(id: string, label: string): Member {
  return { ...beam(id, label, [lc({ Mu_pos: 100 })]), memberType: 'column',
    section: { type: 'circular_column', b: 24, h: 24, diameter: 24, coverClear: 1.5, stirrupDia: 4 } };
}
const group = (id: string, label: string, memberIds: string[], rebar?: RebarLayout): DesignGroup =>
  ({ id, label, memberIds, ...(rebar ? { rebar } : {}) });

describe('buildGroupEnvelopeScoFiles — one .SCO per group', () => {
  it('emits exactly one file per non-empty group (8 groups → 8 files)', () => {
    const members: Member[] = [];
    const groups: DesignGroup[] = [];
    for (let i = 1; i <= 8; i++) {
      members.push(beam(`b${i}`, `B${i}`, [lc({ Mu_pos: 100 + i * 10, Vu: 30 + i })]));
      groups.push(group(`g${i}`, `Group ${i}`, [`b${i}`]));
    }
    const files = buildGroupEnvelopeScoFiles(groups, members, 'ACI318-19');
    expect(files).toHaveLength(8);
    expect(files.map(f => f.groupId)).toEqual(groups.map(g => g.id));
    expect(files.map(f => f.fileName)).toEqual(groups.map(g => `${g.label.replace(/\s+/g, '_')}.SCO`));
  });

  it('pools EVERY member\'s load cases into the one group file', () => {
    const members = [
      beam('b1', 'B1', [lc({ label: 'D+L', Mu_pos: 120, Vu: 30 }), lc({ label: 'D+W', Mu_pos: 200, Vu: 55 })]),
      beam('b2', 'B2', [lc({ label: 'D+E', Mu_pos: 90, Vu: 70 })]),
    ];
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'Perimeter', ['b1', 'b2'])], members, 'ACI318-19');
    expect(file.memberCount).toBe(2);
    expect(file.loadCaseCount).toBe(3);          // 2 + 1 combos
    const rows = rowsOf(file.text);
    expect(rows).toHaveLength(3);
    // Both members' governing moments present, in member order.
    expect(rows.map(r => r.Mfy)).toEqual([120, 200, 90]);
    expect(rows.map(r => r.Vfy)).toEqual([30, 55, 70]);
  });

  it('is an ACTIVE transfer — every pooled force lands in its field', () => {
    const members = [
      beam('b1', 'B1', [lc({ Mu_pos: 180, Mu_neg: -90, Vu: 45, Tu: 8, Pu: 25 })]),
      beam('b2', 'B2', [lc({ Mu_pos: 50, Mu_neg: -300, Vu: 70, Tu: 0, Pu: -15 })]),
    ];
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'G', ['b1', 'b2'])], members, 'ACI318-19');
    const rows = rowsOf(file.text);
    expect(rows[0]).toMatchObject({ Nf: 25, Tf: 8, Mfy: 180, Vfy: 45 });   // B1 sagging governs
    expect(rows[1]).toMatchObject({ Nf: -15, Tf: 0, Mfy: 300, Vfy: 70 });  // B2 hogging governs, tension preserved
  });

  it('tags each pooled row with its source member (governing case is traceable)', () => {
    const members = [beam('b1', 'B1', [lc({ label: 'D+L', Mu_pos: 120 })]), beam('b2', 'B2', [lc({ label: 'D+E', Mu_pos: 90 })])];
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'G', ['b1', 'b2'])], members, 'ACI318-19');
    const rows = rowsOf(file.text);
    expect(rows[0].comment).toContain('B1');
    expect(rows[0].comment).toContain('D+L');
    expect(rows[1].comment).toContain('B2');
  });

  it('names the file AND the in-file Member Name for the group (so the .SCRS keys by group)', () => {
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'Perimeter', ['b1'])], [beam('b1', 'B1', [lc({ Mu_pos: 100 })])], 'ACI318-19');
    expect(file.fileName).toBe('Perimeter.SCO');
    expect(file.groupLabel).toBe('Perimeter');
    expect(file.text).toContain('Member Name\tPerimeter');
  });

  it('uses the GROUP rebar template when one is set (not the member rebar)', () => {
    const groupRebar: RebarLayout = {
      topBars: [{ numBars: 4, barSize: 10 }], botBars: [{ numBars: 4, barSize: 10 }],
      ties: { barSize: 4, spacing: 4, legs: 2 },
    };
    const m = beam('b1', 'B1', [lc({ Mu_pos: 100 })]);   // member stirrups @ 6
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'G', ['b1'], groupRebar)], [m], 'ACI318-19');
    expect(file.text).toContain('Bm Sstir\t 4.0');       // group's 4-in spacing, not the member's 6
  });
});

describe('buildGroupEnvelopeScoFiles — sections, types, eligibility', () => {
  it('pools a rectangular-column group into one Type-3 file with biaxial forces', () => {
    const members = [
      col('c1', 'C1', [lc({ Pu: 600, Mux: 120, Muy: 80, Vu: 30, Tu: 5 })]),
      col('c2', 'C2', [lc({ Pu: 750, Mux: 60, Muy: 140, Vu: 40 })]),
    ];
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'Cols', ['c1', 'c2'])], members, 'ACI318-19');
    expect(file.text).toContain('Member Type\t 3');
    const rows = rowsOf(file.text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Nf: -600, Mfy: 120, Mfz: 80 });   // P compression-negative; M3↔Mux, M2↔Muy
    expect(rows[1]).toMatchObject({ Nf: -750, Mfy: 60, Mfz: 140 });
  });

  it('flags a geometrically mixed group and uses the most common section', () => {
    const members = [
      beam('b1', 'B1', [lc({ Mu_pos: 100 })]),                    // 14×24 (×2 — modal)
      beam('b2', 'B2', [lc({ Mu_pos: 120 })]),
      beam('b3', 'B3', [lc({ Mu_pos: 140 })], { b: 18, h: 30 }),  // a one-off larger section
    ];
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'G', ['b1', 'b2', 'b3'])], members, 'ACI318-19');
    expect(file.mixedSections).toBe(true);
    expect(file.memberCount).toBe(3);
    expect(file.loadCaseCount).toBe(3);
    expect(file.text).toContain('Bm b\t 14');   // modal 14-wide section is the representative
  });

  it('a homogeneous group is not flagged mixed', () => {
    const members = [beam('b1', 'B1', [lc({ Mu_pos: 100 })]), beam('b2', 'B2', [lc({ Mu_pos: 120 })])];
    expect(buildGroupEnvelopeScoFiles([group('g', 'G', ['b1', 'b2'])], members, 'ACI318-19')[0].mixedSections).toBe(false);
  });

  it('drops a stray off-type member and records it (a column inside a beam group)', () => {
    const members = [
      beam('b1', 'B1', [lc({ Mu_pos: 100 })]), beam('b2', 'B2', [lc({ Mu_pos: 120 })]),
      col('c1', 'C1', [lc({ Pu: 600, Mux: 120 })]),
    ];
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'G', ['b1', 'b2', 'c1'])], members, 'ACI318-19');
    expect(file.memberCount).toBe(2);                 // only the two beams pooled
    expect(file.excludedMemberIds).toEqual(['c1']);
    expect(file.text).toContain('Member Type\t 1');   // a beam file
  });

  it('skips circular columns when picking eligible members', () => {
    const members = [beam('b1', 'B1', [lc({ Mu_pos: 100 })]), circ('c1', 'C1')];
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'G', ['b1', 'c1'])], members, 'ACI318-19');
    expect(file.memberCount).toBe(1);                 // circular column not eligible
  });

  it('produces NO file for a group with no eligible members', () => {
    const files = buildGroupEnvelopeScoFiles([group('g', 'G', ['c1'])], [circ('c1', 'C1')], 'ACI318-19');
    expect(files).toEqual([]);
  });

  it('produces NO file for an empty group and skips unknown member ids', () => {
    const files = buildGroupEnvelopeScoFiles(
      [group('g1', 'Empty', []), group('g2', 'Ghosts', ['nope'])],
      [beam('b1', 'B1', [lc({ Mu_pos: 100 })])], 'ACI318-19');
    expect(files).toEqual([]);
  });

  it('disambiguates files when two groups share a label', () => {
    const members = [beam('b1', 'B1', [lc({ Mu_pos: 100 })]), beam('b2', 'B2', [lc({ Mu_pos: 120 })])];
    const files = buildGroupEnvelopeScoFiles(
      [group('g1', 'Typ', ['b1']), group('g2', 'Typ', ['b2'])], members, 'ACI318-19');
    expect(files.map(f => f.fileName)).toEqual(['Typ.SCO', 'Typ_2.SCO']);
    expect(files.map(f => f.groupId)).toEqual(['g1', 'g2']);
  });

  it('a member in two groups appears in BOTH group files (envelope, not dedup)', () => {
    const members = [beam('b1', 'B1', [lc({ Mu_pos: 100 })]), beam('b2', 'B2', [lc({ Mu_pos: 120 })])];
    const files = buildGroupEnvelopeScoFiles(
      [group('g1', 'G1', ['b1', 'b2']), group('g2', 'G2', ['b1'])], members, 'ACI318-19');
    expect(files).toHaveLength(2);
    expect(files[0].memberCount).toBe(2);
    expect(files[1].memberCount).toBe(1);
  });
});

describe('buildGroupEnvelopeScoFiles — EC2 routing', () => {
  const proj: Project = { id: 'p', name: 'P', code: 'EN1992-1-1', description: '', engineer: 'E', date: 'd', members: [] };

  it('routes an EC2 beam group to the 2026 writer, named for the group', () => {
    const members = [beam('b1', 'B1', [lc({ Mu_pos: 120 })]), beam('b2', 'B2', [lc({ Mu_pos: 90 })])];
    const [file] = buildGroupEnvelopeScoFiles([group('g', 'EC2 Grp', ['b1', 'b2'])], members, 'EN1992-1-1', proj);
    expect(file.text).toContain('Codes\t 14');        // EN 1992-1-1
    expect(file.text).toContain('Member Type\t 2');   // beam (2026 format)
    expect(file.text).toContain('Member Name\t EC2 Grp');   // 2026 setParam adds a leading space
    expect(file.fileName).toBe('EC2_Grp.SCO');
    expect(file.memberCount).toBe(2);
  });

  it('throws for EC2 without the project (crack-width combo needed)', () => {
    expect(() => buildGroupEnvelopeScoFiles([group('g', 'G', ['b1'])], [beam('b1', 'B1', [lc({ Mu_pos: 100 })])], 'EN1992-1-1'))
      .toThrow(/needs the project/);
  });
});
