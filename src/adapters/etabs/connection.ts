/**
 * EtabsConnection — transport-agnostic interface for pulling beam data out of
 * an ETABS model. Three implementations:
 *
 *   ComConnection  — live CSI OAPI via the Electron main process (Windows,
 *                    ETABS running). See comClient.ts + electron/etabsBridge.cjs.
 *   FileConnection — exported ETABS tables workbook (.xlsx). Works anywhere.
 *   MockConnection — built-in sample model for demos and tests.
 *
 * The import wizard talks only to this interface, so all three sources share
 * the exact same UI flow.
 */
import type { ComboForces, Point3D } from '../../types';

export interface EtabsConnectInfo {
  modelName: string;
  units: string; // display only, e.g. "kip-ft"
}

/** The active unit interpretation a connection reads raw ETABS values under.
 *  Surfaced to the import wizard so the user can see — and correct — it. */
export interface UnitInfo {
  forceKey: string;    // 'kip', 'kn', … (drives forces V/P)
  lengthKey: string;   // 'ft', 'm', …  (drives sizes b/h/span)
  label: string;       // 'kip-ft'
  assumed: boolean;    // true = auto-detection failed; using a fallback default
  stressUnit: string;  // effective material unit ('mpa' override, or 'kip/ft²' derived)
}

/** Result of pushing one design group back to ETABS as a named group. */
export interface PushGroupResult {
  groupName: string;
  assigned: number;   // frames successfully assigned
  total: number;      // frames requested
  failures?: string[];
}

export interface EtabsSectionInfo {
  name: string;
  material: string;
  shape: 'Rectangular' | 'T' | 'L' | 'Circle';
  depth: number;  // t3 (in)
  width: number;  // t2 (in)
}

export interface EtabsMaterialInfo {
  name: string;
  fc?: number; // psi
  fy?: number; // psi
}

export interface EtabsBeamGeom {
  name: string;       // unique frame name
  story: string;
  section: string;    // frame property name
  pt1: Point3D;       // ft
  pt2: Point3D;       // ft
  groups: string[];
  lengthFt: number;
}

/** A wall/slab area object — a planar polygon of corner nodes. */
/** A vertical frame (column/brace) — the same geometry shape as a beam, but
 *  (near-)vertical: pt1 = base node, pt2 = top node. Geometry only: this app
 *  does not design columns, it just draws them for context. */
export interface EtabsColumnGeom {
  name: string;
  story: string;
  section: string;
  pt1: Point3D;
  pt2: Point3D;
}

export interface EtabsAreaGeom {
  name: string;
  story: string;
  points: Point3D[];  // ordered corner ring (ft), ≥ 3
  kind: 'wall' | 'slab';
  section: string;    // area section property name ('' if none)
  groups: string[];
}

/** A grid line — two endpoints spanning the plan, plus a label. */
export interface EtabsGridGeom {
  id: string;
  label: string;
  p1: Point3D;        // ft
  p2: Point3D;        // ft
}

/** An opening (penetration) in a wall or slab — a planar polygon. */
export interface EtabsOpeningGeom {
  name: string;
  story: string;
  points: Point3D[];  // ordered corner ring (ft), ≥ 3
}

export interface BeamFilter {
  stories?: string[];   // empty/undefined = all
  sections?: string[];
  groups?: string[];    // beam must belong to at least one
}

export interface EtabsConnection {
  readonly kind: 'com' | 'file' | 'mock' | 'bridge';
  connect(): Promise<EtabsConnectInfo>;
  /** Re-interpret raw ETABS values under an explicit force+length system,
   *  overriding auto-detection (optional — sources with fixed units omit it). */
  setUnitSystem?(forceKey: string, lengthKey: string): void;
  /** Pin the material-strength unit (f'c / fy), or null to derive it from the
   *  force/length system (optional). */
  setStressUnit?(unitKey: string | null): void;
  /** Choose which force table to import: 'design' (Design Forces) or 'element'
   *  (raw per-combo analysis forces, matching ETABS's frame-force display). */
  setForceSource?(pref: 'design' | 'element'): void;
  /** The active unit interpretation, for the wizard to display/seed selectors
   *  (optional — sources that report units another way omit it). */
  getUnitInfo?(): UnitInfo;
  getStories(): Promise<string[]>;
  getGroups(): Promise<string[]>;
  getFrameSections(): Promise<EtabsSectionInfo[]>;
  getMaterials(): Promise<EtabsMaterialInfo[]>;
  getCombos(): Promise<string[]>;
  getBeams(filter: BeamFilter): Promise<EtabsBeamGeom[]>;
  /** Wall/slab area objects (optional — sources without an area table omit it).
   *  Shown as filterable map layers. */
  getAreas?(filter: BeamFilter): Promise<EtabsAreaGeom[]>;
  /** Vertical frames for the 3D view (optional — sources without a column table
   *  omit it). Geometry only; nothing downstream designs these. */
  getColumns?(filter: BeamFilter): Promise<EtabsColumnGeom[]>;
  /** Grid lines (optional). Grid axes are model-global, so no filter arg. */
  getGrids?(): Promise<EtabsGridGeom[]>;
  /** Opening area objects (optional — penetrations in walls/slabs). */
  getOpenings?(filter: BeamFilter): Promise<EtabsOpeningGeom[]>;
  /** Station forces per frame for the selected combos. Key = frame name. */
  getStationForces(frameNames: string[], combos: string[], sourceGroup?: string): Promise<Record<string, ComboForces[]>>;
  /** Push design groups back to the ETABS model: create each named group and
   *  assign its member frames. Only the live COM connection supports this
   *  (optional — file/mock sources omit it). */
  pushGroups?(groups: Array<{ name: string; frameNames: string[] }>): Promise<PushGroupResult[]>;
}

/** Filter predicate for beams (story/section/groups). */
export function matchesFilter(beam: { story: string; section: string; groups: string[] }, filter: BeamFilter): boolean {
  // Story is a hard scope — AND.
  if (filter.stories?.length && !filter.stories.includes(beam.story)) return false;

  // Sections + groups are additive (union). If either selector is active, the
  // beam must match at least one of them. If neither is active, all beams pass.
  const hasSecFilter = !!filter.sections?.length;
  const hasGrpFilter = !!filter.groups?.length;
  if (hasSecFilter || hasGrpFilter) {
    const matchesSec = hasSecFilter && filter.sections!.includes(beam.section);
    const matchesGrp = hasGrpFilter && beam.groups.some(g => filter.groups!.includes(g));
    if (!matchesSec && !matchesGrp) return false;
  }

  return true;
}
