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

  it('transfers Pu→Nf, Tu→Tf, Vu→Vfy and the governing |M|→Mfy for one load case', () => {
    const rows = rowsFor(beam('b1', 'B1', [lc({ Mu_pos: 180, Mu_neg: -90, Vu: 45, Tu: 8, Pu: 25 })]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ Nf: 25, Tf: 8, Vfz: 0, Mfy: 180, Vfy: 45, Mfz: 0 });
  });

  it('emits one row per load case, in order, each carrying its own forces', () => {
    const rows = rowsFor(beam('b1', 'B1', [
      lc({ label: 'D+L', Mu_pos: 120, Mu_neg: -60, Vu: 30, Tu: 5, Pu: 10 }),
      lc({ label: 'D+W', Mu_pos: 200, Mu_neg: -150, Vu: 55, Tu: 9, Pu: 0 }),
      lc({ label: 'D+E', Mu_pos: 90, Mu_neg: -260, Vu: 70, Tu: 0, Pu: -15 }),
    ]));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ Nf: 10, Tf: 5, Vfz: 0, Mfy: 120, Vfy: 30, Mfz: 0 });
    expect(rows[1]).toEqual({ Nf: 0, Tf: 9, Vfz: 0, Mfy: 200, Vfy: 55, Mfz: 0 });
    // hogging governs the 3rd combo (|-260| > 90); tension axial preserved
    expect(rows[2]).toEqual({ Nf: -15, Tf: 0, Vfz: 0, Mfy: 260, Vfy: 70, Mfz: 0 });
  });

  it('governing moment uses max(|Mu_pos|, |Mu_neg|)', () => {
    expect(rowsFor(beam('b', 'B', [lc({ Mu_pos: 50, Mu_neg: -300, Vu: 20 })]))[0].Mfy).toBe(300);
    expect(rowsFor(beam('b', 'B', [lc({ Mu_pos: 240, Mu_neg: -30, Vu: 20 })]))[0].Mfy).toBe(240);
  });

  it('is an ACTIVE transfer — changing a force changes the emitted .SCO', () => {
    const a = rowsFor(beam('b', 'B', [lc({ Mu_pos: 100, Vu: 45 })]))[0];
    const b = rowsFor(beam('b', 'B', [lc({ Mu_pos: 100, Vu: 99 })]))[0];
    expect(a.Vfy).toBe(45);
    expect(b.Vfy).toBe(99);
    expect(a.Vfy).not.toBe(b.Vfy);
  });

  it('writes fractional forces at the file precision (1 dp)', () => {
    const rows = rowsFor(beam('b', 'B', [lc({ Mu_pos: 123.46, Vu: 45.27, Pu: 12.34 })]));
    expect(rows[0].Mfy).toBeCloseTo(123.5, 5);  // f1 rounds to 1 decimal
    expect(rows[0].Vfy).toBeCloseTo(45.3, 5);
    expect(rows[0].Nf).toBeCloseTo(12.3, 5);
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
    expect(rows[11].Vfy).toBe(21);
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
