/**
 * The built-in demo model — a two-storey concrete frame the app can open with no
 * ETABS, no licence and no file.
 *
 * ── WHY IT IS BUILT AND NOT WRITTEN OUT ──────────────────────────────────────────
 *
 * The welcome screen has offered "Explore the demo model — built-in 2-storey frame"
 * from the start, and it landed on `defaultProject`: two hand-authored beams, no
 * model map, no design groups. So the Model panel opened on "0 frames" and the
 * Groups panel on "2 ungrouped" — the two panels the demo exists to show.
 *
 * The frame itself was already in the repo: `MockConnection` is a full 4x3 bay,
 * two-storey tower with columns, slabs, a core wall, grid lines and deterministic
 * station forces. It was only reachable by walking into the ETABS import wizard and
 * picking the demo source — the one thing someone who has no ETABS is least likely
 * to try.
 *
 * This module drives that same connection down the same path the wizard takes —
 * getBeams -> getStationForces -> buildMembers -> autoGroup, plus the column / wall /
 * grid / opening layers — so the demo is not a second, hand-maintained copy of an
 * import. Change the adapters and the demo changes with them; if the wizard breaks,
 * this breaks too, and the test below says so.
 *
 * Everything upstream is deterministic (see mock.ts), so the demo model is identical
 * on every machine and every run. `date` and `importedAt` are the only clock reads.
 */

import { autoGroup, buildMembers } from '../adapters/etabs';
import { MockConnection } from '../adapters/etabs/mock';
import type { SeedOptions } from '../adapters/etabs/rebarSeed';
import type { MapFrame, ModelMap, Project } from '../types';
import { defaultSettings } from './projectSettings';

/**
 * Starting reinforcement for every demo beam.
 *
 * These are the import wizard's own defaults, deliberately — the demo should open on
 * the cage a real import opens on, not on a tuned one. It is a starting cage and not
 * a design: roughly half the frame passes as seeded and the rest does not, which is
 * the honest state of a model the moment it lands and the reason Suggest exists.
 */
const DEMO_SEED: SeedOptions = {
  rhoTopPct: 0.4,
  rhoBotPct: 0.6,
  stirrupSpacings: [4, 8, 4],
  stirrupBarSize: 4,
  stirrupLegs: 2,
  imposeSkinReinf: true,
  skinBarSize: 5,
};

/**
 * Build the demo project. Async because `EtabsConnection` is — nothing here does
 * I/O, so it settles in a microtask.
 */
export async function buildDemoProject(): Promise<Project> {
  const conn = new MockConnection();
  const info = await conn.connect();

  const [sections, materials, combos] = await Promise.all([
    conn.getFrameSections(),
    conn.getMaterials(),
    conn.getCombos(),
  ]);

  // No filter: the demo is the whole frame. Filtering is what the wizard is for.
  const beams = await conn.getBeams({});
  const forces = await conn.getStationForces(beams.map(b => b.name), combos);
  const members = buildMembers(beams, sections, materials, forces, DEMO_SEED, 'ACI318-19');
  // Mutates each member's `etabs.designGroupId`, so it must run before the map is
  // built off those members.
  const designGroups = autoGroup(members);

  const [columns, areas, grids, openings] = await Promise.all([
    conn.getColumns({}),
    conn.getAreas({}),
    conn.getGrids(),
    conn.getOpenings({}),
  ]);

  const idByFrame = new Map(members.map(m => [m.etabs?.frameName, m.id]));
  const frames: MapFrame[] = beams.map(b => ({
    frameName: b.name,
    story: b.story,
    sectionName: b.section,
    pt1: b.pt1,
    pt2: b.pt2,
    memberId: idByFrame.get(b.name),
  }));

  const modelMap: ModelMap = {
    source: 'mock',
    modelName: info.modelName,
    importedAt: new Date().toISOString(),
    stories: [...new Set([
      ...beams.map(b => b.story), ...columns.map(c => c.story),
      ...areas.map(a => a.story), ...openings.map(o => o.story),
    ])].sort(),
    frames,
    walls: areas.map(a => ({
      id: a.name, story: a.story, points: a.points, kind: a.kind,
      sectionName: a.section || undefined,
    })),
    grids: grids.map(g => ({ id: g.id, label: g.label, p1: g.p1, p2: g.p2 })),
    openings: openings.map(o => ({ id: o.name, story: o.story, points: o.points })),
    columns: columns.map(c => ({
      id: c.name, story: c.story, sectionName: c.section || undefined,
      pt1: c.pt1, pt2: c.pt2,
    })),
  };

  return {
    id: 'demo-frame-2storey',
    name: 'Sample Tower (demo model)',
    code: 'ACI318-19',
    description: 'Built-in two-storey demo frame — 4 x 3 bays, girders and infill beams',
    engineer: '',
    date: new Date().toLocaleDateString(),
    settings: defaultSettings('ACI318-19'),
    members,
    designGroups,
    modelMap,
  };
}
