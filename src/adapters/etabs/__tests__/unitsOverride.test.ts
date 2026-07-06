/**
 * User-correctable unit interpretation. The "massive glitch" the app can hit is
 * a SILENT fallback: when "Program Control" CurrUnits can't be read AND the
 * eUnits enum is unavailable (HTTP bridge, or a locked model the sidecar won't
 * unlock), TableConnection assumes kip-ft. On a real kN-m model that mis-scales
 * forces (~4.45×), moments (~1.36×) and sections (~0.30×) all at once.
 *
 * The wizard now surfaces the interpretation (getUnitInfo) and lets the user
 * correct it (setUnitSystem / setStressUnit). These tests lock in that the
 * override actually re-drives every conversion.
 */
import { describe, it, expect, vi } from 'vitest';
import { BridgeConnection } from '../bridgeClient';

type Row = Record<string, unknown>;

// A kN-m model, but with NO "Program Control" table — so detection fails and the
// connection falls back to the kip-ft default (the glitch). A 0.3×0.6 m section,
// a 100 kN shear and a 200 kN·m moment, plus 30000 kPa (=30 MPa) concrete.
const UNDETECTED_KNM: Record<string, Row[]> = {
  // 'Program Control' deliberately absent → DEFAULT_UNITS (kip-ft, assumed).
  'Beam Object Connectivity': [
    { UniqueName: 'B1', Story: 'L1', UniquePtI: 'P1', UniquePtJ: 'P2', Length: 6 },
  ],
  'Point Object Connectivity': [
    { UniqueName: 'P1', X: 0, Y: 0, Z: 0 },
    { UniqueName: 'P2', X: 6, Y: 0, Z: 0 },
  ],
  'Frame Assignments - Section Properties': [{ UniqueName: 'B1', SectProp: 'B300X600' }],
  'Frame Section Property Definitions - Concrete Rectangular': [
    { Name: 'B300X600', Material: 'C30', t2: 0.3, t3: 0.6 },
  ],
  'Material Properties - Concrete Data': [{ Material: 'C30', Fc: 30000 }], // kPa in kN-m
  'Group Assignments': [],
  'Design Forces - Beams': [
    { UniqueName: 'B1', Combo: 'ULS', Station: 0, V2: 100, M3: 0, P: 0, T: 0 },
    { UniqueName: 'B1', Combo: 'ULS', Station: 6, V2: -100, M3: 200, P: 0, T: 0 },
  ],
};

function mockHttp(tables: Record<string, Row[]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/connect' && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, message: 'knm-model.edb' }) } as Response;
    }
    if (u.pathname === '/table') {
      const key = u.searchParams.get('key') ?? '';
      return { ok: true, status: 200, json: async () => ({ rows: tables[key] ?? [] }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response;
  }));
}

describe('Unit interpretation — silent fallback is flagged and correctable', () => {
  it('flags the fallback as "assumed" when units cannot be detected', async () => {
    mockHttp(UNDETECTED_KNM);
    const conn = new BridgeConnection();
    const info = await conn.connect();
    expect(info.units).toBe('kip-ft (assumed)');

    const u = conn.getUnitInfo();
    expect(u.assumed).toBe(true);
    expect(u.forceKey).toBe('kip');
    expect(u.lengthKey).toBe('ft');
  });

  it('mis-scales forces and sections under the wrong (assumed) units', async () => {
    mockHttp(UNDETECTED_KNM);
    const conn = new BridgeConnection();
    await conn.connect();

    // 0.3 m read as 0.3 ft → 3.6 in (should be 300 mm ≈ 11.8 in).
    const s = (await conn.getFrameSections()).find(x => x.name === 'B300X600')!;
    expect(s.width).toBeCloseTo(3.6, 3);

    // 100 kN read as 100 kip; 200 kN·m read as 200 kip-ft.
    const forces = await conn.getStationForces(['B1'], ['ULS']);
    const maxV = Math.max(...forces['B1'][0].stations.map(st => Math.abs(st.V)));
    const maxM = Math.max(...forces['B1'][0].stations.map(st => st.M));
    expect(maxV).toBeCloseTo(100, 3);
    expect(maxM).toBeCloseTo(200, 3);
  });

  it('setUnitSystem(kn,m) re-drives every conversion to true values', async () => {
    mockHttp(UNDETECTED_KNM);
    const conn = new BridgeConnection();
    await conn.connect();
    // Prime the caches under the wrong units first, to prove they are invalidated.
    await conn.getFrameSections();
    await conn.getStationForces(['B1'], ['ULS']);

    conn.setUnitSystem('kn', 'm');

    const u = conn.getUnitInfo();
    expect(u.assumed).toBe(false);
    expect(u.label).toBe('kn-m');

    // 0.3 m → 11.811 in ; 0.6 m → 23.622 in.
    const s = (await conn.getFrameSections()).find(x => x.name === 'B300X600')!;
    expect(s.width).toBeCloseTo(11.811, 2);
    expect(s.depth).toBeCloseTo(23.622, 2);

    // 100 kN → 22.48 kip ; 200 kN·m → 147.5 kip-ft.
    const forces = await conn.getStationForces(['B1'], ['ULS']);
    const maxV = Math.max(...forces['B1'][0].stations.map(st => Math.abs(st.V)));
    const maxM = Math.max(...forces['B1'][0].stations.map(st => st.M));
    expect(maxV).toBeCloseTo(22.481, 2);
    expect(maxM).toBeCloseTo(147.51, 1);

    // 30000 kPa → 30 MPa ≈ 4351 psi.
    const mat = (await conn.getMaterials()).find(m => m.name === 'C30')!;
    expect(mat.fc).toBeCloseTo(4351.1, 0);
  });

  it('setStressUnit pins the material unit independently of force/length', async () => {
    mockHttp(UNDETECTED_KNM);
    const conn = new BridgeConnection();
    await conn.connect();
    conn.setUnitSystem('kn', 'm');       // sizes/forces in kN-m …
    conn.setStressUnit('mpa');           // … but material values are really MPa

    // Raw Fc 30000 now interpreted as MPa (145.04 psi each): a deliberate,
    // explicit reinterpretation — proves the override path is wired.
    const mat = (await conn.getMaterials()).find(m => m.name === 'C30')!;
    expect(mat.fc).toBeCloseTo(30000 * 145.0377, 0);
    expect(conn.getUnitInfo().stressUnit).toBe('mpa');

    conn.setStressUnit(null);            // back to derived (kn/m²)
    expect(conn.getUnitInfo().stressUnit).toBe('kn/m²');
  });
});
