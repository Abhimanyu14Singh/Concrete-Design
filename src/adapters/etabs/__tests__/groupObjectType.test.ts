/**
 * Group membership must be matched by ObjectType, not by unique name alone.
 * ETABS unique names are per-object-type, so a frame "102" and a joint "102" are
 * different objects. Before the fix, a grouped joint/shell leaked its group onto
 * the same-named frame, and that frame got imported even though only the joint was
 * in the group (the "extra beams on the plan" bug).
 */
import { describe, it, expect, vi } from 'vitest';
import { BridgeConnection } from '../bridgeClient';
import { objCategory } from '../tableConnection';

type Row = Record<string, unknown>;

const TABLES: Record<string, Row[]> = {
  'Program Control': [{ CurrUnits: 'kN, m, C' }],
  'Beam Object Connectivity': [
    { UniqueName: '101', Story: 'L2', UniquePtI: 'P1', UniquePtJ: 'P2', Length: 6 },
    { UniqueName: '102', Story: 'L2', UniquePtI: 'P2', UniquePtJ: 'P3', Length: 6 },
    { UniqueName: '103', Story: 'L2', UniquePtI: 'P3', UniquePtJ: 'P4', Length: 6 },
    { UniqueName: '104', Story: 'L2', UniquePtI: 'P4', UniquePtJ: 'P5', Length: 6 },
    { UniqueName: '105', Story: 'L2', UniquePtI: 'P5', UniquePtJ: 'P6', Length: 6 },
  ],
  'Point Object Connectivity': [
    { UniqueName: 'P1', X: 0, Y: 0, Z: 3 }, { UniqueName: 'P2', X: 6, Y: 0, Z: 3 },
    { UniqueName: 'P3', X: 12, Y: 0, Z: 3 }, { UniqueName: 'P4', X: 18, Y: 0, Z: 3 },
    { UniqueName: 'P5', X: 24, Y: 0, Z: 3 }, { UniqueName: 'P6', X: 30, Y: 0, Z: 3 },
  ],
  'Frame Assignments - Section Properties': [
    { UniqueName: '101', SectProp: 'B300X600' }, { UniqueName: '102', SectProp: 'B300X600' },
    { UniqueName: '103', SectProp: 'B300X600' }, { UniqueName: '104', SectProp: 'B300X600' },
    { UniqueName: '105', SectProp: 'B300X600' },
  ],
  'Frame Section Property Definitions - Concrete Rectangular': [
    { Name: 'B300X600', Material: 'C30', t3: 0.6, t2: 0.3 },
  ],
  'Group Assignments': [
    { GroupName: 'G', ObjectType: 'Beam',  ObjectUniqueName: '101' }, // frame 101 IS in G ✓
    { GroupName: 'G', ObjectType: 'Line',  ObjectUniqueName: '105' }, // ETABS labels frames "Line" — must still import
    { GroupName: 'G', ObjectType: 'Joint', ObjectUniqueName: '102' }, // JOINT 102 in G — must NOT pull beam 102
    { GroupName: 'G', ObjectType: 'Shell', ObjectUniqueName: '103' }, // SHELL 103 in G — must NOT pull beam 103
    { GroupName: 'U', ObjectUniqueName: '104' },                      // untyped row — must still import (frame default)
  ],
};

function mockHttp(tables: Record<string, Row[]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/connect' && init?.method === 'POST')
      return { ok: true, status: 200, json: async () => ({ ok: true, message: 'tower.edb' }) } as Response;
    if (u.pathname === '/table') {
      const key = u.searchParams.get('key') ?? '';
      return { ok: true, status: 200, json: async () => ({ rows: tables[key] ?? [] }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response;
  }));
}

describe('ETABS group membership is object-type aware', () => {
  it('a group filter imports FRAME members (incl. the "Line" type), not same-named joints/shells', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();
    const inGroup = await conn.getBeams({ groups: ['G'] });
    expect(inGroup.map(b => b.name).sort()).toEqual(['101', '105']); // Beam + Line frames; NOT 102 (joint) or 103 (shell)
  });

  it('the leaked frames carry no phantom group membership at all', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();
    const all = await conn.getBeams({});
    const byId = new Map(all.map(b => [b.name, b.groups]));
    expect(byId.get('101')).toEqual(['G']); // Beam-typed frame
    expect(byId.get('105')).toEqual(['G']); // Line-typed frame (ETABS's real frame label)
    expect(byId.get('102')).toEqual([]); // joint's group must not appear on the beam
    expect(byId.get('103')).toEqual([]); // shell's group must not appear on the beam
  });

  it('untyped Group Assignments rows still apply (no membership lost)', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();
    const inU = await conn.getBeams({ groups: ['U'] });
    expect(inU.map(b => b.name)).toEqual(['104']);
  });

  it('still lists every group name in the picker, even joint/shell-only ones', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();
    expect(await conn.getGroups()).toEqual(['G', 'U']);
  });
});

describe('objCategory', () => {
  it('treats frame object types — incl. ETABS\'s "Line" — as frame', () => {
    for (const t of ['Frame', 'Beam', 'Column', 'Brace', 'Line', 'FRAME', 'LineObj']) expect(objCategory(t)).toBe('frame');
  });
  it('buckets area/shell types together', () => {
    for (const t of ['Area', 'Shell', 'Wall', 'Slab', 'Floor']) expect(objCategory(t)).toBe('area');
  });
  it('buckets point/joint types together', () => {
    for (const t of ['Point', 'Joint', 'Node']) expect(objCategory(t)).toBe('point');
  });
  it('defaults empty or unrecognised types to frame (never drops real frames)', () => {
    expect(objCategory('')).toBe('frame');
    expect(objCategory('  ')).toBe('frame');
    expect(objCategory('Link')).toBe('frame');
    expect(objCategory('SomethingNew')).toBe('frame');
  });
});
