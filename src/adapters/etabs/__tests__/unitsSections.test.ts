/**
 * Units detection drives every dimensional conversion. Regression for the bug
 * where an SI model's sections imported at ~0.30× their true size (a 300×600 mm
 * beam showed as 91×183 mm): the sidecar's units read fell back to a kip-ft
 * default, so metre-valued section dimensions were scaled by the imperial factor.
 * The fix reads the model's real units from "Program Control" CurrUnits first.
 */
import { describe, it, expect, vi } from 'vitest';
import { BridgeConnection } from '../bridgeClient';

type Row = Record<string, unknown>;

// SI model (kN, m). A 300×600 mm beam is 0.3 m × 0.6 m in the section table.
const SI_TABLES: Record<string, Row[]> = {
  'Program Control': [{ CurrUnits: 'kN, m, C' }],
  'Beam Object Connectivity': [
    { UniqueName: 'B1', Story: 'L1', UniquePtI: 'P1', UniquePtJ: 'P2', Length: 6 }, // 6 m
  ],
  'Point Object Connectivity': [
    { UniqueName: 'P1', X: 0, Y: 0, Z: 0 },
    { UniqueName: 'P2', X: 6, Y: 0, Z: 0 },
  ],
  'Frame Assignments - Section Properties': [
    { UniqueName: 'B1', SectProp: 'B300X600' },
  ],
  'Frame Section Property Definitions - Concrete Rectangular': [
    { Name: 'B300X600', Material: 'C30', t2: 0.3, t3: 0.6 }, // 0.3 m × 0.6 m
  ],
  'Group Assignments': [],
};

function mockHttp(tables: Record<string, Row[]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/connect' && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, message: 'si-model.edb' }) } as Response;
    }
    if (u.pathname === '/table') {
      const key = u.searchParams.get('key') ?? '';
      return { ok: true, status: 200, json: async () => ({ rows: tables[key] ?? [] }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response;
  }));
}

describe('TableConnection units — SI model', () => {
  it('detects the model units from Program Control (kN-m), not a kip-ft default', async () => {
    mockHttp(SI_TABLES);
    const conn = new BridgeConnection();
    const info = await conn.connect();
    expect(info.units).toBe('kn-m');
  });

  it('imports section dimensions at their TRUE size (300×600 mm, not 91×183)', async () => {
    mockHttp(SI_TABLES);
    const conn = new BridgeConnection();
    await conn.connect();

    const s = (await conn.getFrameSections()).find(x => x.name === 'B300X600')!;
    // 0.3 m = 300 mm = 11.811 in ; 0.6 m = 600 mm = 23.622 in (app stores inches).
    expect(s.width).toBeCloseTo(11.811, 2);
    expect(s.depth).toBeCloseTo(23.622, 2);
    // The kip-ft bug produced 0.3 × 12 = 3.6 in (≈91 mm) — guard against a regression.
    expect(s.width).toBeGreaterThan(10);
  });
});
