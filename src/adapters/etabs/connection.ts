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

/** What a successful `connect()` reports back to the wizard. */
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

/** A frame section property from the model. `depth`/`width` are ETABS t3/t2, already
 *  converted to inches by the connection. */
export interface EtabsSectionInfo {
  name: string;
  material: string;
  shape: 'Rectangular' | 'T' | 'L' | 'Circle';
  depth: number;  // t3 (in)
  width: number;  // t2 (in)
}

/** A concrete material from the model. Strengths are optional — ETABS models routinely
 *  carry materials with no usable f'c/fy, and the import falls back to project defaults. */
export interface EtabsMaterialInfo {
  name: string;
  fc?: number; // psi
  fy?: number; // psi
}

/** One horizontal frame (beam) with the geometry the map and the design need. */
export interface EtabsBeamGeom {
  name: string;       // unique frame name
  story: string;
  section: string;    // frame property name
  pt1: Point3D;       // ft
  pt2: Point3D;       // ft
  groups: string[];
  lengthFt: number;
}

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

/** A wall/slab area object — a planar polygon of corner nodes. */
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

/** Import scope. Note the asymmetry, spelled out in `matchesFilter`: story and material
 *  are ANDs (hard scopes), while sections and groups are OR'd together (additive
 *  selectors). */
export interface BeamFilter {
  stories?: string[];   // empty/undefined = all
  sections?: string[];
  groups?: string[];    // beam must belong to at least one
  /**
   * Frame-property materials to keep. Empty/undefined = all.
   *
   * A HARD scope, deliberately not a third additive selector. The question it answers is
   * "do not import the steel beams", and an OR'd material filter could not answer it: a
   * steel beam sitting in a selected ETABS group would match on the group and come in
   * anyway, which is the one outcome the filter exists to prevent.
   */
  materials?: string[];
  /**
   * section name → material name, supplied by the caller.
   *
   * The beam geometry ETABS returns names its frame PROPERTY, not the material that
   * property is made of — the material lives one table over, on the section. Rather than
   * teach every connection to join those two tables, the side that already holds both
   * (the import wizard, which lists sections for the picker) passes the mapping down.
   * A section missing from the map has an unknown material and is KEPT: the filter can
   * exclude what it can identify, and silently dropping frames it cannot is worse than
   * importing one beam too many.
   */
  sectionMaterials?: Record<string, string>;
}

/**
 * The interface every import source implements.
 *
 * Required members are the ones a source cannot be useful without. Everything OPTIONAL
 * is a capability the wizard has to feature-detect before offering — the unit overrides,
 * the extra geometry layers, and the whole write half, none of which a file or mock
 * source can provide. Check for the method, don't assume it.
 */
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

  // ── diagnostics ───────────────────────────────────────────────────────────
  // A wrong table key and an empty model look identical from here: ETABS answers a key
  // it does not recognise with a non-zero code and no rows, and every optional layer
  // catches its own failure so the import never breaks. These two put the difference
  // back on screen.

  /** Every display table THIS ETABS build offers, with the exact key it wants.
   *  Live COM only — a file or mock source has no catalogue to report. */
  listTables?(): Promise<EtabsTableInfo[]>;
  /** What came back for each table this connection asked for, in the order asked. */
  tableProbes?(): TableProbe[];
  /** Station forces per frame for the selected combos. Key = frame name. */
  getStationForces(frameNames: string[], combos: string[], sourceGroup?: string): Promise<Record<string, ComboForces[]>>;
  /** Push design groups back to the ETABS model: create each named group and
   *  assign its member frames. Only the live COM connection supports this
   *  (optional — file/mock sources omit it). */
  pushGroups?(groups: Array<{ name: string; frameNames: string[] }>): Promise<PushGroupResult[]>;

  // ── the write half: resized sections back into the model ──────────────────
  // Optional, and absent on every read-only transport (file import, mock), so a caller
  // has to ask whether it can write before offering the button — `canPushSections`.
  // Dimensions are in the MODEL's present units; `buildSectionPushPlan` converts.
  /** PropFrame.SetRectangle per property, creating the material when it is missing. */
  defineFrameSections?(sections: Array<{
    name: string; matProp: string; fc?: number; depth: number; width: number;
  }>): Promise<{ defined: number; failures?: string[] }>;
  /** FrameObj.SetSection — move frames onto a defined property. */
  assignSections?(assignments: Array<{ name: string; frameNames: string[] }>):
    Promise<{ assigned: number; total: number; failures?: string[] }>;
  /** PropFrame.SetRebarBeam — carry the designed cage into the model (optional). */
  setRebarBeam?(beams: Array<{
    name: string; matLong: string; matConfine: string;
    coverTop: number; coverBot: number;
    topLeftArea: number; topRightArea: number; botLeftArea: number; botRightArea: number;
  }>): Promise<{ set: number; failures?: string[] }>;
  /** File.Save under a new path, leaving the original model on disk untouched. */
  saveModelAs?(path: string): Promise<{ path: string }>;
  /** Analyze.RunAnalysis — the model must be saved first. */
  runAnalysis?(): Promise<{ ran: boolean }>;
}

/** Filter predicate for beams (story/material/section/groups). */
export function matchesFilter(beam: { story: string; section: string; groups: string[] }, filter: BeamFilter): boolean {
  // Story is a hard scope — AND.
  if (filter.stories?.length && !filter.stories.includes(beam.story)) return false;

  // Material is the second hard scope. Resolved through the section, and case- and
  // whitespace-insensitive because the two ETABS tables that carry these names do not
  // always agree on either.
  if (filter.materials?.length) {
    const norm = (v: string) => v.trim().toLowerCase();
    const mat = filter.sectionMaterials?.[beam.section];
    // Unknown material ⇒ keep. See `sectionMaterials`.
    if (mat && !filter.materials.some(m => norm(m) === norm(mat))) return false;
  }

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

/** One entry from ETABS's own table catalogue (`GetAvailableTables`). */
export interface EtabsTableInfo {
  /** The key `getTable` must be given, verbatim. */
  key: string;
  /** The display name ETABS shows a user. */
  name: string;
  /** ETABS's import-type code; reported as given. */
  importType: number;
}

/** The outcome of one table read — the record that tells a wrong key from an empty one. */
export interface TableProbe {
  key: string;
  /** ETABS's return code: 0 = table delivered. Non-zero = it refused the key. */
  ret: number | null;
  /** Rows returned. Zero with ret === 0 means the model genuinely has none. */
  rows: number;
  /** Column names as ETABS spelled them — the other half of a silent mismatch. */
  fields: string[];
  /** Set when the read threw rather than returning a code. */
  error?: string;
}
