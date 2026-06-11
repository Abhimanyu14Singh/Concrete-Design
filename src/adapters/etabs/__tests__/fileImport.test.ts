/**
 * FileConnection tests — builds an in-memory ETABS tables workbook and runs
 * the full parse → filter → forces pipeline.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { FileConnection } from '../fileImport';

function fixtureWorkbook(): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Story: 'L2', Frame: 'B1', Section: 'B12X24', X1: 0, Y1: 0, Z1: 12, X2: 24, Y2: 0, Z2: 12, Groups: 'Girders;Core' },
    { Story: 'L2', Frame: 'B2', Section: 'B12X24', X1: 0, Y1: 28, Z1: 12, X2: 24, Y2: 28, Z2: 12, Groups: '' },
    { Story: 'L3', Frame: 'B3', Section: 'B14X28', X1: 0, Y1: 0, Z1: 24, X2: 24, Y2: 0, Z2: 24, Groups: 'Girders' },
  ]), 'Beams');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Name: 'B12X24', Material: 'C4000', Shape: 'Rectangular', Depth: 24, Width: 12 },
    { Name: 'B14X28', Material: 'C5000', Shape: 'Rectangular', Depth: 28, Width: 14 },
  ]), 'Sections');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Name: 'C4000', Fc: 4000, Fy: '' },
    { Name: 'A615', Fc: '', Fy: 60000 },
  ]), 'Materials');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Frame: 'B1', Combo: '1.2D+1.6L', Station: 0, V2: 42, M3: -110 },
    { Frame: 'B1', Combo: '1.2D+1.6L', Station: 12, V2: 0, M3: 95 },
    { Frame: 'B1', Combo: '1.2D+1.6L', Station: 24, V2: -42, M3: -110 },
    { Frame: 'B1', Combo: '0.9D+1.0E', Station: 12, V2: 5, M3: 120 },
  ]), 'Forces');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('FileConnection', () => {
  it('parses the workbook and serves stories/groups/sections/materials/combos', async () => {
    const conn = new FileConnection(fixtureWorkbook(), 'fixture.xlsx');
    const info = await conn.connect();
    expect(info.modelName).toBe('fixture.xlsx');

    expect(await conn.getStories()).toEqual(['L2', 'L3']);
    expect(await conn.getGroups()).toEqual(['Girders', 'Core']);
    expect((await conn.getFrameSections()).map(s => s.name)).toEqual(['B12X24', 'B14X28']);
    const mats = await conn.getMaterials();
    expect(mats.find(m => m.name === 'C4000')?.fc).toBe(4000);
    expect((await conn.getCombos()).sort()).toEqual(['0.9D+1.0E', '1.2D+1.6L']);
  });

  it('filters beams and computes length from coordinates', async () => {
    const conn = new FileConnection(fixtureWorkbook());
    await conn.connect();
    const l2 = await conn.getBeams({ stories: ['L2'] });
    expect(l2.map(b => b.name)).toEqual(['B1', 'B2']);
    expect(l2[0].lengthFt).toBeCloseTo(24, 5);
    const grouped = await conn.getBeams({ groups: ['Core'] });
    expect(grouped.map(b => b.name)).toEqual(['B1']);
  });

  it('returns station forces per combo, V2/M3 columns accepted', async () => {
    const conn = new FileConnection(fixtureWorkbook());
    await conn.connect();
    const f = await conn.getStationForces(['B1'], ['1.2D+1.6L', '0.9D+1.0E']);
    expect(f.B1).toHaveLength(2);
    const grav = f.B1.find(c => c.combo === '1.2D+1.6L')!;
    expect(grav.stations).toHaveLength(3);
    expect(grav.stations[0]).toEqual({ x: 0, V: 42, M: -110 });
  });

  it('rejects a workbook with no beams sheet', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Foo: 1 }]), 'Other');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const conn = new FileConnection(buf);
    await expect(conn.connect()).rejects.toThrow(/Beams/);
  });
});
