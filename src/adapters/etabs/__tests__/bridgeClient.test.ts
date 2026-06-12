/**
 * BridgeConnection — unit tests against a mocked bridge server.
 * Covers units detection (Program Control), beam geometry mapping,
 * envelope combo suffix matching, and force unit conversion.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BridgeConnection } from '../bridgeClient';

type Json = Record<string, unknown>;

/** Install a fetch mock serving canned bridge responses. */
function mockBridge(responses: Record<string, Json>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname + (new URL(url).search ?? '');
    for (const [key, body] of Object.entries(responses)) {
      if (path.startsWith(key)) {
        return { ok: true, status: 200, json: async () => body } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response;
  }));
}

// kN-m model fixture
const KNM_RESPONSES: Record<string, Json> = {
  '/connect': { ok: true, message: 'tower.edb' },
  '/table?key=Program%20Control': { rows: [{ CurrUnits: 'kN, m, C' }] },
  '/table?key=Material%20Properties%20-%20Concrete%20Data': {
    rows: [{ Material: 'C30', Fc: 30000 }], // kN/m² = 30 MPa
  },
  '/table?key=Material%20Properties%20-%20Rebar%20Data': { rows: [] },
  '/cases': { cases: [{ name: 'Env_ULS', type: 'Envelope' }] },
  '/beams': {
    beams: [{
      uniqueName: '101', story: 'L2', beamBay: 'B1', ptI: 'P1', ptJ: 'P2',
      length: 6, section: 'B300X600', b: 300, h: 600, material: 'C30',
    }],
    stories: ['L2'],
  },
  '/joint-coords': {
    data: [
      { UniqueName: 'P1', X: 0, Y: 0, Z: 3 },
      { UniqueName: 'P2', X: 6, Y: 0, Z: 3 },
    ],
  },
  '/beam-forces': {
    data: [
      // envelope step suffixes: -1 = Max, -2 = Min
      { UniqueName: '101', Combo: 'Env_ULS-1', Station: 0, P: 10, V2: 100, M3: 200, T: 5 },
      { UniqueName: '101', Combo: 'Env_ULS-1', Station: 3, P: 10, V2: 0, M3: 350, T: 5 },
      { UniqueName: '101', Combo: 'Env_ULS-2', Station: 0, P: -10, V2: -100, M3: -120, T: -5 },
      { UniqueName: '999', Combo: 'Env_ULS-1', Station: 0, P: 1, V2: 1, M3: 1, T: 1 },
      { UniqueName: '101', Combo: 'OtherCombo', Station: 0, P: 99, V2: 99, M3: 99, T: 99 },
    ],
  },
};

describe('BridgeConnection (kN-m model)', () => {
  let conn: BridgeConnection;

  beforeEach(async () => {
    mockBridge(KNM_RESPONSES);
    conn = new BridgeConnection('http://127.0.0.1:8744');
    await conn.connect();
  });

  it('detects kN-m units from Program Control', async () => {
    const info = await conn.connect();
    expect(info.units).toBe('kn-m');
  });

  it('maps beams to ft geometry', async () => {
    const beams = await conn.getBeams({});
    expect(beams).toHaveLength(1);
    const b = beams[0];
    expect(b.name).toBe('101');
    expect(b.pt1.x).toBeCloseTo(0, 5);
    expect(b.pt2.x).toBeCloseTo(6 * 3.280839895, 4); // 6 m → ft
    expect(b.lengthFt).toBeCloseTo(19.685, 2);
  });

  it('converts section dims mm → in', async () => {
    const secs = await conn.getFrameSections();
    expect(secs).toHaveLength(1);
    expect(secs[0].width).toBeCloseTo(300 / 25.4, 4);  // 300 mm → in
    expect(secs[0].depth).toBeCloseTo(600 / 25.4, 4);  // 600 mm → in
  });

  it('converts concrete fc to psi', async () => {
    const mats = await conn.getMaterials();
    const c30 = mats.find(m => m.name === 'C30');
    // 30 000 kN/m² = 30 MPa ≈ 4351 psi
    expect(c30?.fc).toBeCloseTo(4351, 0);
  });

  it('matches envelope combos by base name and converts forces to kip / kip-ft', async () => {
    const out = await conn.getStationForces(['101'], ['Env_ULS']);
    const cfs = out['101'];
    // -1 (Max) and -2 (Min) both match base "Env_ULS"; "OtherCombo" excluded
    expect(cfs.map(c => c.combo).sort()).toEqual(['Env_ULS-1', 'Env_ULS-2']);

    const max = cfs.find(c => c.combo === 'Env_ULS-1')!;
    expect(max.stations).toHaveLength(2);
    // 100 kN → kip
    expect(max.stations[0].V).toBeCloseTo(100 * 0.2248089, 4);
    // 350 kN·m → kip-ft
    expect(max.stations[1].M).toBeCloseTo(350 * 0.2248089 * 3.280839895, 3);
    // P and T populated
    expect(max.stations[0].P).toBeCloseTo(10 * 0.2248089, 4);
    expect(max.stations[0].T).toBeCloseTo(5 * 0.2248089 * 3.280839895, 4);
    // station x in ft
    expect(max.stations[1].x).toBeCloseTo(3 * 3.280839895, 4);
  });

  it('returns empty arrays for frames with no rows', async () => {
    const out = await conn.getStationForces(['101', 'no-such-frame'], ['Env_ULS']);
    expect(out['no-such-frame']).toEqual([]);
  });
});

describe('BridgeConnection (kip-in model)', () => {
  it('converts ksi fc to psi and inches to ft', async () => {
    mockBridge({
      ...KNM_RESPONSES,
      '/table?key=Program%20Control': { rows: [{ CurrUnits: 'Kip, in, F' }] },
      '/table?key=Material%20Properties%20-%20Concrete%20Data': {
        rows: [{ Material: 'fc5000', Fc: 5 }], // 5 ksi
      },
      '/joint-coords': {
        data: [
          { UniqueName: 'P1', X: 0, Y: 0, Z: 120 },
          { UniqueName: 'P2', X: 240, Y: 0, Z: 120 }, // 240 in = 20 ft
        ],
      },
    });
    const conn = new BridgeConnection();
    const info = await conn.connect();
    expect(info.units).toBe('kip-in');

    const mats = await conn.getMaterials();
    expect(mats.find(m => m.name === 'fc5000')?.fc).toBeCloseTo(5000, 6);

    const beams = await conn.getBeams({});
    expect(beams[0].pt2.x).toBeCloseTo(20, 5);
  });
});

describe('BridgeConnection (bridge unreachable)', () => {
  it('throws a start-the-bridge message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const conn = new BridgeConnection();
    await expect(conn.connect()).rejects.toThrow(/Start it first/);
  });
});
