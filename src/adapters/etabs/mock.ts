/**
 * MockConnection — a deterministic in-memory ETABS model used for the demo
 * mode of the import wizard and for unit tests. One tower, two stories,
 * a 4×3 column grid of beams in two section sizes.
 */
import type { ComboForces } from '../../types';
import type {
  EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo,
  EtabsBeamGeom, EtabsColumnGeom, ColumnComboForce, BeamFilter, UnitInfo,
  EtabsAreaGeom, EtabsGridGeom, EtabsOpeningGeom,
} from './connection';
import { matchesFilter } from './connection';

const GRID_X = [0, 24, 48, 72];   // ft
const GRID_Y = [0, 28, 56];       // ft
const STORIES = ['Level 2', 'Level 3'];
const STORY_Z: Record<string, number> = { 'Level 2': 12, 'Level 3': 24 };

function buildBeams(): EtabsBeamGeom[] {
  const beams: EtabsBeamGeom[] = [];
  let n = 1;
  for (const story of STORIES) {
    const z = STORY_Z[story];
    // X-direction beams (girders, deeper section)
    for (const y of GRID_Y) {
      for (let i = 0; i < GRID_X.length - 1; i++) {
        beams.push({
          name: `B${n++}`,
          story,
          section: 'B14X28',
          pt1: { x: GRID_X[i], y, z },
          pt2: { x: GRID_X[i + 1], y, z },
          groups: ['Girders', story === 'Level 2' ? 'L2-Beams' : 'L3-Beams'],
          lengthFt: GRID_X[i + 1] - GRID_X[i],
        });
      }
    }
    // Y-direction beams (infill, shallower)
    for (const x of GRID_X) {
      for (let j = 0; j < GRID_Y.length - 1; j++) {
        beams.push({
          name: `B${n++}`,
          story,
          section: 'B12X24',
          pt1: { x, y: GRID_Y[j], z },
          pt2: { x, y: GRID_Y[j + 1], z },
          groups: ['Infill', story === 'Level 2' ? 'L2-Beams' : 'L3-Beams'],
          lengthFt: GRID_Y[j + 1] - GRID_Y[j],
        });
      }
    }
  }
  return beams;
}

const BEAMS = buildBeams();

/** Columns at every grid intersection, rising through each story. */
function buildColumns(): EtabsColumnGeom[] {
  const cols: EtabsColumnGeom[] = [];
  let n = 1;
  for (const story of STORIES) {
    const zTop = STORY_Z[story];
    const zBase = zTop - 12; // 12-ft storey height
    for (const x of GRID_X) {
      for (const y of GRID_Y) {
        cols.push({
          name: `C${n++}`,
          story,
          section: 'C18X18',
          pt1: { x, y, z: zBase },
          pt2: { x, y, z: zTop },
          groups: ['Columns', story === 'Level 2' ? 'L2-Cols' : 'L3-Cols'],
          heightFt: 12,
        });
      }
    }
  }
  return cols;
}

const COLUMNS = buildColumns();

const GRID_LABELS_X = ['A', 'B', 'C', 'D'];
const GRID_LABELS_Y = ['1', '2', '3'];

/** Grid lines spanning the plan — one per column line, both directions. */
function buildGrids(): EtabsGridGeom[] {
  const grids: EtabsGridGeom[] = [];
  GRID_X.forEach((x, i) => grids.push({
    id: `GX${i}`, label: GRID_LABELS_X[i] ?? `X${i}`,
    p1: { x, y: GRID_Y[0], z: 0 }, p2: { x, y: GRID_Y[GRID_Y.length - 1], z: 0 },
  }));
  GRID_Y.forEach((y, j) => grids.push({
    id: `GY${j}`, label: GRID_LABELS_Y[j] ?? `Y${j}`,
    p1: { x: GRID_X[0], y, z: 0 }, p2: { x: GRID_X[GRID_X.length - 1], y, z: 0 },
  }));
  return grids;
}
const GRIDS = buildGrids();

/** Per-story floor slab + two perimeter shear walls (thin plan footprints). */
function buildAreas(): EtabsAreaGeom[] {
  const x0 = GRID_X[0], x1 = GRID_X[GRID_X.length - 1];
  const y0 = GRID_Y[0], y1 = GRID_Y[GRID_Y.length - 1];
  const areas: EtabsAreaGeom[] = [];
  let n = 1;
  for (const story of STORIES) {
    const z = STORY_Z[story];
    // Floor slab — full-footprint rectangle.
    areas.push({
      name: `F${n++}`, story, kind: 'slab', section: 'Slab8', groups: ['Slabs'],
      points: [{ x: x0, y: y0, z }, { x: x1, y: y0, z }, { x: x1, y: y1, z }, { x: x0, y: y1, z }],
    });
    // Perimeter shear walls along grid lines A and D — thin plan footprints.
    for (const gx of [x0, x1]) {
      areas.push({
        name: `W${n++}`, story, kind: 'wall', section: 'W300', groups: ['Walls'],
        points: [{ x: gx - 0.5, y: y0, z }, { x: gx + 0.5, y: y0, z }, { x: gx + 0.5, y: y1, z }, { x: gx - 0.5, y: y1, z }],
      });
    }
  }
  return areas;
}
const AREAS = buildAreas();

/** One rectangular opening (stair/shaft) cut into each floor slab. */
function buildOpenings(): EtabsOpeningGeom[] {
  const openings: EtabsOpeningGeom[] = [];
  let n = 1;
  for (const story of STORIES) {
    const z = STORY_Z[story];
    openings.push({
      name: `O${n++}`, story,
      points: [{ x: 24, y: 28, z }, { x: 36, y: 28, z }, { x: 36, y: 44, z }, { x: 24, y: 44, z }],
    });
  }
  return openings;
}
const OPENINGS = buildOpenings();

/**
 * Simply-supported-with-end-restraint force pattern: linear shear,
 * parabolic moment with hogging at the ends. Magnitude scales with span
 * and combo so colors vary on the plan map.
 */
function forcePattern(beam: EtabsBeamGeom, combo: string, nStations = 9): ComboForces {
  const L = beam.lengthFt;
  const comboScale = combo.includes('E') ? 1.25 : 1.0;
  // heavier girders, plus a deterministic per-beam variation
  const seed = beam.name.split('').reduce((s, ch) => s + ch.charCodeAt(0), 0);
  const w = (beam.section === 'B14X28' ? 3.2 : 1.9) * comboScale * (0.8 + (seed % 7) / 10); // kips/ft
  const Mend = w * L * L / 12;  // hogging at supports
  const stations = Array.from({ length: nStations }, (_, i) => {
    const x = (i / (nStations - 1)) * L;
    const V = w * (L / 2 - x);
    const M = -Mend + (w * L / 2) * x - (w / 2) * x * x;
    return { x: +x.toFixed(2), V: +V.toFixed(2), M: +M.toFixed(2) };
  });
  return { combo, stations };
}

export class MockConnection implements EtabsConnection {
  readonly kind = 'mock' as const;

  async connect(): Promise<EtabsConnectInfo> {
    return { modelName: 'Sample Tower (demo model)', units: 'kip-ft' };
  }

  // The demo model's forces/sizes are authored directly in the app's internal
  // units, so there's nothing to re-interpret — reported read-only for the wizard.
  getUnitInfo(): UnitInfo {
    return { forceKey: 'kip', lengthKey: 'ft', label: 'kip-ft', assumed: false, stressUnit: 'psi' };
  }

  async getStories(): Promise<string[]> {
    return [...STORIES];
  }

  async getGroups(): Promise<string[]> {
    return ['Girders', 'Infill', 'L2-Beams', 'L3-Beams', 'Columns', 'L2-Cols', 'L3-Cols'];
  }

  async getFrameSections(): Promise<EtabsSectionInfo[]> {
    return [
      { name: 'B12X24', material: '4000Psi', shape: 'Rectangular', depth: 24, width: 12 },
      { name: 'B14X28', material: '5000Psi', shape: 'Rectangular', depth: 28, width: 14 },
      { name: 'C18X18', material: '5000Psi', shape: 'Rectangular', depth: 18, width: 18 },
    ];
  }

  async getMaterials(): Promise<EtabsMaterialInfo[]> {
    return [
      { name: '4000Psi', fc: 4000 },
      { name: '5000Psi', fc: 5000 },
      { name: 'A615Gr60', fy: 60000 },
    ];
  }

  async getCombos(): Promise<string[]> {
    return ['1.2D+1.6L', '1.2D+1.0L+1.0E', '0.9D+1.0E'];
  }

  async getBeams(filter: BeamFilter): Promise<EtabsBeamGeom[]> {
    return BEAMS.filter(b => matchesFilter(b, filter));
  }

  async getColumns(filter: BeamFilter): Promise<EtabsColumnGeom[]> {
    return COLUMNS.filter(c => matchesFilter(c, filter));
  }

  async getAreas(filter: BeamFilter): Promise<EtabsAreaGeom[]> {
    return AREAS.filter(a => matchesFilter(a, filter));
  }

  async getGrids(): Promise<EtabsGridGeom[]> {
    return [...GRIDS];
  }

  async getOpenings(filter: BeamFilter): Promise<EtabsOpeningGeom[]> {
    // Openings carry only a story — scope by it (no section/group filter).
    return OPENINGS.filter(o => !filter.stories?.length || filter.stories.includes(o.story));
  }

  async getStationForces(frameNames: string[], combos: string[]): Promise<Record<string, ComboForces[]>> {
    const out: Record<string, ComboForces[]> = {};
    for (const name of frameNames) {
      const beam = BEAMS.find(b => b.name === name);
      if (!beam) continue;
      out[name] = combos.map(c => forcePattern(beam, c));
    }
    return out;
  }

  async getColumnForces(frameNames: string[], combos: string[]): Promise<Record<string, ColumnComboForce[]>> {
    // Deterministic demo forces: lower stories carry more axial. Compression is
    // NEGATIVE (ETABS convention) so the app maps Pu = −P > 0.
    const out: Record<string, ColumnComboForce[]> = {};
    for (const name of frameNames) {
      const col = COLUMNS.find(c => c.name === name);
      if (!col) continue;
      const lower = col.story === STORIES[0];
      out[name] = combos.map((combo, i) => ({
        combo,
        P: -(lower ? 780 : 420) - i * 30,
        V2: 18 + i * 2, V3: 12 + i,
        M2: 55 + i * 4, M3: 70 + i * 5,
        T: 3,
      }));
    }
    return out;
  }
}
