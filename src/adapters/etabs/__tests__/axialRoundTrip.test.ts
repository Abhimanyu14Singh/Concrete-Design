/**
 * Axial sign, ETABS → app → S-Concrete, in one pass.
 *
 * Three conventions, and only the app disagrees with the other two:
 *
 *   ETABS      `Element Forces.P`   compression NEGATIVE
 *   S-Concrete `Nf` / `N`           compression NEGATIVE
 *   this app   `LoadCase.Pu`        compression POSITIVE
 *
 * So the sign is flipped TWICE — once reading in, once writing out — and the two
 * flips must both be present or both be absent. Neither of those was true:
 *
 *   • the import never flipped, so an ETABS beam in compression was DESIGNED as if
 *     in tension. That is not cosmetic: it removes the Nu/(6·Ag) credit from V_c
 *     (Table 22.5.5.1), removes the √(1 + Nu/(4·Acp·λ√f′c)) credit from T_cr
 *     (§22.7.5.1), and runs the P-M interaction on the wrong branch.
 *   • the ACI .SCO writer never flipped either, while the EC2 one always had.
 *
 * Because the two omissions cancelled, a value handed to S-Concrete still agreed
 * with ETABS — the round trip looked fine while every DCR in between was computed
 * on the wrong sign. That is why this file checks the MIDDLE of the chain and not
 * just the ends.
 *
 * Reference: `Examples/ACI/Example 1` — 1000 kips of compression, which ETABS would
 * report as −1000 and S-Concrete prints as "N = −1000.0 kips" under *Max. Axial
 * Comp. Util.*, with an axial utilisation of 0.861 the engine reproduces.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BridgeConnection } from '../bridgeClient';
import { stationLoadCases } from '../index';
import { aciBeamUlsRows } from '../../../utils/sco/scoWriterACI';
import { designMember } from '../../../utils/concreteDesign';
import type { LoadCase, MaterialProps, Member, RebarLayout, SectionDimensions } from '../../../types';

type Row = Record<string, unknown>;

/** An imperial (kip-ft) model so no unit factor obscures the sign. */
function mockHttp(forceRows: Row[]) {
  const tables: Record<string, Row[]> = {
    'Element Forces - Beams': forceRows,
    'Program Control': [{ CurrUnits: 'Kip, ft, F' }],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/connect' && init?.method === 'POST')
      return { ok: true, status: 200, json: async () => ({ ok: true, message: 'tower.edb' }) } as Response;
    if (u.pathname === '/table')
      return { ok: true, status: 200, json: async () => ({ rows: tables[u.searchParams.get('key') ?? ''] ?? [] }) } as Response;
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response;
  }));
}

const forceRow = (P: number): Row =>
  ({ UniqueName: 'B1', Combo: 'ULS', Station: 0, P, V2: 60, M3: 290, T: 0 });

async function stationsFor(P: number) {
  mockHttp([forceRow(P)]);
  const conn = new BridgeConnection('http://127.0.0.1:8770');
  await conn.connect();
  const out = await conn.getStationForces(['B1'], ['ULS']);
  return out['B1'][0].stations;
}

beforeEach(() => vi.unstubAllGlobals());

describe('ETABS → app: the sign is flipped on the way in', () => {
  it('ETABS P = −1000 (compression) becomes Pu = +1000', async () => {
    const st = await stationsFor(-1000);
    expect(st[0].P).toBeCloseTo(1000, 6);
  });

  it('ETABS P = +50 (tension) becomes Pu = −50', async () => {
    const st = await stationsFor(50);
    expect(st[0].P).toBeCloseTo(-50, 6);
  });

  it('zero is zero', async () => {
    expect((await stationsFor(0))[0].P).toBeCloseTo(0, 9);
  });

  it('and the sign survives into the LoadCase the engine designs against', async () => {
    const st = await stationsFor(-1000);
    const [row] = stationLoadCases([{ combo: 'ULS', stations: st }]);
    expect(row.Pu).toBeCloseTo(1000, 2);
  });
});

// ── the middle of the chain: does the wrong sign change a number? ────────────
const sect: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 28, coverClear: 1.5, stirrupDia: 5 };
const mat: MaterialProps = { fc: 6000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const cage: RebarLayout = {
  topBars: [{ numBars: 4, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }, { numBars: 4, barSize: 8 }],
  ties: { barSize: 5, spacing: 9, legs: 2 },
  layerClearSpacing: 1.0,
};
const at = (Pu: number) =>
  designMember(sect, mat, cage, { id: 'lc', label: 'ULS', Mu_pos: 290, Mu_neg: 0, Vu: 60, Tu: 0, Pu } as LoadCase, 20);

describe('getting the sign wrong is not cosmetic', () => {
  it('compression and tension give materially different shear capacity', () => {
    const comp = at(1000), tens = at(-1000);
    // Example 1's own numbers: ØVcz = 85.0 kips in compression. Flip the sign and the
    // concrete contribution is destroyed instead of credited.
    expect(comp.phi_Vn).toBeGreaterThan(tens.phi_Vn * 1.5);
    expect(comp.DCR_shear).toBeLessThan(tens.DCR_shear);
  });

  it('and different flexural capacity, which is the point of importing axial at all', () => {
    // 1000 kips of compression lifts ØMn from the pure-bending value; the same
    // magnitude in tension cuts it. Designing one as the other is the failure mode.
    expect(at(1000).phi_Mn_pos).not.toBeCloseTo(at(-1000).phi_Mn_pos, 1);
  });

  it('the P-M check runs on the branch the sign selects', () => {
    expect(at(1000).DCR_axial).toBeGreaterThan(0);
    expect(at(1000).DCR_axial_tens).toBe(0);
    expect(at(-1000).DCR_axial).toBe(0);
    expect(at(-1000).DCR_axial_tens).toBeGreaterThan(0);
  });
});

// ── app → S-Concrete, and back to where ETABS started ────────────────────────
const beamWith = (Pu: number): Member => ({
  id: 'B1', label: 'B1', memberType: 'beam', span: 20,
  material: mat, section: sect, rebar: cage,
  loads: [{ id: 'lc', label: 'ULS', Mu_pos: 290, Mu_neg: 0, Vu: 60, Tu: 0, Pu } as LoadCase],
} as Member);
const nfOf = (rowText: string) => Number(rowText.split('\t')[1]);

describe('app → S-Concrete: flipped back, so the two tools agree', () => {
  it('Pu = +1000 (compression) is written as Nf = −1000', () => {
    expect(nfOf(aciBeamUlsRows(beamWith(1000))[0])).toBeCloseTo(-1000, 3);
  });

  it('the value S-Concrete receives equals the value ETABS reported', async () => {
    // THE WHOLE POINT. −1000 out of ETABS, +1000 inside the app, −1000 into the .SCO.
    const etabsP = -1000;
    const st = await stationsFor(etabsP);
    const [rowLc] = stationLoadCases([{ combo: 'ULS', stations: st }]);
    const nf = nfOf(aciBeamUlsRows(beamWith(rowLc.Pu!))[0]);
    expect(nf).toBeCloseTo(etabsP, 2);
  });

  it('and the same holds for tension', async () => {
    const etabsP = 50;
    const st = await stationsFor(etabsP);
    const [rowLc] = stationLoadCases([{ combo: 'ULS', stations: st }]);
    expect(nfOf(aciBeamUlsRows(beamWith(rowLc.Pu!))[0])).toBeCloseTo(etabsP, 2);
  });

  it('the app is the only place the sign is inverted — both ends match each other', async () => {
    for (const etabsP of [-1000, -250, 0, 50, 400]) {
      const st = await stationsFor(etabsP);
      const [rowLc] = stationLoadCases([{ combo: 'ULS', stations: st }]);
      expect(rowLc.Pu, `ETABS ${etabsP}`).toBeCloseTo(-etabsP, 2);
      expect(nfOf(aciBeamUlsRows(beamWith(rowLc.Pu!))[0]), `ETABS ${etabsP}`).toBeCloseTo(etabsP, 2);
    }
  });
});
