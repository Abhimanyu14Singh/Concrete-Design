export type SectionType = 'rectangular_beam' | 'T_beam' | 'L_beam' | 'rectangular_column' | 'circular_column';
export type DesignCode = 'ACI318-19' | 'ACI318-14' | 'EN1992-1-1';
export type MemberType = 'beam' | 'column' | 'wall';
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
  sideBars?: BarGroup[];  // skin reinforcement
  ties?: TieLayout;
}

export interface BarGroup {
  numBars: number;
  barSize: number; // #3 = 3, #8 = 8, etc.
  rows?: number;
  rowSpacing?: number;
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
  Vu: number;      // Shear (kips)
  Tu: number;      // Torsion (kip-ft)
  Pu: number;      // Axial (kips, + compression)
  Mux?: number;    // Moment about x for column (kip-ft)
  Muy?: number;    // Moment about y for column (kip-ft)
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
  warnings: DesignWarning[];
  status: 'OK' | 'NG' | 'Warning';
}

export interface Project {
  id: string;
  name: string;
  code: DesignCode;
  description: string;
  engineer: string;
  date: string;
  members: Member[];
}

/** EC2 crack width check inputs (EN 1992-1-1 §7.3.4) — all in mm / unitless. */
export interface CrackControlParams {
  wLimitTop: number;   // allowable crack width at top face (mm)
  wLimitBot: number;   // allowable crack width at bottom face (mm)
  wLimitFace: number;  // allowable crack width at side faces (mm)
  qpFactor: number;    // quasi-permanent moment ratio: M_qp = qpFactor × Mu (0–1)
  kt: number;          // load duration factor: 0.4 long-term, 0.6 short-term
}

export const DEFAULT_CRACK_PARAMS: CrackControlParams = {
  wLimitTop: 0.3, wLimitBot: 0.3, wLimitFace: 0.3, qpFactor: 0.6, kt: 0.4,
};

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
}
