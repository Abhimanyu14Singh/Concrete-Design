/**
 * Force source selection. The app can import beam/column forces from either the
 * ETABS "Design Forces …" table (design stations / face-of-support) or the raw
 * "Element Forces …" table (per-combo analysis forces — what the ETABS
 * frame-force display shows). These differ, so a user comparing the app to the
 * analysis display needs to pick 'element'. Regression for "imported M/V don't
 * match ETABS" being a table-choice issue, not a unit-conversion bug.
 */
import { describe, it, expect } from 'vitest';
import { TableConnection, type TableRow } from '../tableConnection';

// kN·m model. Design and Element tables carry DIFFERENT values so we can tell
// which one was read (200 vs 350 kN·m; 100 vs 175 kN).
const TABLES: Record<string, TableRow[]> = {
  'Program Control': [{ CurrUnits: 'kN, m, C' }],
  'Design Forces - Beams': [{ UniqueName: 'B1', Combo: 'ULS', Station: 0, V2: 100, M3: 200, P: 0, T: 0 }],
  'Element Forces - Beams': [{ UniqueName: 'B1', Combo: 'ULS', Station: 0, V2: 175, M3: 350, P: 0, T: 0 }],
};

class FakeConn extends TableConnection {
  readonly kind = 'com' as const;
  private tables: Record<string, TableRow[]>;
  constructor(tables: Record<string, TableRow[]>) { super(); this.tables = tables; }
  protected async openSession() { return { modelName: 'fake' }; }
  protected async fetchTable(key: string): Promise<TableRow[]> { return this.tables[key] ?? []; }
  protected async fetchUnitsEnum(): Promise<number | null> { return 6; } // kN-m
}

describe('Force source — Design vs Analysis (Element) table', () => {
  it('reads Design Forces by default', async () => {
    const conn = new FakeConn(TABLES);
    await conn.connect();
    const f = await conn.getStationForces(['B1'], ['ULS']);
    // 200 kN·m × 0.737562 = 147.5 kip-ft.
    expect(f['B1'][0].stations[0].M).toBeCloseTo(147.51, 1);
    expect(conn.getLastForceTable()).toBe('Design Forces - Beams');
  });

  it('reads Element (Analysis) forces after setForceSource("element")', async () => {
    const conn = new FakeConn(TABLES);
    await conn.connect();
    conn.setForceSource('element');
    const f = await conn.getStationForces(['B1'], ['ULS']);
    // 350 kN·m × 0.737562 = 258.1 kip-ft ; 175 kN × 0.224809 = 39.3 kip.
    expect(f['B1'][0].stations[0].M).toBeCloseTo(258.15, 1);
    expect(f['B1'][0].stations[0].V).toBeCloseTo(39.34, 1);
    expect(conn.getLastForceTable()).toBe('Element Forces - Beams');
  });

  it('falls back to the other table when the chosen one is empty', async () => {
    const conn = new FakeConn({ ...TABLES, 'Design Forces - Beams': [] });
    await conn.connect();
    const f = await conn.getStationForces(['B1'], ['ULS']); // default 'design', but empty
    expect(conn.getLastForceTable()).toBe('Element Forces - Beams');
    expect(f['B1'][0].stations[0].M).toBeCloseTo(258.15, 1);
  });
});
