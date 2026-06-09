export type SectionType = 'rectangular_beam' | 'T_beam' | 'L_beam';
export type DesignCode = 'ACI318-19' | 'ACI318-14';
export type MemberType = 'beam';
export type ExposureClass = 'W0' | 'W1' | 'W2' | 'S0' | 'S1' | 'S2' | 'S3';

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
  Pu: number;      // Axial (kips)
}

export interface DesignWarning {
  code: string;      // ACI section, e.g. "ACI §9.7.6.2.2"
  message: string;   // Human-readable description with actual numbers
  severity: 'error' | 'warning';
}

export interface DesignResults {
  loadCaseId: string;
  // Flexure
  Mn_pos: number;
  Mn_neg: number;
  phi_Mn_pos: number;
  phi_Mn_neg: number;
  DCR_flex_pos: number;
  DCR_flex_neg: number;
  // Shear
  Vc: number;
  Vs: number;
  phi_Vn: number;
  DCR_shear: number;
  // Torsion
  Tcr: number;
  Tu_threshold: number;
  phi_Tn: number;
  DCR_torsion: number;
  // Steel
  As_req_pos: number;
  As_req_neg: number;
  As_min: number;
  As_max: number;
  Av_req: number;
  Av_min_per_s: number;
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
}
