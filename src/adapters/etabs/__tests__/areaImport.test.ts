/**
 * What the area (wall / floor-slab) import actually copes with.
 *
 * Diagnostic first, guard second. Walls and slabs reach the 3D plan through
 * `ModelMap.walls` (slabs are `kind: 'slab'` in the same list), and the whole chain
 * from ETABS to that list swallows every failure: the sidecar returns an empty table
 * rather than throwing, `fetchTable` drops the `ret` code, `loadAreas` catches, and the
 * wizard catches again. So "no walls imported" is indistinguishable from "the model has
 * no walls" — these tests pin which table SHAPES the parser understands, so the answer
 * stops being a guess.
 */
import { describe, it, expect } from 'vitest';
import { TableConnection, type TableRow } from '../tableConnection';
import type { TableProbe } from '../connection';

/** A TableConnection fed canned tables, standing in for ETABS. */
class Fake extends TableConnection {
  // TableConnection narrows `kind` to the two live transports; 'bridge' is the
  // stand-in here. Nothing under test branches on it.
  readonly kind = 'bridge' as const;
  private tables: Record<string, TableRow[]>;
  constructor(tables: Record<string, TableRow[]>) { super(); this.tables = tables; }
  protected async openSession() { return { modelName: 'Fake' }; }
  protected async fetchUnitsEnum() { return null; }
  protected async fetchTable(key: string): Promise<TableRow[]> {
    // Mirror the sidecar: an unknown key is an EMPTY table, not an error.
    return this.tables[key] ?? [];
  }
}

/**
 * A transport that records ETABS's return code, the way ComConnection now does.
 * `refuse` names keys ETABS does not recognise — the case that used to be invisible.
 */
class Reporting extends TableConnection {
  readonly kind = 'com' as const;
  private tables: Record<string, TableRow[]>;
  private refuse: Set<string>;
  constructor(tables: Record<string, TableRow[]>, refuse: string[] = []) {
    super();
    this.tables = tables;
    this.refuse = new Set(refuse);
  }
  protected async openSession() { return { modelName: 'Fake' }; }
  protected async fetchUnitsEnum() { return null; }
  protected async fetchTable(key: string): Promise<TableRow[]> {
    const refused = this.refuse.has(key);
    const rows = refused ? [] : (this.tables[key] ?? []);
    const fields = rows.length ? Object.keys(rows[0]) : [];
    this.noteProbe({ key, ret: refused ? 1 : 0, rows: rows.length, fields });
    return rows;
  }
}

/** Joints shared by every case — a 20ft x 20ft bay, two storeys. */
const POINTS: TableRow[] = [
  { UniqueName: 'P1', X: '0', Y: '0', Z: '12' },
  { UniqueName: 'P2', X: '20', Y: '0', Z: '12' },
  { UniqueName: 'P3', X: '20', Y: '20', Z: '12' },
  { UniqueName: 'P4', X: '0', Y: '20', Z: '12' },
];

const BEAMS: TableRow[] = [
  { Story: 'L2', UniqueName: 'B1', UniquePtI: 'P1', UniquePtJ: 'P2', Length: '20' },
];

const base = (extra: Record<string, TableRow[]>) => new Fake({
  'Beam Object Connectivity': BEAMS,
  'Point Object Connectivity': POINTS,
  'Frame Assignments - Section Properties': [{ UniqueName: 'B1', SectProp: 'B24X16' }],
  ...extra,
});

describe('the area-table shape the parser understands', () => {
  it('reads ONE ROW PER AREA with UniquePt1..N corner columns', async () => {
    const c = base({
      'Area Object Connectivity': [{
        Story: 'L2', UniqueName: 'F1', NumberPoints: '4',
        UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4',
        DesignOrientation: 'Floor',
      }],
    });
    await c.connect();
    const areas = await c.getAreas({});
    expect(areas).toHaveLength(1);
    expect(areas[0].kind).toBe('slab');
    expect(areas[0].points).toHaveLength(4);
  });

  it('classifies a vertical panel as a wall from Design Orientation', async () => {
    const c = base({
      'Point Object Connectivity': [
        { UniqueName: 'W1', X: '0', Y: '0', Z: '0' },
        { UniqueName: 'W2', X: '20', Y: '0', Z: '0' },
        { UniqueName: 'W3', X: '20', Y: '0', Z: '12' },
        { UniqueName: 'W4', X: '0', Y: '0', Z: '12' },
        ...POINTS,
      ],
      'Area Object Connectivity': [{
        Story: 'L2', UniqueName: 'W-A', NumberPoints: '4',
        UniquePt1: 'W1', UniquePt2: 'W2', UniquePt3: 'W3', UniquePt4: 'W4',
        DesignOrientation: 'Wall',
      }],
    });
    await c.connect();
    expect((await c.getAreas({}))[0].kind).toBe('wall');
  });

  it('reads ONE ROW PER CORNER — rows sharing a UniqueName, one point each', async () => {
    // An area has a variable corner count, so ETABS may publish it either way. Guessing
    // wrong drops every row for having fewer than three corners.
    const c = base({
      'Area Object Connectivity': [
        { Story: 'L2', UniqueName: 'F1', NumPoints: '4', PointName: 'P1' },
        { Story: 'L2', UniqueName: 'F1', NumPoints: '4', PointName: 'P2' },
        { Story: 'L2', UniqueName: 'F1', NumPoints: '4', PointName: 'P3' },
        { Story: 'L2', UniqueName: 'F1', NumPoints: '4', PointName: 'P4' },
      ],
    });
    await c.connect();
    const areas = await c.getAreas({});
    expect(areas).toHaveLength(1);
    expect(areas[0].points).toHaveLength(4);
  });

  it('falls back to the plane normal when Design Orientation is absent', async () => {
    const c = base({
      'Area Object Connectivity': [{
        Story: 'L2', UniqueName: 'F1', NumberPoints: '4',
        UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4',
      }],
    });
    await c.connect();
    expect((await c.getAreas({}))[0].kind).toBe('slab');   // all four points share Z
  });
});

describe('what still yields zero areas — and is now reported rather than silent', () => {
  it('a table key this ETABS build spells differently', async () => {
    const c = base({
      // e.g. "Area Object Connectivity - Shell" / a localised or versioned name.
      'Area Object Connectivity - Shell': [{
        Story: 'L2', UniqueName: 'F1', NumberPoints: '4',
        UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4',
      }],
    });
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(0);
  });

  it('corner names that are not in the joint table', async () => {
    const c = base({
      'Area Object Connectivity': [{
        Story: 'L2', UniqueName: 'F1', NumberPoints: '4',
        // Label-style names ("1", "2") where the joint table is keyed by UniqueName.
        UniquePt1: '1', UniquePt2: '2', UniquePt3: '3', UniquePt4: '4',
      }],
    });
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(0);
  });

  it('an empty table — the model genuinely has no areas', async () => {
    const c = base({ 'Area Object Connectivity': [] });
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(0);
  });
});

describe('a source with no area table at all still imports', () => {
  it('getAreas resolves to [] rather than throwing, so the import never breaks', async () => {
    const cases = [
      { 'Area Object Connectivity - Shell': [{ UniqueName: 'F1' }] },
      { 'Area Object Connectivity': [{ Story: 'L2', UniqueName: 'F1', PointName: 'P1' }] },
      { 'Area Object Connectivity': [] },
      {},
    ];
    for (const t of cases) {
      const c = base(t as Record<string, TableRow[]>);
      await c.connect();
      await expect(c.getAreas({})).resolves.toEqual([]);
    }
  });
});

describe('the diagnostic pass separates the four causes', () => {
  const tables = {
    'Beam Object Connectivity': BEAMS,
    'Point Object Connectivity': POINTS,
    'Frame Assignments - Section Properties': [{ UniqueName: 'B1', SectProp: 'B24X16' }],
  } as Record<string, TableRow[]>;

  const areaProbe = (probes: TableProbe[]) =>
    probes.find(p => p.key === 'Area Object Connectivity');

  it('a REFUSED key reports ret != 0 — not an empty model', async () => {
    const c = new Reporting(tables, ['Area Object Connectivity']);
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(0);
    const p = areaProbe(c.tableProbes());
    expect(p).toBeDefined();
    expect(p!.ret).not.toBe(0);        // ETABS said no
    expect(p!.rows).toBe(0);
  });

  it('an EMPTY table reports ret 0 with zero rows — the model really has none', async () => {
    const c = new Reporting({ ...tables, 'Area Object Connectivity': [] });
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(0);
    const p = areaProbe(c.tableProbes());
    expect(p!.ret).toBe(0);            // ETABS delivered it
    expect(p!.rows).toBe(0);           // and it was empty
  });

  it('a COLUMN-NAME mismatch reports ret 0 WITH rows — the parse is what failed', async () => {
    // The table arrives; the corner columns are just not the ones we look for.
    const c = new Reporting({
      ...tables,
      'Area Object Connectivity': [
        { Story: 'L2', UniqueName: 'F1', NumPoints: '4', Joint1: 'P1', Joint2: 'P2', Joint3: 'P3', Joint4: 'P4' },
      ],
    });
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(0);   // nothing parsed
    const p = areaProbe(c.tableProbes());
    expect(p!.ret).toBe(0);
    expect(p!.rows).toBe(1);                        // but a row DID arrive
    expect(p!.fields).toContain('Joint1');          // and here is what it was called
  });

  it('a successful read reports ret 0, rows, and the fields it used', async () => {
    const c = new Reporting({
      ...tables,
      'Area Object Connectivity': [{
        Story: 'L2', UniqueName: 'F1', NumberPoints: '4',
        UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4',
      }],
    });
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(1);
    const p = areaProbe(c.tableProbes());
    expect(p!.ret).toBe(0);
    expect(p!.rows).toBe(1);
  });

  it('columns importing while areas do not is itself evidence', async () => {
    // Exactly the reported symptom: the joint map and the transport are fine, so the
    // area table is the only thing left to explain.
    const c = new Reporting({
      ...tables,
      'Column Object Connectivity': [
        { Story: 'L2', UniqueName: 'C1', UniquePtI: 'P1', UniquePtJ: 'P2' },
      ],
    }, ['Area Object Connectivity']);
    await c.connect();
    expect(await c.getColumns({})).toHaveLength(1);
    expect(await c.getAreas({})).toHaveLength(0);
    expect(areaProbe(c.tableProbes())!.ret).not.toBe(0);
  });
});

describe('the per-type tables a real ETABS actually publishes', () => {
  // A live model answered `Area Object Connectivity` with ret -96 (key refused) while
  // reporting 3857 rows of `Area Assignments - Section Properties` — the areas were
  // there, only the geometry key was wrong. ETABS splits them the way it splits frames.
  const WALL_POINTS: TableRow[] = [
    { UniqueName: 'W1', X: '0', Y: '0', Z: '0' },
    { UniqueName: 'W2', X: '20', Y: '0', Z: '0' },
    { UniqueName: 'W3', X: '20', Y: '0', Z: '12' },
    { UniqueName: 'W4', X: '0', Y: '0', Z: '12' },
  ];

  it('reads Floor Object Connectivity as slabs and Wall Object Connectivity as walls', async () => {
    const c = new Fake({
      'Beam Object Connectivity': BEAMS,
      'Point Object Connectivity': [...POINTS, ...WALL_POINTS],
      'Frame Assignments - Section Properties': [{ UniqueName: 'B1', SectProp: 'B24X16' }],
      'Floor Object Connectivity': [{
        Story: 'L2', UniqueName: 'F1', NumPoints: '4',
        UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4',
      }],
      'Wall Object Connectivity': [{
        Story: 'L2', UniqueName: 'W-A', NumPoints: '4',
        UniquePt1: 'W1', UniquePt2: 'W2', UniquePt3: 'W3', UniquePt4: 'W4',
      }],
    });
    await c.connect();
    const areas = await c.getAreas({});
    expect(areas).toHaveLength(2);
    expect(areas.find(a => a.name === 'F1')!.kind).toBe('slab');
    expect(areas.find(a => a.name === 'W-A')!.kind).toBe('wall');
  });

  it('takes kind from the TABLE, not the geometry — a flat wall panel stays a wall', async () => {
    // Plane-normal inference would call this a slab; the table says otherwise.
    const c = new Fake({
      'Beam Object Connectivity': BEAMS,
      'Point Object Connectivity': POINTS,
      'Frame Assignments - Section Properties': [{ UniqueName: 'B1', SectProp: 'B24X16' }],
      'Wall Object Connectivity': [{
        Story: 'L2', UniqueName: 'W-flat', NumPoints: '4',
        UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4',
      }],
    });
    await c.connect();
    expect((await c.getAreas({}))[0].kind).toBe('wall');
  });

  it('still reads a generic Area Object Connectivity where a build has one', async () => {
    const c = base({
      'Area Object Connectivity': [{
        Story: 'L2', UniqueName: 'F1', NumberPoints: '4',
        UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4',
        DesignOrientation: 'Floor',
      }],
    });
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(1);
  });

  it('a refused generic key no longer costs the layer — the per-type tables carry it', async () => {
    // Exactly the reported model: generic key refused, per-type tables present.
    const c = new Reporting({
      'Beam Object Connectivity': BEAMS,
      'Point Object Connectivity': POINTS,
      'Frame Assignments - Section Properties': [{ UniqueName: 'B1', SectProp: 'B24X16' }],
      'Floor Object Connectivity': [{
        Story: 'L2', UniqueName: 'F1', NumPoints: '4',
        UniquePt1: 'P1', UniquePt2: 'P2', UniquePt3: 'P3', UniquePt4: 'P4',
      }],
    }, ['Area Object Connectivity']);
    await c.connect();
    expect(await c.getAreas({})).toHaveLength(1);
    // The refusal is still recorded, so the probe stays honest about what was tried.
    expect(c.tableProbes().find(p => p.key === 'Area Object Connectivity')!.ret).not.toBe(0);
  });
});
