/**
 * Beam-specific types (ACI 318-19 §9).
 * Import shared primitives from ./common — never import from column.ts here.
 */

import type { BaseMember, BaseLoadCase, BaseDesignResults, BarGroup, TieLayout } from './common';

export type BeamSectionType = 'rectangular_beam' | 'T_beam' | 'L_beam';

/** Cross-section geometry for a concrete beam. */
export interface BeamSection {
  type: BeamSectionType;
  b: number;          // Flange/overall width (in)
  h: number;          // Overall depth (in)
  bw?: number;        // Web width for T/L sections (in)
  hf?: number;        // Flange thickness for T/L sections (in)
  coverClear: number; // Clear cover to stirrups (in) — fallback for every face
  coverTop?: number;    // Clear cover, top face (in)
  coverBottom?: number; // Clear cover, bottom face (in)
  coverSide?: number;   // Clear cover, side faces (in)
  stirrupDia: number; // Stirrup bar size (e.g. 4 for #4)
}

/** Reinforcement layout for a concrete beam. */
export interface BeamRebar {
  topBars: BarGroup[];
  botBars: BarGroup[];
  sideBars?: BarGroup[];  // Skin/face reinforcement (ACI §9.7.2.3)
  ties?: TieLayout;
}

/** Factored load demands for a beam load case. */
export interface BeamLoadCase extends BaseLoadCase {
  Mu_pos: number;  // Positive (sagging) factored moment (kip-ft)
  Mu_neg: number;  // Negative (hogging) factored moment (kip-ft)
  Vu: number;      // Factored shear (kips)
  Tu: number;      // Factored torsion (kip-ft)
  Pu: number;      // Factored axial (kips) — zero for pure beams
}

/** ACI 318-19 beam design results for one load case. */
export interface BeamResults extends BaseDesignResults {
  // Flexure (ACI §22.3)
  Mn_pos: number;
  Mn_neg: number;
  phi_Mn_pos: number;
  phi_Mn_neg: number;
  DCR_flex_pos: number;
  DCR_flex_neg: number;
  // Shear (ACI §22.5)
  Vc: number;
  Vs: number;
  phi_Vn: number;
  DCR_shear: number;
  // Torsion (ACI §22.7)
  Tcr: number;
  Tu_threshold: number;
  phi_Tn: number;
  DCR_torsion: number;
  // Steel limits (ACI §9.6)
  As_req_pos: number;
  As_req_neg: number;
  As_min: number;       // bottom (positive-moment) face
  /** Top-face As,min — see DesignResults in types/index.ts. */
  As_min_top?: number;
  As_max: number;
  Av_req: number;
  Av_min_per_s: number;
}

/** A concrete beam member. */
export interface BeamMember extends BaseMember {
  memberType: 'beam';
  section: BeamSection;
  rebar: BeamRebar;
  loads: BeamLoadCase[];
  results?: BeamResults[];
}
