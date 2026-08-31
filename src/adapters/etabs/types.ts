/**
 * ETABS model data types — mirrors the JSON format produced by the
 * ETABS OAPI (Open Application Programming Interface) or a custom
 * JSON export script.
 *
 * Reference: ETABS 2016+ OAPI documentation, CSi API Reference Manual.
 *
 * To implement the ETABS adapter:
 *  1. Fill in any missing fields below as needed.
 *  2. Create src/adapters/etabs/index.ts implementing ModelAdapter.
 *  3. Map EtabsFrame → BeamMember / ColumnMember based on FrameType.
 *  4. Map EtabsLoadCombination + EtabsFrameForces → BeamLoadCase / ColumnLoadCase.
 *  5. Register the adapter in src/adapters/index.ts.
 */

// ── Top-level model container ─────────────────────────────────────────────────

/** A whole ETABS model as JSON. `frameForces` is absent until the model has been run. */
export interface EtabsModel {
  projectInfo: EtabsProjectInfo;
  materials: EtabsMaterial[];
  frameSections: EtabsFrameSection[];
  frames: EtabsFrame[];
  loadPatterns: EtabsLoadPattern[];
  loadCombinations: EtabsLoadCombination[];
  frameForces?: EtabsFrameForces[];  // populated after analysis
}

// ── Project metadata ──────────────────────────────────────────────────────────

/** Title-block metadata. Only `projectName` and `code` are relied on. */
export interface EtabsProjectInfo {
  projectName: string;
  clientName?: string;
  engineer?: string;
  revisionNumber?: string;
  code: string;   // e.g. "ACI 318-19"
}

// ── Materials ─────────────────────────────────────────────────────────────────

export type EtabsMaterialType = 'Concrete' | 'Rebar' | 'Steel';

/** A material definition. Which strength field is meaningful depends on `type` —
 *  `fc` for Concrete, `fy` for Rebar — and either may be missing. */
export interface EtabsMaterial {
  name: string;
  type: EtabsMaterialType;
  fc?: number;          // psi — concrete
  fy?: number;          // psi — rebar
  Es?: number;          // psi — modulus
  weightPerVolume?: number;
}

// ── Frame sections ────────────────────────────────────────────────────────────

export type EtabsSectionShape =
  | 'Rectangular'   // beams and columns
  | 'Circle'        // circular columns
  | 'T'             // T-beams
  | 'L';            // L-beams

/** A section property. Which dimension fields are populated depends on `shape`, so read
 *  them through the shape rather than assuming t3/t2 are always there. */
export interface EtabsFrameSection {
  name: string;
  material: string;     // references EtabsMaterial.name
  shape: EtabsSectionShape;
  // Rectangular / T / L
  t3?: number;          // depth (in)
  t2?: number;          // width (in)
  tf?: number;          // flange thickness (in)
  bf?: number;          // flange width (in)
  // Circle
  diameter?: number;    // (in)
  // Reinforcement (optional — may come from a separate rebar assignment)
  coverClear?: number;
  stirrupSize?: number;
}

// ── Frames (line elements) ────────────────────────────────────────────────────

export type EtabsFrameType = 'Beam' | 'Column' | 'Brace';

/** A line element. `type` decides whether it becomes a designed member or map-only
 *  geometry — this app designs Beams and draws Columns/Braces for context. */
export interface EtabsFrame {
  name: string;
  type: EtabsFrameType;
  section: string;      // references EtabsFrameSection.name
  material: string;     // references EtabsMaterial.name
  story: string;        // floor level label
  point1: string;       // joint name
  point2: string;       // joint name
  lengthFt?: number;    // derived from joint coordinates
}

// ── Loading ───────────────────────────────────────────────────────────────────

export type EtabsLoadPatternType = 'Dead' | 'Live' | 'Wind' | 'Seismic' | 'Snow' | 'Other';

/** A base load pattern (Dead, Live, …) before combination. */
export interface EtabsLoadPattern {
  name: string;
  type: EtabsLoadPatternType;
  selfWeightMultiplier: number;
}

/** A design combination. `Envelope` combos already carry min/max at each station, so
 *  they must not be re-enveloped downstream. */
export interface EtabsLoadCombination {
  name: string;
  type: 'LinearAdd' | 'Envelope';
  cases: Array<{ caseName: string; scaleFactor: number }>;
}

// ── Analysis results ──────────────────────────────────────────────────────────

/** Frame forces at a station along the member length. */
export interface EtabsFrameForces {
  frameName: string;
  loadCombo: string;    // references EtabsLoadCombination.name
  station: number;      // distance from start joint (in)
  /** Axial force (kips) AS ETABS REPORTS IT — compression NEGATIVE. The table
   *  connection flips it when building `StationForce`, because the app's own
   *  `LoadCase.Pu` is compression-POSITIVE. */
  P: number;
  V2: number;           // Shear in local 2-direction (kips)
  V3: number;           // Shear in local 3-direction (kips)
  T: number;            // Torsion (kip-in)
  M2: number;           // Moment about local 2-axis (kip-ft)
  M3: number;           // Moment about local 3-axis (kip-ft)
}
