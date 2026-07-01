/**
 * Edge cases for the COLUMN pipeline end to end: file-import sheet handling,
 * buildColumnMembers defaults, and Mock → members → group → S-Concrete envelope
 * (ACI + EC2), including imported columns whose design forces are still zero.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { FileConnection } from '../fileImport';
import { MockConnection } from '../mock';
import { buildColumnMembers } from '../index';
import type { SeedOptions } from '../rebarSeed';
import { buildGroupEnvelopeScoFiles } from '../../../utils/sco/scoBatch';
import type { DesignGroup, Project } from '../../../types';

const SEED: SeedOptions = {
  rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
  stirrupBarSize: 4, stirrupLegs: 2, imposeSkinReinf: true, skinBarSize: 5, coverClear: 1.5,
};
const bytes = (wb: XLSX.WorkBook) => XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
const sheet = (rows: Record<string, unknown>[]) => XLSX.utils.json_to_sheet(rows);

describe('FileConnection — beams vs columns sheet handling', () => {
  it('does NOT swap beams and columns when the Columns sheet comes first', async () => {
    const wb = XLSX.utils.book_new();
    // Columns sheet appended FIRST — the previous first-geometry-sheet logic
    // would have parsed these as "beams".
    XLSX.utils.book_append_sheet(wb, sheet([
      { Story: 'L2', Frame: 'C1', Section: 'C18X18', X1: 0, Y1: 0, Z1: 0, X2: 0, Y2: 0, Z2: 12, Groups: 'Cols' },
    ]), 'Columns');
    XLSX.utils.book_append_sheet(wb, sheet([
      { Story: 'L2', Frame: 'B1', Section: 'B12X24', X1: 0, Y1: 0, Z1: 12, X2: 24, Y2: 0, Z2: 12, Groups: 'Girders' },
    ]), 'Beams');
    const conn = new FileConnection(bytes(wb));
    await conn.connect();
    expect((await conn.getBeams({})).map(b => b.name)).toEqual(['B1']);       // beams, not C1
    expect((await conn.getColumns!({})).map(c => c.name)).toEqual(['C1']);    // columns
  });

  it('returns no columns when the workbook has no Columns sheet', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet([
      { Story: 'L2', Frame: 'B1', Section: 'B12X24', X1: 0, Y1: 0, Z1: 12, X2: 24, Y2: 0, Z2: 12 },
    ]), 'Beams');
    const conn = new FileConnection(bytes(wb));
    await conn.connect();
    expect(await conn.getColumns!({})).toEqual([]);
    expect((await conn.getBeams({})).map(b => b.name)).toEqual(['B1']);
  });

  it('keeps only genuinely vertical rows from a Columns sheet', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet([
      { Story: 'L2', Frame: 'B1', Section: 'B12X24', X1: 0, Y1: 0, Z1: 12, X2: 24, Y2: 0, Z2: 12 },
    ]), 'Beams');
    XLSX.utils.book_append_sheet(wb, sheet([
      { Story: 'L2', Frame: 'C1', Section: 'C18X18', X1: 5, Y1: 5, Z1: 0, X2: 5, Y2: 5, Z2: 12 },  // vertical → kept
      { Story: 'L2', Frame: 'H1', Section: 'B12X24', X1: 0, Y1: 0, Z1: 12, X2: 24, Y2: 0, Z2: 12 }, // horizontal → dropped
    ]), 'Columns');
    const conn = new FileConnection(bytes(wb));
    await conn.connect();
    expect((await conn.getColumns!({})).map(c => c.name)).toEqual(['C1']);
    // stories/groups include the column story
    expect(await conn.getStories()).toContain('L2');
  });
});

describe('buildColumnMembers — defaults & mapping', () => {
  it('falls back to an 18x18 section and default material for an unknown section', () => {
    const members = buildColumnMembers(
      [{ name: 'C9', story: 'L1', section: 'UNKNOWN', pt1: { x: 0, y: 0, z: 0 }, pt2: { x: 0, y: 0, z: 12 }, groups: [], heightFt: 12 }],
      [], [], SEED,
    );
    expect(members[0].section.type).toBe('rectangular_column');
    expect(members[0].section.b).toBe(18);
    expect(members[0].material.fc).toBe(4000); // DEFAULT_MATERIAL
    expect(members[0].span).toBe(12);
  });
});

describe('column pipeline end-to-end: Mock → members → group → envelope', () => {
  const proj = (code: Project['code']): Project =>
    ({ id: 'p', name: 'P', code, description: '', engineer: 'E', date: 'd', members: [] });

  async function envelopeFor(code: Project['code']) {
    const conn = new MockConnection();
    const cols = await conn.getColumns({ stories: ['Level 2'] });
    const members = buildColumnMembers(cols, await conn.getFrameSections(), await conn.getMaterials(), SEED);
    const group: DesignGroup = { id: 'g', label: 'Cols L2', memberIds: members.map(m => m.id) };
    return { files: buildGroupEnvelopeScoFiles([group], members, code, code === 'EN1992-1-1' ? proj(code) : undefined), members };
  }

  it('imported ACI columns (zero placeholder forces) still produce ONE valid Type-3 file', async () => {
    const { files, members } = await envelopeFor('ACI318-19');
    expect(files).toHaveLength(1);
    expect(files[0].text).toContain('Member Type\t 3');
    expect(files[0].text).toContain('Codes\t 18');
    expect(files[0].memberCount).toBe(members.length);
    expect(files[0].loadCaseCount).toBeGreaterThanOrEqual(1); // one placeholder row per column
  });

  it('imported EC2 columns produce ONE valid 2026 Type-3 file (no crack file for columns)', async () => {
    const { files } = await envelopeFor('EN1992-1-1');
    expect(files).toHaveLength(1);
    expect(files[0].text).toContain('Member Type\t 3');
    expect(files[0].text).toContain('Codes\t 14');
    expect(files.every(f => f.kind !== 'crack')).toBe(true);
  });
});
