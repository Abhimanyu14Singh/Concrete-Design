/** Wall-specific types for ACI 318-19 §11 shear wall design. */

import type { BaseMember, BaseLoadCase, BaseDesignResults, BarGroup } from './common';

export type WallSectionType = 'rectangular_wall';

export interface WallSection {
  type: WallSectionType;
  lw: number;          // Wall length in-plane (in)
  hw: number;          // Wall height (in)
  tw: number;          // Wall thickness (in)
  coverClear: number;
}

export interface WallRebar {
  vertBars: BarGroup[];     // Vertical distributed reinforcement
  horizBars: BarGroup[];    // Horizontal distributed reinforcement
  boundaryBars?: BarGroup[];// Boundary element bars (if required)
}

/** Factored load demands for a wall load case. */
export interface WallLoadCase extends BaseLoadCase {
  Pu: number;    // Factored axial (kips)
  Vu: number;    // In-plane factored shear (kips)
  Mu: number;    // In-plane factored moment (kip-ft)
}

/** ACI 318-19 §11 wall design results. */
export interface WallResults extends BaseDesignResults {
  phi_Pn: number;
  phi_Vn: number;
  phi_Mn: number;
  DCR_axial: number;
  DCR_shear: number;
  DCR_flexure: number;
  boundaryElementRequired: boolean;
}

/** A concrete wall member. */
export interface WallMember extends BaseMember {
  memberType: 'wall';
  section: WallSection;
  rebar: WallRebar;
  loads: WallLoadCase[];
  results?: WallResults[];
  story?: string;
}
