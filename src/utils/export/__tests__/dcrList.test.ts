/**
 * Member DCR List export — a compact single-sheet workbook: one row per member
 * with its governing DCR (including crack width) + per-mode DCRs and status.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildDcrListWorkbook } from '../excelExport';
import type { Project, Member } from '../../../types';

const beam = (id: string, botBars: number): Member => ({
  id, label: `${id} beam`, memberType: 'beam',
  section: { type: 'rectangular_beam', b: 14, h: 28, coverClear: 1.5, stirrupDia: 4 },
  material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
  rebar: {
    topBars: [{ numBars: 2, barSize: 8 }],
    botBars: [{ numBars: botBars, barSize: 8 }],
    ties: { barSize: 4, spacing: 8, legs: 2 },
  },
  span: 20,
  loads: [{ id: 'lc1', label: 'U1', Mu_pos: 120, Mu_neg: 60, Vu: 30, Tu: 0, Pu: 0 }],
});

const project: Project = {
  name: 'Test Proj', engineer: 'ENG', date: '2026-01-01', code: 'ACI318-19',
  members: [beam('B1', 2), beam('B2', 6)],
  designGroups: [{ id: 'g1', label: 'Grp A', memberIds: ['B1', 'B2'] }],
} as unknown as Project;

describe('buildDcrListWorkbook', () => {
  const wb = buildDcrListWorkbook(project);
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['DCR List'], { header: 1 });
  const header = rows[3] as string[];
  const dataRows = rows.slice(4) as (string | number)[][];

  it('has a single DCR List sheet with the expected columns', () => {
    expect(wb.SheetNames).toEqual(['DCR List']);
    expect(header).toEqual(['ID', 'Label', 'Type', 'Group', 'Section', 'Gov. DCR',
      'DCR Flex+', 'DCR Flex-', 'DCR Shear', 'DCR Torsion', 'DCR Crack', 'DCR P-M', 'Status']);
  });

  it('emits one row per member, tagged with its group', () => {
    expect(dataRows.map(r => r[0])).toEqual(['B1', 'B2']);
    expect(dataRows.every(r => r[3] === 'Grp A')).toBe(true);
  });

  it('governing DCR is the max of every per-mode DCR (incl. crack)', () => {
    for (const r of dataRows) {
      const gov = r[5] as number;
      const modes = [r[6], r[7], r[8], r[9], r[10]].filter(v => typeof v === 'number') as number[];
      expect(gov).toBeCloseTo(Math.max(...modes), 2);
    }
  });

  it('the lightly-reinforced beam is more utilized than the heavy one', () => {
    const [b1, b2] = dataRows;
    expect(b1[5] as number).toBeGreaterThan(b2[5] as number); // B1 (2 bars) worse than B2 (6 bars)
  });
});

describe('buildDcrListWorkbook — engineer-Reviewed groups', () => {
  // A clearly over-utilized beam (400 k·ft on a 2-#8 14×28 → NG).
  const failing: Member = { ...beam('X1', 2), loads: [{ id: 'u', label: 'U', Mu_pos: 400, Mu_neg: 200, Vu: 100, Tu: 0, Pu: 0 }] };
  const proj = (reviewed: boolean): Project => ({
    name: 'R', engineer: 'E', date: 'd', code: 'ACI318-19',
    members: [failing],
    designGroups: [{ id: 'g', label: 'G', memberIds: ['X1'], reviewed }],
  } as unknown as Project);
  const statusOf = (reviewed: boolean) => {
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      buildDcrListWorkbook(proj(reviewed)).Sheets['DCR List'], { header: 1 });
    return (rows[4] as (string | number)[])[12]; // Status column of the first data row
  };

  it('an unreviewed failing member reads "NG"', () => {
    expect(statusOf(false)).toBe('NG');
  });
  it('the same member in a Reviewed group reads "Reviewed", never "NG"', () => {
    expect(statusOf(true)).toBe('Reviewed');
  });
});
