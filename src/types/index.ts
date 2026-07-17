export type SectionType = 'rectangular_beam' | 'T_beam' | 'L_beam' | 'rectangular_column' | 'circular_column';
export type DesignCode = 'ACI318-19' | 'ACI318-14' | 'EN1992-1-1';
export type MemberType = 'beam' | 'column';
export type ExposureClass = 'W0' | 'W1' | 'W2' | 'S0' | 'S1' | 'S2' | 'S3';

export interface DesignWarning {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface MaterialProps {
  fc: number;       // Concrete compressive strength (psi)
  fy: number;       // Steel yield strength (psi)
  fyt: number;      // Transverse steel yield strength (psi)
  Es: number;       // Steel modulus (psi)
  lambdaConcrete: number; // Lightweight factor (1.0 normal, 0.75 lightweight)
}

export interface SectionDimensions {
  type: SectionType;
  b: number;        // Width (in)
  h: number;        // Total height/depth (in)
  bw?: number;      // Web width for T/L beam (in)
  hf?: number;      // Flange thickness (in)
  diameter?: number; // Circular section diameter (in)
  coverClear: number; // Clear cover to stirrups (in)
  stirrupDia: number; // Stirrup bar diameter (in)
}

export interface RebarLayout {
  topBars: BarGroup[];
  botBars: BarGroup[];
  sideBars?: BarGroup[];  // skin reinforcement (beams) / intermediate bars (columns)
  ties?: TieLayout;
  tieType?: 'tied' | 'spiral'; // columns only; default 'tied'
  /**
   * Optional zoned stirrup layout for beams: three spacings over equal
   * thirds of the span [end, middle, end]. Tie bar size/legs come from
   * `ties`. When absent the single `ties.spacing` applies full length.
   */
  tieZones?: [TieZone, TieZone, TieZone];
  /**
   * Vertical clear spacing between bar layers when topBars/botBars have more
   * than one entry (each entry = one layer, outermost first). Default 1.0"
   * (ACI §25.2.2 minimum).
   */
  layerClearSpacing?: number;
}

export interface TieZone {
  spacing: number; // in
}

// ── ETABS import link ─────────────────────────────────────────────────────────

export interface Point3D { x: number; y: number; z: number } // ft, model coords

/** Provenance of a member imported from an ETABS model via the CSI API. */
export interface EtabsLink {
  frameName: string;     // ETABS unique frame name
  story: string;         // floor level label
  groups: string[];      // ETABS group memberships
  pt1: Point3D;          // I-node coordinates
  pt2: Point3D;          // J-node coordinates
  sectionName: string;   // ETABS frame property name
  designGroupId?: string;
}

/** Force value at a station along the member. */
export interface StationForce {
  x: number;  // distance from I-node (ft)
  V: number;  // shear V2 (kips)
  M: number;  // moment M3 (kip-ft, +ve sagging)
  P?: number; // axial force (kips, + compression) — from COM import
  T?: number; // torsion (kip-ft) — from COM import
}

/** Station forces for one load combination. */
export interface ComboForces {
  combo: string;
  stations: StationForce[];
}

/** A set of beams designed together with one rebar layout vs the group envelope. */
export interface DesignGroup {
  id: string;
  label: string;
  memberIds: string[];
  color?: string;      // display color on the model map
  rebar?: RebarLayout; // group template — fanned out to members on Apply
  /** 'auto' = created by auto-grouping (replaceable); 'manual' = user-created. */
  source?: 'auto' | 'manual';
  /**
   * Governing flexural face when the group was created by "Split by face" with a
   * name template. 'top' = M⁻ (hogging) governed, 'bot' = M⁺ (sagging) governed.
   * Kept OUT of the label (the legend stays clean); shown as a (T)/(B) badge on
   * the group dashboard.
   */
  face?: 'top' | 'bot';
  /**
   * L/3 curtailment notes the user pinned via the section-card flags. When a face
   * is true, the beam schedule carries a note stating what % of that face's steel
   * the third-point demand needs (so the balance may be curtailed). Recomputed at
   * export time from the current cage + station forces.
   */
  curtailmentNotes?: { top?: boolean; bot?: boolean };
  /**
   * Reduced TOP reinforcement for the OPPOSITE (non-governing) end of the beams.
   * The group's `rebar.topBars` is the mark-side (governing-end) top steel; the
   * lower-demand end can often take less. When set, the section card shows it and
   * the beam schedule carries it as the opposite-end top bars.
   */
  oppositeTopBars?: BarGroup[];
  /**
   * Reduced TOP reinforcement kept CONTINUOUS through the MIDDLE third. Top steel
   * is detailed for hogging at the supports (the end thirds); through mid-span it
   * may be curtailed to a user-chosen percentage of the mark cage — never below
   * code As,min. When set, the section card shows it and the moment diagram /
   * schedule carry it as the middle-third top bars.
   */
  midThirdTopBars?: BarGroup[];
  /**
   * Reduced BOTTOM reinforcement kept CONTINUOUS through the END thirds. Bottom
   * steel is detailed for sagging at mid-span; toward the supports (the end
   * thirds) it may be curtailed to a user-chosen cage — never below code As,min.
   * When set, the section card shows it, and the moment diagram / eye pop-out
   * carry it as the end-third bottom bars. Unset ⇒ the auto ~continuous cage.
   */
  endThirdBotBars?: BarGroup[];
  /**
   * Engineer sign-off. When true, every failing / warned beam in the group is
   * presented as "Reviewed" across the Group Dashboard (card + beam list), the
   * group drops out of the error/warning tallies, and its beams stop being flagged
   * red on the plan. A DISPLAY-LAYER override recording that an engineer has
   * accepted the group's checks — the design engines still compute the true DCRs.
   */
  reviewed?: boolean;
}

/** A beam frame captured from the ETABS model (connectivity snapshot). */
export interface MapFrame {
  frameName: string;
  story: string;
  sectionName: string;
  pt1: Point3D;
  pt2: Point3D;
  memberId?: string; // linked Member if imported and designed
}

export interface Point3D { x: number; y: number; z: number; }

/** A wall/slab area element captured from the ETABS model (planar polygon). */
export interface MapWall {
  id: string;             // ETABS unique area object name
  story: string;
  points: Point3D[];      // ordered corner ring (ft, model coords), ≥ 3
  kind?: 'wall' | 'slab'; // from Design Orientation / plane-normal
  sectionName?: string;   // area section property (optional)
  memberId?: string;      // linked Member if designed (optional, future)
}

/** A grid line captured from the ETABS model (map reference / labelling). */
export interface MapGrid {
  id: string;
  label: string;          // "A", "1", …
  p1: Point3D;            // grid line start (ft, model coords)
  p2: Point3D;            // grid line end
}

/** An opening (penetration) in a wall or slab. */
export interface MapOpening {
  id: string;
  story: string;
  points: Point3D[];      // ordered corner ring (ft, model coords), ≥ 3
}

/** Persistent connectivity snapshot of the ETABS model, saved in .scdb. */
export interface ModelMap {
  source: 'com' | 'file' | 'mock' | 'bridge';
  modelName: string;
  importedAt: string;
  stories: string[];
  frames: MapFrame[];
  walls?: MapWall[];        // optional — area/wall elements
  grids?: MapGrid[];        // optional — grid lines
  openings?: MapOpening[];  // optional — wall/slab openings
}

/** One point on a column P-M interaction curve. */
export interface InteractionPoint {
  c: number;       // neutral axis depth (in) — Infinity at pure compression
  Pn: number;      // nominal axial (kips)
  Mn: number;      // nominal moment (kip-ft)
  phi: number;     // strength reduction factor (1.0 for EC2)
  phiPn: number;   // design axial — capped by Pn,max at top (kips)
  phiMn: number;   // design moment (kip-ft)
  eps_t: number;   // extreme tension steel strain
}

export interface BarGroup {
  numBars: number;
  barSize: number; // #3 = 3, #8 = 8, etc.
  /** @deprecated unused — multi-layer is modeled as multiple BarGroup entries */
  rows?: number;
  /** @deprecated unused — see RebarLayout.layerClearSpacing */
  rowSpacing?: number;
  /** Vertical centre-to-centre spacing of skin bars (inches). Used for EC2
   *  side-face crack width ρ_eff = As_bar / (spacing × hc,eff). When absent,
   *  a uniform spacing over the available web height is assumed. */
  spacing?: number;
}

export interface TieLayout {
  barSize: number;
  spacing: number; // in
  legs: number;
}

export interface LoadCase {
  id: string;
  label: string;
  Mu_pos: number;  // Positive moment (kip-ft)
  Mu_neg: number;  // Negative moment (kip-ft)
  Vu: number;      // Shear (kips) — beams; columns use the biaxial Vu2/Vu3 below
  Tu: number;      // Torsion (kip-ft)
  Pu: number;      // Axial (kips, + compression)
  Mux?: number;    // Moment about x for column (kip-ft)
  Muy?: number;    // Moment about y for column (kip-ft)
  /**
   * Biaxial column shears (kips), preserved separately for the S-Concrete .SCO so
   * both faces are checked instead of collapsing to a single Vu. ETABS V2 pairs
   * with the strong-axis moment (Mux/M3 → S-Concrete Vfz) and V3 with the
   * weak-axis moment (Muy/M2 → Vfy). Absent for beams and hand-entered members.
   */
  Vu2?: number;    // ETABS V2, strong-direction shear (kips)
  Vu3?: number;    // ETABS V3, weak-direction shear (kips)
}

export interface DesignResults {
  loadCaseId: string;
  // Flexure
  Mn_pos: number;       // Positive moment capacity (kip-ft)
  Mn_neg: number;       // Negative moment capacity (kip-ft)
  phi_Mn_pos: number;
  phi_Mn_neg: number;
  DCR_flex_pos: number;
  DCR_flex_neg: number;
  // Shear
  Vc: number;           // Concrete shear (kips)
  Vs: number;           // Steel shear (kips)
  phi_Vn: number;       // Total shear capacity
  DCR_shear: number;
  // Torsion
  Tcr: number;          // Cracking torsion (kip-ft)
  Tu_threshold: number;
  phi_Tn: number;       // Torsion capacity
  DCR_torsion: number;
  // Axial (columns)
  phi_Pn?: number;
  phi_Mn_col?: number;
  DCR_axial?: number;
  DCR_PM?: number;      // Combined P-M interaction
  phi_Pn_max?: number;  // axial capacity cap φ·Pn,max (kips) | N_Rd,max for EC2
  phi_Mnx?: number;     // moment capacity about x at Pu (kip-ft)
  phi_Mny?: number;     // moment capacity about y at Pu (kip-ft)
  interaction?: InteractionPoint[]; // P-M curve (about x) for chart/calc sheet
  // Extended column outputs — ported target from Column_Design_DW
  // design_engine.compute_all_outputs(). Optional so beam/wall paths are unaffected.
  theta_deg?: number;          // governing resultant-moment vector angle (deg)
  NM_util?: number;            // governing combined axial + biaxial-moment utilization
  DCR_axial_tens?: number;     // axial tension utilization = Pu / φ(As·fy)
  phi_Vnz?: number;            // shear capacity, z-direction / strong face (kips)
  phi_Vny?: number;            // shear capacity, y-direction / weak face (kips)
  DCR_Vz?: number;             // shear DCR, z-direction
  DCR_Vy?: number;             // shear DCR, y-direction
  VT_util?: number;            // governing shear+torsion utilization
  Sreq_z?: number;             // required tie spacing from z-shear (in)
  Sreq_y?: number;             // required tie spacing from y-shear (in)
  Sreq?: number;               // governing required tie spacing (in)
  phi_Tcr?: number;            // torsion cracking threshold φTcr (kip-ft)
  governingLoadCaseId?: string;
  // Additional
  As_req_pos: number;   // Required steel (in²)
  As_req_neg: number;
  As_min: number;
  As_max: number;
  Av_req: number;       // Required stirrup area (in²/in)
  Av_min_per_s: number; // Min Av/s per ACI §9.6.3.3 (in²/in)
  // EC2 crack width check (EN 1992-1-1 §7.3.4) — mm, only set for EN1992-1-1
  wk_bot?: number;      // crack width at bottom face (mm)
  wk_top?: number;      // crack width at top face (mm)
  wk_face?: number;     // crack width at side face (mm)
  DCR_crack?: number;   // governing crack-width DCR = wk / w_limit (SLS)
  // EC2 §7.3.3(3)+§7.3.2(2) minimum skin/side-face area for deep beams (mm², both faces)
  As_skin_min?: number; // required minimum crack-control skin area
  As_skin_prov?: number;// provided skin area (2 × per-face side bars)
  warnings: DesignWarning[];
  status: 'OK' | 'NG' | 'Warning';
}

/** One auto-group bin used as a reference overlay on the map. */
export interface AutoGroupBin {
  binKey: string;     // e.g. "14x24|4000|60000-0"
  memberIds: string[];
  color: string;
  label: string;
}

export interface Project {
  id: string;
  name: string;
  code: DesignCode;
  description: string;
  engineer: string;
  date: string;
  members: Member[];
  designGroups?: DesignGroup[]; // beam design groups (ETABS import)
  modelMap?: ModelMap;          // persistent connectivity snapshot
  /** Target DCR for rebar suggestions and savings analytics (default 0.9). */
  targetDCR?: number;
  /** Member ids hidden from the map view (not deleted). */
  hiddenMemberIds?: string[];
  /** Stories (floors) hidden from the map view. */
  hiddenStories?: string[];
  /**
   * EC2 crack-width quasi-permanent combo (NAME, e.g. "SLS-QP"); resolved per
   * beam from stationForces. Chosen in the ETABS import wizard.
   */
  slsCombo?: string;
  /** Last S-Concrete batch results, persisted so they survive tab switches and
   *  colour the model map by pass/fail. */
  sconcreteResults?: SconcreteResult[];
  /** ISO timestamp of the last S-Concrete batch run. */
  sconcreteRanAt?: string;
}

/**
 * A persisted S-Concrete batch result, carrying the .SCRS values PLUS the linkage
 * back to the app: which members it covers (for map colouring) and what it checks.
 */
export interface SconcreteResult {
  name: string;            // .SCRS key (group label or member name)
  status: string | null;   // 'OK' | 'OVERSTRESSED' | ...
  nmUtil: number | null;   // N-M utilization
  vtUtil: number | null;   // shear+torsion utilization
  kind?: 'uls' | 'crack' | 'single';
  groupLabel?: string;
  memberIds: string[];     // members this result applies to
  warnings?: string[];     // S-Concrete "Msg" lines from the .SCRS (warnings/notes)
  cage?: string;           // longitudinal cage the .SCO used (e.g. "3-#10 top / 3-#10 bot")
}

/** EC2 crack width check inputs (EN 1992-1-1 §7.3.4) — all in mm / unitless. */
export interface CrackControlParams {
  wLimitTop: number;   // allowable crack width at top face (mm)
  wLimitBot: number;   // allowable crack width at bottom face (mm)
  wLimitFace: number;  // allowable crack width at side faces (mm)
  qpFactor: number;    // quasi-permanent moment ratio: M_qp = qpFactor × Mu (0–1)
  kt: number;          // load duration factor: 0.4 long-term, 0.6 short-term
  // NEW: when set, these override qpFactor × Mu for crack width checks
  slsLoadCaseId?: string;   // ID of the SLS quasi-permanent load case
  Mqp_pos?: number;         // kip-ft, resolved from slsLoadCaseId at call site
  Mqp_neg?: number;         // kip-ft, resolved from slsLoadCaseId at call site
  // Creep model for the crack modular ratio αe = Es/(Ecm/(1+φ)), EN 1992-1-1 Annex B.
  creepPhi?: number;        // effective creep coefficient φ; when set, used directly
  creepRH?: number;         // ambient relative humidity % (default 50)
  creepT0?: number;         // concrete age at first loading, days (default 28)
  cementClass?: 'S' | 'N' | 'R'; // cement class for the loading-age maturity (default 'N')
}

export const DEFAULT_CRACK_PARAMS: CrackControlParams = {
  wLimitTop: 0.3, wLimitBot: 0.3, wLimitFace: 0.3, qpFactor: 0.6, kt: 0.4,
  creepRH: 50, creepT0: 28, cementClass: 'N',
};

/** Engineer override — stamps a failing member as reviewed & accepted. */
export interface MemberOverride {
  note?: string;
}

/** Keys identifying which design check an override applies to. 'all'
 *  suppresses every failing check on the member. */
export type OverrideKey =
  | 'DCR_crack' | 'DCR_shear' | 'DCR_flex_pos' | 'DCR_flex_neg'
  | 'DCR_torsion' | 'DCR_axial' | 'DCR_PM' | 'all';

/** Map of override keys → MemberOverride. */
export type MemberOverrides = Partial<Record<OverrideKey, MemberOverride>>;

export interface Member {
  id: string;
  label: string;
  memberType: MemberType;
  material: MaterialProps;
  section: SectionDimensions;
  rebar: RebarLayout;
  loads: LoadCase[];
  results?: DesignResults[];
  span?: number;  // ft
  crackParams?: CrackControlParams; // EC2 crack width check inputs
  etabs?: EtabsLink;             // present when imported from an ETABS model
  stationForces?: ComboForces[]; // analysis forces along the span (per combo)
  /** Engineer overrides — manually accepted failing checks (display only;
   *  engine results retain their true DCR values). */
  overrides?: MemberOverrides;
}
