/**
 * MockConnection — a deterministic in-memory ETABS model used for the demo
 * mode of the import wizard and for unit tests. One tower, two stories,
 * a 4×3 column grid of beams in two section sizes.
 */
import type { ComboForces } from '../../types';
import type {
  EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo,
  EtabsBeamGeom, BeamFilter,
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

  async getStories(): Promise<string[]> {
    return [...STORIES];
  }

  async getGroups(): Promise<string[]> {
    return ['Girders', 'Infill', 'L2-Beams', 'L3-Beams'];
  }

  async getFrameSections(): Promise<EtabsSectionInfo[]> {
    return [
      { name: 'B12X24', material: '4000Psi', shape: 'Rectangular', depth: 24, width: 12 },
      { name: 'B14X28', material: '5000Psi', shape: 'Rectangular', depth: 28, width: 14 },
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

  async getStationForces(frameNames: string[], combos: string[]): Promise<Record<string, ComboForces[]>> {
    const out: Record<string, ComboForces[]> = {};
    for (const name of frameNames) {
      const beam = BEAMS.find(b => b.name === name);
      if (!beam) continue;
      out[name] = combos.map(c => forcePattern(beam, c));
    }
    return out;
  }
}
