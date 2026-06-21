/** Column-specific types for ACI 318-19 §10 / EN 1992-1-1 §5 column design. */

import type { BaseMember, BaseLoadCase, BaseDesignResults, BarGroup, TieLayout } from './common';

export type ColumnSectionType = 'rectangular_column' | 'circular_column';

export interface ColumnSection {
  type: ColumnSectionType;
  b: number;           // Width (in)  — or diameter for circular
  h: number;           // Depth (in)  — equals b for circular
  coverClear: number;
  tieDia: number;
}

export interface ColumnRebar {
  longBars: BarGroup[];
  ties?: TieLayout;
}

/** Factored load demands for a column load case (biaxial bending + axial). */
export interface ColumnLoadCase extends BaseLoadCase {
  Pu: number;   // Factored axial (kips)
  Mux: number;  // Factored moment about x-axis (kip-ft)
  Muy: number;  // Factored moment about y-axis (kip-ft)
  Vux: number;  // Factored shear in x-direction (kips)
  Vuy: number;  // Factored shear in y-direction (kips)
}

/** ACI 318-19 / EC2 column design results. */
export interface ColumnResults extends BaseDesignResults {
  phi_Pn: number;
  phi_Mnx: number;
  phi_Mny: number;
  DCR_axial: number;
  DCR_PM: number;   // P-M interaction ratio
  DCR_shear: number;
}

/** A concrete column member. */
export interface ColumnMember extends BaseMember {
  memberType: 'column';
  section: ColumnSection;
  rebar: ColumnRebar;
  loads: ColumnLoadCase[];
  results?: ColumnResults[];
  story?: string;      // Floor level label
  clearHeight?: number; // ft
}
