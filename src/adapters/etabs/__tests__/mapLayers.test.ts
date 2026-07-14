/**
 * Walls / grids / openings map layers. The MockConnection authors them for the
 * demo model; TableConnection (COM/Bridge) extracts them from ETABS tables —
 * "Area Object Connectivity" (walls/slabs/openings), joined to point coords, and
 * "Grid Definitions - Grid Lines". Exercised through BridgeConnection with a
 * mocked HTTP transport, mirroring the column-connectivity test.
 */
import { describe, it, expect, vi } from 'vitest';
import { MockConnection } from '../mock';
import { BridgeConnection } from '../bridgeClient';

describe('MockConnection — demo walls / grids / openings', () => {
  const conn = new MockConnection();

  it('emits grid lines with labels and spanning endpoints', async () => {
    const grids = await conn.getGrids();
    expect(grids.length).toBeGreaterThan(0);
    for (const g of grids) {
      expect(g.label).toBeTruthy();
      expect(g.p1).toHaveProperty('x');
      expect(g.p2).toHaveProperty('y');
      expect(g.p1.x !== g.p2.x || g.p1.y !== g.p2.y).toBe(true); // a real line
    }
    expect(grids.map(g => g.label)).toContain('A');
  });

  it('emits both slab and wall areas, each a valid polygon', async () => {
    const areas = await conn.getAreas({});
    const kinds = new Set(areas.map(a => a.kind));
    expect(kinds.has('slab')).toBe(true);
    expect(kinds.has('wall')).toBe(true);
    for (const a of areas) expect(a.points.length).toBeGreaterThanOrEqual(3);
  });

  it('emits at least one opening per story, and scopes areas/openings by story', async () => {
    const openings = await conn.getOpenings({});
    expect(openings.length).toBeGreaterThan(0);
    expect(openings[0].points.length).toBeGreaterThanOrEqual(3);

    const oneStory = await conn.getAreas({ stories: ['Level 2'] });
    expect(oneStory.length).toBeGreaterThan(0);
    expect(oneStory.every(a => a.story === 'Level 2')).toBe(true);
    const oneStoryOpen = await conn.getOpenings({ stories: ['Level 2'] });
    expect(oneStoryOpen.every(o => o.story === 'Level 2')).toBe(true);
  });
});

type Row = Record<string, unknown>;

// A slab (horizontal), a wall (vertical plane, y=0), and an opening, plus grids.
const TABLES: Record<string, Row[]> = {
  'Program Control': [{ CurrUnits: 'Kip, ft, F' }],
  'Point Object Connectivity': [
    { UniqueName: 'P1', X: 0, Y: 0, Z: 0 },
    { UniqueName: 'P2', X: 10, Y: 0, Z: 0 },
    { UniqueName: 'P3', X: 10, Y: 8, Z: 0 },
    { UniqueName: 'P4', X: 0, Y: 8, Z: 0 },
    { UniqueName: 'P5', X: 0, Y: 0, Z: 10 },
    { UniqueName: 'P6', X: 10, Y: 0, Z: 10 },
    { UniqueName: 'PO1', X: 3, Y: 3, Z: 0 },
    { UniqueName: 'PO2', X: 5, Y: 3, Z: 0 },
    { UniqueName: 'PO3', X: 5, Y: 5, Z: 0 },
    { UniqueName: 'PO4', X: 3, Y: 5, Z: 0 },
  ],
  'Area Object Connectivity': [
    { UniqueName: 'A1', Story: 'L1', NumberPoints: 4, UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4', 'Design Orientation': 'Floor' },
    { UniqueName: 'W1', Story: 'L1', NumberPoints: 4, UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P6', UniquePt4: 'P5', 'Design Orientation': 'Wall' },
    { UniqueName: 'W2', Story: 'L2', NumberPoints: 4, UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P6', UniquePt4: 'P5' }, // no orientation → plane-normal ⇒ wall
    { UniqueName: 'O1', Story: 'L1', NumberPoints: 4, UniquePt1: 'PO1', UniquePt2: 'PO2', UniquePt3: 'PO3', UniquePt4: 'PO4', Opening: 'Yes' },
  ],
  'Area Assignments - Section Properties': [
    { UniqueName: 'A1', SectProp: 'Slab8' },
    { UniqueName: 'W1', SectProp: 'W300' },
  ],
  'Grid Definitions - Grid Lines': [
    { GridID: 'A', GridDir: 'X', Ordinate: 0 },
    { GridID: 'B', GridDir: 'X', Ordinate: 10 },
    { GridID: '1', GridDir: 'Y', Ordinate: 0 },
  ],
};

function mockHttp(tables: Record<string, Row[]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/connect' && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, message: 'tower.edb' }) } as Response;
    }
    if (u.pathname === '/table') {
      const key = u.searchParams.get('key') ?? '';
      return { ok: true, status: 200, json: async () => ({ rows: tables[key] ?? [] }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response;
  }));
}

describe('TableConnection — area / grid / opening extraction', () => {
  it('splits areas into walls, slabs and openings with joined coords + section', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection('http://127.0.0.1:8744');
    await conn.connect();

    const areas = await conn.getAreas!({});
    expect(areas.map(a => a.name).sort()).toEqual(['A1', 'W1', 'W2']); // O1 excluded (opening)

    const slab = areas.find(a => a.name === 'A1')!;
    expect(slab.kind).toBe('slab');           // Design Orientation = Floor
    expect(slab.section).toBe('Slab8');
    expect(slab.points).toHaveLength(4);
    expect(slab.points[0]).toEqual({ x: 0, y: 0, z: 0 });

    expect(areas.find(a => a.name === 'W1')!.kind).toBe('wall'); // Design Orientation = Wall
    expect(areas.find(a => a.name === 'W2')!.kind).toBe('wall'); // plane-normal fallback (vertical)

    const openings = await conn.getOpenings!({});
    expect(openings.map(o => o.name)).toEqual(['O1']);
    expect(openings[0].points).toHaveLength(4);
  });

  it('parses grid lines and spans X/Y ordinates across the model extent', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();
    const grids = await conn.getGrids!();
    expect(grids.map(g => g.label).sort()).toEqual(['1', 'A', 'B']);
    const a = grids.find(g => g.label === 'A')!;   // X-grid at x=0 spans model Y
    expect(a.p1.x).toBe(0);
    expect(a.p2.x).toBe(0);
    expect(a.p1.y).not.toBe(a.p2.y);
  });

  it('scopes areas by story', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();
    expect((await conn.getAreas!({ stories: ['L1'] })).map(a => a.name).sort()).toEqual(['A1', 'W1']);
    expect((await conn.getAreas!({ stories: ['L2'] })).map(a => a.name)).toEqual(['W2']);
  });

  it('degrades to empty layers (no throw) when the tables are absent', async () => {
    mockHttp({ 'Program Control': TABLES['Program Control'], 'Point Object Connectivity': TABLES['Point Object Connectivity'] });
    const conn = new BridgeConnection();
    await conn.connect();
    expect(await conn.getAreas!({})).toEqual([]);
    expect(await conn.getOpenings!({})).toEqual([]);
    expect(await conn.getGrids!()).toEqual([]);
  });
});
