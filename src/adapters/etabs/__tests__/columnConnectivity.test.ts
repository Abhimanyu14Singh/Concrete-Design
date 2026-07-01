/**
 * Live-connection column import: TableConnection.getColumns reads the
 * "Column Object Connectivity" table (the sibling of the beam table) and joins
 * the shared point/section/group context, mirroring the beam path. Exercised
 * through BridgeConnection with a mocked HTTP transport.
 */
import { describe, it, expect, vi } from 'vitest';
import { BridgeConnection } from '../bridgeClient';

type Row = Record<string, unknown>;

// kip-ft model: one top beam and two 12 ft columns rising to it.
const TABLES: Record<string, Row[]> = {
  'Program Control': [{ CurrUnits: 'Kip, ft, F' }],
  'Beam Object Connectivity': [
    { UniqueName: 'B1', Story: 'L2', UniquePtI: 'P2', UniquePtJ: 'P4', Length: 10 },
  ],
  'Column Object Connectivity': [
    // C1 gives an explicit Length; C2 omits it (height falls back to node distance)
    { UniqueName: 'C1', Story: 'L1', UniquePtI: 'P1', UniquePtJ: 'P2', Length: 12 },
    { UniqueName: 'C2', Story: 'L1', UniquePtI: 'P3', UniquePtJ: 'P4' },
  ],
  'Point Object Connectivity': [
    { UniqueName: 'P1', X: 0, Y: 0, Z: 0 },
    { UniqueName: 'P2', X: 0, Y: 0, Z: 12 },
    { UniqueName: 'P3', X: 10, Y: 0, Z: 0 },
    { UniqueName: 'P4', X: 10, Y: 0, Z: 12 },
  ],
  'Frame Assignments - Section Properties': [
    { UniqueName: 'B1', SectProp: 'B12X24' },
    { UniqueName: 'C1', SectProp: 'C18X18' },
    { UniqueName: 'C2', SectProp: 'C18X18' },
  ],
  'Group Assignments': [
    { GroupName: 'Cols', ObjectType: 'Column', ObjectUniqueName: 'C1' },
    { GroupName: 'Cols', ObjectType: 'Column', ObjectUniqueName: 'C2' },
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

describe('TableConnection.getColumns (live column import)', () => {
  it('maps columns to ft geometry with section, groups, and height', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection('http://127.0.0.1:8744');
    await conn.connect();

    const cols = await conn.getColumns!({});
    expect(cols.map(c => c.name).sort()).toEqual(['C1', 'C2']);

    const c1 = cols.find(c => c.name === 'C1')!;
    expect(c1.story).toBe('L1');
    expect(c1.section).toBe('C18X18');
    expect(c1.groups).toEqual(['Cols']);
    expect(c1.pt1).toEqual({ x: 0, y: 0, z: 0 });
    expect(c1.pt2).toEqual({ x: 0, y: 0, z: 12 });
    expect(c1.heightFt).toBeCloseTo(12, 6); // from explicit Length

    const c2 = cols.find(c => c.name === 'C2')!;
    expect(c2.heightFt).toBeCloseTo(12, 6); // from node distance (no Length column)
  });

  it('filters columns by story, section, and group', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();

    expect(await conn.getColumns!({ stories: ['L1'] })).toHaveLength(2);
    expect(await conn.getColumns!({ stories: ['L2'] })).toHaveLength(0); // beams are on L2
    expect(await conn.getColumns!({ sections: ['C18X18'] })).toHaveLength(2);
    expect(await conn.getColumns!({ groups: ['Cols'] })).toHaveLength(2);
    expect(await conn.getColumns!({ groups: ['Girders'] })).toHaveLength(0);
  });

  it('returns an empty list (no throw) when the model has no column table', async () => {
    mockHttp({ ...TABLES, 'Column Object Connectivity': [] });
    const conn = new BridgeConnection();
    await conn.connect();
    expect(await conn.getColumns!({})).toEqual([]);
  });

  it('still reads beams alongside columns (no regression)', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();
    const beams = await conn.getBeams({});
    expect(beams).toHaveLength(1);
    expect(beams[0].name).toBe('B1');
    expect(beams[0].groups).toEqual([]); // B1 isn't in any group
    // getColumns is now advertised on the live connection → wizard enables the scope
    expect(typeof conn.getColumns).toBe('function');
  });
});
