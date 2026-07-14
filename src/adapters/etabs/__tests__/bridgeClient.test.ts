/**
 * TableConnection mapping tests — exercised through both transports:
 * BridgeConnection (HTTP, mocked fetch) and ComConnection (mocked IPC).
 * Covers units detection (Program Control), beam geometry/groups mapping,
 * exact + derived section dims, materials, envelope combo suffix matching,
 * and force unit conversion.
 */
import { describe, it, expect, vi } from 'vitest';
import { BridgeConnection } from '../bridgeClient';
import { ComConnection } from '../comClient';
import { eUnitsToFactors } from '../tableConnection';

type Row = Record<string, unknown>;

// ── canned tables for a kN-m model ─────────────────────────────────────────
const TABLES: Record<string, Row[]> = {
  'Program Control': [{ CurrUnits: 'kN, m, C' }],
  'Beam Object Connectivity': [
    { UniqueName: '101', Story: 'L2', UniquePtI: 'P1', UniquePtJ: 'P2', Length: 6 },
  ],
  'Point Object Connectivity': [
    { UniqueName: 'P1', X: 0, Y: 0, Z: 3 },
    { UniqueName: 'P2', X: 6, Y: 0, Z: 3 },
  ],
  'Frame Assignments - Section Properties': [
    { UniqueName: '101', SectProp: 'B300X600' },
  ],
  'Group Assignments': [
    { GroupName: 'GravityBeams', ObjectType: 'Beam', ObjectUniqueName: '101' },
  ],
  'Frame Section Property Definitions - Concrete Rectangular': [
    { Name: 'B300X600', Material: 'C30', t3: 0.6, t2: 0.3 }, // m
  ],
  'Frame Section Property Definitions - Summary': [],
  'Material Properties - Concrete Data': [
    { Material: 'C30', Fc: 30000 }, // kN/m² = 30 MPa
  ],
  'Material Properties - Rebar Data': [
    { Material: 'B500', Fy: 500000 }, // kN/m² = 500 MPa
  ],
  'Load Combination Definitions': [{ Name: 'Env_ULS' }],
  'Design Forces - Beams': [
    // envelope step suffixes: -1 = Max, -2 = Min
    { UniqueName: '101', Combo: 'Env_ULS-1', Station: 0, P: 10, V2: 100, M3: 200, T: 5 },
    { UniqueName: '101', Combo: 'Env_ULS-1', Station: 3, P: 10, V2: 0, M3: 350, T: 5 },
    { UniqueName: '101', Combo: 'Env_ULS-2', Station: 0, P: -10, V2: -100, M3: -120, T: -5 },
    { UniqueName: '999', Combo: 'Env_ULS-1', Station: 0, P: 1, V2: 1, M3: 1, T: 1 },
    { UniqueName: '101', Combo: 'OtherCombo', Station: 0, P: 99, V2: 99, M3: 99, T: 99 },
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

/**
 * Mock window.electronAPI.etabs serving the same tables in helper format.
 * unitsEnum: if provided, the mock returns it from getUnits (simulates sidecar
 * calling SetPresentUnits). When null/undefined, getUnits throws (no sidecar).
 */
function mockIpc(tables: Record<string, Row[]>, unitsEnum?: number | null) {
  const etabs = vi.fn(async (method: string, args?: { key?: string; group?: string; combos?: string[] }) => {
    if (method === 'connect') return { modelName: 'tower.edb' };
    if (method === 'getUnits') {
      if (unitsEnum == null) throw new Error('getUnits not available');
      return unitsEnum;
    }
    if (method === 'getTable') {
      const rows = tables[args?.key ?? ''] ?? [];
      const fields = rows.length ? Object.keys(rows[0]) : [];
      // helper returns flat string matrices
      return { fields, rows: rows.map(r => fields.map(f => String(r[f]))) };
    }
    if (method === 'selectCombos') return { combos: true, cases: true, count: args?.combos?.length ?? 0 };
    throw new Error(`unexpected method ${method}`);
  });
  vi.stubGlobal('window', { electronAPI: { etabs } });
  return etabs;
}

function describeMapping(name: string, makeConn: () => BridgeConnection | ComConnection) {
  describe(name, () => {
    it('detects kN-m units from Program Control', async () => {
      const conn = makeConn();
      const info = await conn.connect();
      expect(info.units).toBe('kn-m');
      expect(info.modelName).toContain('tower');
    });

    it('maps beams to ft geometry with stories and ETABS groups', async () => {
      const conn = makeConn();
      await conn.connect();
      const beams = await conn.getBeams({});
      expect(beams).toHaveLength(1);
      const b = beams[0];
      expect(b.name).toBe('101');
      expect(b.story).toBe('L2');
      expect(b.groups).toEqual(['GravityBeams']);
      expect(b.pt2.x).toBeCloseTo(6 * 3.280839895, 4); // 6 m → ft
      expect(b.lengthFt).toBeCloseTo(19.685, 2);
      expect(await conn.getStories()).toEqual(['L2']);
      expect(await conn.getGroups()).toEqual(['GravityBeams']);
    });

    it('reads exact rectangular dims (m → in)', async () => {
      const conn = makeConn();
      await conn.connect();
      const secs = await conn.getFrameSections();
      const s = secs.find(x => x.name === 'B300X600')!;
      expect(s.width).toBeCloseTo(0.3 * 39.3700787, 3);  // 300 mm → in
      expect(s.depth).toBeCloseTo(0.6 * 39.3700787, 3);  // 600 mm → in
      expect(s.material).toBe('C30');
    });

    it('converts fc and fy to psi', async () => {
      const conn = makeConn();
      await conn.connect();
      const mats = await conn.getMaterials();
      expect(mats.find(m => m.name === 'C30')?.fc).toBeCloseTo(4351, 0);   // 30 MPa
      expect(mats.find(m => m.name === 'B500')?.fy).toBeCloseTo(72519, 0); // 500 MPa
    });

    it('matches envelope combos by base name and converts forces to kip / kip-ft', async () => {
      const conn = makeConn();
      await conn.connect();
      const out = await conn.getStationForces(['101', 'no-such'], ['Env_ULS']);
      const cfs = out['101'];
      expect(cfs.map(c => c.combo).sort()).toEqual(['Env_ULS-1', 'Env_ULS-2']);

      const max = cfs.find(c => c.combo === 'Env_ULS-1')!;
      expect(max.stations).toHaveLength(2);
      expect(max.stations[0].V).toBeCloseTo(100 * 0.2248089, 4);              // kN → kip
      expect(max.stations[1].M).toBeCloseTo(350 * 0.2248089 * 3.280839895, 3); // kN·m → kip-ft
      expect(max.stations[0].P).toBeCloseTo(10 * 0.2248089, 4);
      expect(max.stations[0].T).toBeCloseTo(5 * 0.2248089 * 3.280839895, 4);
      expect(max.stations[1].x).toBeCloseTo(3 * 3.280839895, 4);
      expect(out['no-such']).toEqual([]);
    });
  });
}

describeMapping('TableConnection via BridgeConnection (HTTP)', () => {
  mockHttp(TABLES);
  return new BridgeConnection('http://127.0.0.1:8744');
});

describeMapping('TableConnection via ComConnection (IPC sidecar)', () => {
  // No unitsEnum — getUnits throws, falls back to Program Control string (kN-m)
  mockIpc(TABLES);
  return new ComConnection();
});

describe('section dims fallback (Area/I33 derivation)', () => {
  it('derives b×h when the rectangular table lacks the section', async () => {
    mockHttp({
      ...TABLES,
      'Frame Section Property Definitions - Concrete Rectangular': [],
      'Frame Section Property Definitions - Summary': [
        // 0.3 × 0.6 m: Area = 0.18 m², I33 = 0.3·0.6³/12 = 0.0054 m⁴
        { Name: 'B300X600', Material: 'C30', Area: 0.18, I33: 0.0054 },
      ],
    });
    const conn = new BridgeConnection();
    await conn.connect();
    await conn.getBeams({});
    const s = (await conn.getFrameSections()).find(x => x.name === 'B300X600')!;
    expect(s.depth).toBeCloseTo(0.6 * 39.3700787, 2);
    expect(s.width).toBeCloseTo(0.3 * 39.3700787, 2);
  });
});

describe('force table fallback', () => {
  it('falls back to Element Forces - Beams when design forces are empty', async () => {
    mockHttp({
      ...TABLES,
      'Design Forces - Beams': [],
      'Element Forces - Beams': [
        { UniqueName: '101', OutputCase: 'Env_ULS-1', Station: 0, P: 10, V2: 50, M3: 100, T: 2 },
      ],
    });
    const conn = new BridgeConnection();
    await conn.connect();
    const out = await conn.getStationForces(['101'], ['Env_ULS']);
    expect(out['101'][0].stations[0].V).toBeCloseTo(50 * 0.2248089, 4);
  });

  it('throws a run-the-analysis error when both force tables are empty', async () => {
    mockHttp({ ...TABLES, 'Design Forces - Beams': [], 'Element Forces - Beams': [] });
    const conn = new BridgeConnection();
    await conn.connect();
    await expect(conn.getStationForces(['101'], ['Env_ULS'])).rejects.toThrow(/analysis/i);
  });
});

describe('connect-time sanity check', () => {
  it('throws a clear error when the model has no beams', async () => {
    mockHttp({ ...TABLES, 'Beam Object Connectivity': [] });
    const conn = new BridgeConnection();
    await conn.connect();
    await expect(conn.getBeams({})).rejects.toThrow(/no beams/i);
  });
});

describe('bridge unreachable', () => {
  it('throws a start-the-bridge message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const conn = new BridgeConnection();
    await expect(conn.connect()).rejects.toThrow(/Start it first/);
  });
});

describe('eUnitsToFactors', () => {
  it('maps kip-ft (4) correctly', () => {
    const f = eUnitsToFactors(4)!;
    expect(f.forceToKip).toBe(1);
    expect(f.lengthToFt).toBe(1);
    expect(f.label).toBe('kip-ft');
  });
  it('maps kN-m (6) correctly', () => {
    const f = eUnitsToFactors(6)!;
    expect(f.forceToKip).toBeCloseTo(0.2248089, 6);
    expect(f.lengthToFt).toBeCloseTo(3.280839895, 6);
    expect(f.label).toBe('kn-m');
  });
  it('returns null for unknown enum value', () => {
    expect(eUnitsToFactors(99)).toBeNull();
  });
});

describe('ComConnection: selectCombos called before force table fetch', () => {
  it('calls selectCombos with the combo list before getTable for forces', async () => {
    const etabs = mockIpc(TABLES);
    const conn = new ComConnection();
    await conn.connect();
    await conn.getStationForces(['101'], ['Env_ULS']);
    const calls = etabs.mock.calls.map(c => c[0] as string);
    const selectIdx = calls.lastIndexOf('selectCombos');
    const tableIdx = calls.findIndex((m, i) => i > selectIdx && m === 'getTable' &&
      (etabs.mock.calls[i][1] as { key?: string })?.key?.includes('Forces'));
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(tableIdx).toBeGreaterThan(selectIdx);
    const selectArgs = etabs.mock.calls[selectIdx][1] as { combos?: string[] };
    expect(selectArgs.combos).toEqual(['Env_ULS']);
  });

  it('passes group to getTable when sourceGroup is provided', async () => {
    const etabs = mockIpc(TABLES);
    const conn = new ComConnection();
    await conn.connect();
    await conn.getStationForces(['101'], ['Env_ULS'], 'GravityBeams');
    const forceCall = etabs.mock.calls.find(c =>
      c[0] === 'getTable' && (c[1] as { key?: string })?.key?.includes('Forces')
    );
    expect(forceCall).toBeDefined();
    expect((forceCall![1] as { group?: string }).group).toBe('GravityBeams');
  });

  it('BridgeConnection getStationForces still works without selectCombos (no-op)', async () => {
    mockHttp(TABLES);
    const conn = new BridgeConnection();
    await conn.connect();
    const out = await conn.getStationForces(['101'], ['Env_ULS']);
    expect(out['101'].length).toBeGreaterThan(0);
  });
});

describe('ComConnection: units come from the present-units enum (authoritative for tables)', () => {
  it('trusts a valid GetPresentUnits enum over the Program Control GUI string', async () => {
    // GetTableForDisplayArray returns every table in the API "present units",
    // which GetPresentUnits (the enum) reports. Program Control CurrUnits is the
    // model's GUI/saved units and can DIFFER on a locked model — so a valid enum
    // wins. Here the GUI says kip-ft but the tables (and the enum) are kN-m.
    const guiKipFt = { ...TABLES, 'Program Control': [{ CurrUnits: 'kip, ft, F' }] };
    mockIpc(guiKipFt, 6); // enum 6 = kN_m
    const conn = new ComConnection();
    const info = await conn.connect();
    expect(info.units).toBe('kn-m');
  });

  it('falls back to Program Control CurrUnits when the enum is unavailable', async () => {
    mockIpc(TABLES); // getUnits throws → no enum → use CurrUnits (kN-m)
    const conn = new ComConnection();
    const info = await conn.connect();
    expect(info.units).toBe('kn-m');
  });

  it('ignores the sidecar -1 "unavailable" sentinel and uses CurrUnits', async () => {
    mockIpc(TABLES, -1); // enum unavailable (-1) → CurrUnits (kN-m)
    const conn = new ComConnection();
    const info = await conn.connect();
    expect(info.units).toBe('kn-m');
  });
});
