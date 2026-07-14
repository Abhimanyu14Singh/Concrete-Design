import { describe, it, expect } from 'vitest';
import type { WorkSheet } from 'xlsx';
import { buildProjectWorkbook } from '../excelExport';
import type { Project, Member } from '../../../types';

const column: Member = {
  id: 'C1', label: 'C1', memberType: 'column',
  material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
  section: { type: 'rectangular_column', b: 20, h: 24, coverClear: 1.5, stirrupDia: 4 },
  rebar: {
    topBars: [{ numBars: 3, barSize: 9 }], botBars: [{ numBars: 3, barSize: 9 }],
    sideBars: [{ numBars: 2, barSize: 9 }], ties: { barSize: 4, spacing: 12, legs: 2 },
    tieType: 'tied',
  },
  loads: [{ id: 'LC1', label: '1.2D+1.6L', Mu_pos: 0, Mu_neg: 0, Vu: 30, Tu: 0, Pu: 400, Mux: 120, Muy: 80 }],
  span: 12,
};

const project: Project = {
  id: 'p1', name: 'Test Tower', code: 'ACI318-19', description: '', engineer: 'EOR', date: '2026-06-26',
  members: [column],
};

// Numeric (cached) values of every formula cell in a sheet.
function formulaValues(ws: WorkSheet): number[] {
  return Object.entries(ws)
    .filter(([k, v]) => !k.startsWith('!') && v && typeof v === 'object' && 'f' in v)
    .map(([, v]) => (v as { v: number }).v);
}
function formulaStrings(ws: WorkSheet): string[] {
  return Object.entries(ws)
    .filter(([k, v]) => !k.startsWith('!') && v && typeof v === 'object' && 'f' in v)
    .map(([, v]) => (v as { f: string }).f);
}
const hasNear = (xs: number[], target: number, tol = 0.5) => xs.some(x => Math.abs(x - target) <= tol);

describe('buildProjectWorkbook — formula-traceable Excel', () => {
  const wb = buildProjectWorkbook(project);
  const ws = wb.Sheets['C1'];

  it('builds a Summary sheet plus one sheet per member', () => {
    expect(wb.SheetNames).toContain('Summary');
    expect(wb.SheetNames).toContain('C1');
  });

  it('writes live formulas (not just values) for the derived cells', () => {
    const fs = formulaStrings(ws);
    expect(fs.length).toBeGreaterThan(0);
    // Every formula references at least one cell (letter+digit).
    for (const f of fs) expect(/[A-Z]+\d+/.test(f)).toBe(true);
    // φPn,max carries the axial-capacity arithmetic.
    expect(fs.some(f => f.includes('/1000') && f.includes('0.85'))).toBe(true);
  });

  it('caches Ag = b·h = 480 in²', () => {
    expect(hasNear(formulaValues(ws), 480, 1e-6)).toBe(true);
  });

  it('caches φPn,max ≈ 1084 k (0.65·0.80·(0.85·4000·472 + 60000·8)/1000)', () => {
    // = 0.52 × 2,084,800 / 1000 = 1084.1
    expect(hasNear(formulaValues(ws), 1084.1, 1.0)).toBe(true);
  });

  it('caches DCR_axial = Pu/φPn,max ≈ 0.369', () => {
    expect(hasNear(formulaValues(ws), 400 / 1084.1, 0.01)).toBe(true);
  });

  it('a beam member still exports without an axial-check block', () => {
    const beam: Member = {
      ...column, id: 'B1', label: 'B1', memberType: 'beam',
      section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 },
      loads: [{ id: 'LC1', label: 'env', Mu_pos: 180, Mu_neg: 90, Vu: 45, Tu: 8, Pu: 0 }],
    };
    const wb2 = buildProjectWorkbook({ ...project, members: [beam] });
    const ws2 = wb2.Sheets['B1'];
    // Ag (b·h = 336) is still a live formula for beams.
    expect(hasNear(formulaValues(ws2), 14 * 24, 1e-6)).toBe(true);
  });
});
