/**
 * Units detection source of truth. ETABS formats every table via
 * GetTableForDisplayArray in the API "present units", which GetPresentUnits (the
 * eUnits enum) reports. The "Program Control" CurrUnits string, by contrast, is
 * the model's SAVED/GUI unit system — and on a locked model the two can DISAGREE
 * (GUI shows kip-in while the tables come back in kN·m). Regression for the bug
 * where a metric model imported with kip-in scaling: a 300×700 mm beam became
 * 0.3×0.7 in and 3 ksi concrete read as ~20,000 ksi.
 *
 * The connection must trust the enum (authoritative for the table data) over
 * CurrUnits, and fall back to CurrUnits only when the enum is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { TableConnection, type TableRow } from '../tableConnection';

// A metric (kN·m) model: sections in metres, concrete Fc in kPa. CurrUnits is
// deliberately the *wrong* GUI string ("kip, in") to prove the enum wins.
const KNM_TABLES: Record<string, TableRow[]> = {
  'Program Control': [{ CurrUnits: 'kip, in, F' }],
  'Beam Object Connectivity': [
    { UniqueName: 'B1', Story: 'L1', UniquePtI: 'P1', UniquePtJ: 'P2', Length: 6 },
  ],
  'Point Object Connectivity': [
    { UniqueName: 'P1', X: 0, Y: 0, Z: 0 },
    { UniqueName: 'P2', X: 6, Y: 0, Z: 0 },
  ],
  'Frame Assignments - Section Properties': [{ UniqueName: 'B1', SectProp: 'B_300X700' }],
  'Frame Section Property Definitions - Concrete Rectangular': [
    { Name: 'B_300X700', Material: 'C30', t2: 0.3, t3: 0.7 }, // metres → 300×700 mm
  ],
  'Material Properties - Concrete Data': [{ Material: 'C30', Fc: 20684.271 }], // kPa = 3 ksi
  'Group Assignments': [],
};

/** Minimal TableConnection whose transport returns fixed tables + a chosen enum. */
class FakeConn extends TableConnection {
  readonly kind = 'com' as const;
  private tables: Record<string, TableRow[]>;
  private unitsEnum: number | null;
  constructor(tables: Record<string, TableRow[]>, unitsEnum: number | null) {
    super();
    this.tables = tables;
    this.unitsEnum = unitsEnum;
  }
  protected async openSession() { return { modelName: 'fake' }; }
  protected async fetchTable(key: string): Promise<TableRow[]> { return this.tables[key] ?? []; }
  protected async fetchUnitsEnum(): Promise<number | null> { return this.unitsEnum; }
}

describe('Units detection — enum is authoritative over CurrUnits', () => {
  it('trusts the GetPresentUnits enum (kN·m) even when CurrUnits says kip-in', async () => {
    const conn = new FakeConn(KNM_TABLES, 6); // 6 = kN_m
    const info = await conn.connect();
    expect(info.units).toBe('kn-m');           // enum won, not "kip-in"

    // 0.3 m → 11.811 in, 0.7 m → 27.559 in (NOT 0.3×0.7 in).
    const s = (await conn.getFrameSections()).find(x => x.name === 'B_300X700')!;
    expect(s.width).toBeCloseTo(11.811, 2);
    expect(s.depth).toBeCloseTo(27.559, 2);

    // 20 684.271 kPa → 3000 psi (NOT ~20 million psi).
    const mat = (await conn.getMaterials()).find(m => m.name === 'C30')!;
    expect(mat.fc).toBeCloseTo(3000, 0);
  });

  it('falls back to CurrUnits when the enum is unavailable (-1)', async () => {
    const conn = new FakeConn(KNM_TABLES, -1); // sidecar "unavailable" sentinel
    const info = await conn.connect();
    expect(info.units).toBe('kip-in');         // no valid enum → use CurrUnits
  });

  it('ignores an invalid enum (0) and uses CurrUnits', async () => {
    const conn = new FakeConn({ ...KNM_TABLES, 'Program Control': [{ CurrUnits: 'kN, m, C' }] }, 0);
    const info = await conn.connect();
    expect(info.units).toBe('kn-m');           // enum 0 is not a valid eUnits → CurrUnits
  });
});
