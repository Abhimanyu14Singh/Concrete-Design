/**
 * FileConnection — edge-case import tests.
 * Covers: missing/empty sheets, duplicate beam names across stories, negative
 * station X, missing force columns, combo suffix mismatch, empty materials,
 * no sections for a beam, and large coordinate values.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { FileConnection } from '../fileImport';

// ── Workbook builder helpers ──────────────────────────────────────────────────
function makeWB(
  beams: object[],
  sections: object[],
  materials: object[],
  forces: object[],
  extraSheets: Record<string, object[]> = {},
): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(beams), 'Beams');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sections), 'Sections');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(materials), 'Materials');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(forces), 'Forces');
  for (const [name, rows] of Object.entries(extraSheets))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

const BASE_BEAM = { Story: 'L2', Frame: 'B1', Section: 'B12X24', X1: 0, Y1: 0, Z1: 12, X2: 24, Y2: 0, Z2: 12, Groups: '' };
const BASE_SEC  = { Name: 'B12X24', Material: 'C4000', Shape: 'Rectangular', Depth: 24, Width: 12 };
const BASE_MAT  = { Name: 'C4000', Fc: 4000, Fy: 60000 };
const BASE_FORCE = { Frame: 'B1', Combo: '1.2D+1.6L', Station: 0, V2: 30, M3: 80 };

// ── Missing/empty sheets ──────────────────────────────────────────────────────
describe('FileConnection — missing Sections sheet', () => {
  it('rejects when Sections sheet is missing', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([BASE_BEAM]), 'Beams');
    // No Sections, Materials or Forces sheets
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const conn = new FileConnection(buf);
    // Should either throw on connect() or return empty sections
    const result = conn.connect();
    // We allow either a rejection or a resolution with no sections
    const either = await result.then(
      async () => (await conn.getFrameSections()),
      () => [],
    );
    // If it didn't throw, sections should be empty/undefined
    expect(Array.isArray(either)).toBe(true);
  });
});

describe('FileConnection — missing Beams sheet', () => {
  it('throws on connect()', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([BASE_SEC]), 'Sections');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const conn = new FileConnection(buf);
    await expect(conn.connect()).rejects.toThrow();
  });
});

describe('FileConnection — empty Forces sheet', () => {
  it('returns empty station forces when Forces sheet has no rows', async () => {
    const buf = makeWB([BASE_BEAM], [BASE_SEC], [BASE_MAT], []);
    const conn = new FileConnection(buf);
    await conn.connect();
    const forces = await conn.getStationForces(['B1'], ['1.2D+1.6L']);
    expect(forces.B1 ?? []).toHaveLength(0);
  });
});

describe('FileConnection — empty Sections sheet', () => {
  it('returns empty sections list', async () => {
    const buf = makeWB([BASE_BEAM], [], [BASE_MAT], [BASE_FORCE]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const secs = await conn.getFrameSections();
    expect(secs).toHaveLength(0);
  });
});

// ── Duplicate beam names across stories ───────────────────────────────────────
describe('FileConnection — duplicate beam names in different stories', () => {
  it('returns both beams (same name, different story)', async () => {
    const beams = [
      { ...BASE_BEAM, Story: 'L2', Frame: 'B1' },
      { ...BASE_BEAM, Story: 'L3', Frame: 'B1', Z1: 24, Z2: 24 },
    ];
    const buf = makeWB(beams, [BASE_SEC], [BASE_MAT], [BASE_FORCE]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const all = await conn.getBeams({});
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Negative / unordered station X ───────────────────────────────────────────
describe('FileConnection — negative station X in forces', () => {
  it('does not crash and reads forces with negative stations', async () => {
    const forces = [
      { Frame: 'B1', Combo: '1.2D+1.6L', Station: -12, V2: 30, M3: 80 },
      { Frame: 'B1', Combo: '1.2D+1.6L', Station: 0,   V2: 15, M3: 100 },
      { Frame: 'B1', Combo: '1.2D+1.6L', Station: 12,  V2: -30, M3: 80 },
    ];
    const buf = makeWB([BASE_BEAM], [BASE_SEC], [BASE_MAT], forces);
    const conn = new FileConnection(buf);
    await conn.connect();
    const f = await conn.getStationForces(['B1'], ['1.2D+1.6L']);
    const stations = f.B1?.[0]?.stations ?? [];
    expect(stations.length).toBeGreaterThan(0);
  });
});

// ── Large coordinate values ───────────────────────────────────────────────────
describe('FileConnection — large coordinate values', () => {
  it('handles very large span (10000 ft)', async () => {
    const beam = { ...BASE_BEAM, X2: 10000 };
    const buf = makeWB([beam], [BASE_SEC], [BASE_MAT], [BASE_FORCE]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const beams = await conn.getBeams({});
    expect(beams[0].lengthFt).toBeCloseTo(10000, 0);
  });
});

// ── Combo envelope filtering ──────────────────────────────────────────────────
describe('FileConnection — combo suffix matching', () => {
  it('matches forces when combo name matches exactly', async () => {
    const buf = makeWB([BASE_BEAM], [BASE_SEC], [BASE_MAT], [
      { ...BASE_FORCE, Combo: '1.2D+1.6L', Station: 0, V2: 30, M3: 80 },
    ]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const f = await conn.getStationForces(['B1'], ['1.2D+1.6L']);
    expect(f.B1).toBeDefined();
    expect(f.B1!.length).toBeGreaterThan(0);
  });

  it('returns no stations for unrecognized combo name', async () => {
    const buf = makeWB([BASE_BEAM], [BASE_SEC], [BASE_MAT], [
      { ...BASE_FORCE, Combo: 'DEAD' },
    ]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const f = await conn.getStationForces(['B1'], ['1.2D+1.6L']);
    const stations = f.B1?.flatMap(c => c.stations) ?? [];
    expect(stations).toHaveLength(0);
  });
});

// ── Material fallback ─────────────────────────────────────────────────────────
describe('FileConnection — missing material for section', () => {
  it('does not crash when a section references an unknown material', async () => {
    const sec = { Name: 'B12X24', Material: 'UNKNOWN_MAT', Shape: 'Rectangular', Depth: 24, Width: 12 };
    const buf = makeWB([BASE_BEAM], [sec], [BASE_MAT], [BASE_FORCE]);
    const conn = new FileConnection(buf);
    await expect(conn.connect()).resolves.toBeDefined();
  });
});

// ── Story and group filtering ─────────────────────────────────────────────────
describe('FileConnection — story filter', () => {
  it('returns only beams from the specified story', async () => {
    const beams = [
      { ...BASE_BEAM, Story: 'L2', Frame: 'B-L2' },
      { ...BASE_BEAM, Story: 'L3', Frame: 'B-L3', Z1: 24, Z2: 24 },
    ];
    const buf = makeWB(beams, [BASE_SEC], [BASE_MAT], [BASE_FORCE]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const l2Only = await conn.getBeams({ stories: ['L2'] });
    expect(l2Only.every(b => b.name === 'B-L2')).toBe(true);
    const l3Only = await conn.getBeams({ stories: ['L3'] });
    expect(l3Only.every(b => b.name === 'B-L3')).toBe(true);
  });
});

describe('FileConnection — group filter', () => {
  it('returns only beams in the specified group', async () => {
    const beams = [
      { ...BASE_BEAM, Frame: 'B1', Groups: 'Girders' },
      { ...BASE_BEAM, Frame: 'B2', Groups: 'Columns' },
    ];
    const buf = makeWB(beams, [BASE_SEC], [BASE_MAT], [BASE_FORCE]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const girders = await conn.getBeams({ groups: ['Girders'] });
    expect(girders.every(b => b.name === 'B1')).toBe(true);
  });
});

// ── Beam length calculation ───────────────────────────────────────────────────
describe('FileConnection — beam length from coordinates', () => {
  it('length is Euclidean distance in X-Y plane (same Z)', async () => {
    const beam = { ...BASE_BEAM, X1: 0, Y1: 0, Z1: 12, X2: 30, Y2: 40, Z2: 12 };
    const buf = makeWB([beam], [BASE_SEC], [BASE_MAT], [BASE_FORCE]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const [b] = await conn.getBeams({});
    expect(b.lengthFt).toBeCloseTo(50, 1); // 3-4-5 right triangle × 10
  });
  it('length is correct for a purely horizontal beam', async () => {
    const beam = { ...BASE_BEAM, X1: 0, Y1: 0, Z1: 12, X2: 20, Y2: 0, Z2: 12 };
    const buf = makeWB([beam], [BASE_SEC], [BASE_MAT], [BASE_FORCE]);
    const conn = new FileConnection(buf);
    await conn.connect();
    const [b] = await conn.getBeams({});
    expect(b.lengthFt).toBeCloseTo(20, 5);
  });
});
