/**
 * Shared primitive types used across all member types (beam, column, wall).
 * Nothing in here is member-type-specific.
 */

export type DesignCode = 'ACI318-19' | 'ACI318-14' | 'EN1992-1-1';
export type ExposureClass = 'W0' | 'W1' | 'W2' | 'S0' | 'S1' | 'S2' | 'S3';

export interface MaterialProps {
  fc: number;             // Concrete compressive strength (psi)
  fy: number;             // Longitudinal steel yield strength (psi)
  fyt: number;            // Transverse steel yield strength (psi)
  Es: number;             // Steel modulus of elasticity (psi)
  lambdaConcrete: number; // Lightweight concrete factor (1.0 = normal, 0.75 = lightweight)
}

export interface BarGroup {
  numBars: number;
  barSize: number;    // ASTM bar designation: #3 = 3, #8 = 8, etc. NEGATIVE = metric Ø in mm (-16 = Ø16)
  rows?: number;
  rowSpacing?: number;
}

export interface TieLayout {
  barSize: number;
  spacing: number;  // center-to-center spacing (in)
  legs: number;
}

/**
 * User inputs for the EC2 crack width check (EN 1992-1-1 §7.3.4).
 * Limits and widths are in mm (the check is SI-native regardless of display units).
 */
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

export interface DesignWarning {
  code: string;             // ACI section reference, e.g. "ACI §9.7.6.2.2"
  message: string;          // Human-readable description with computed values
  severity: 'error' | 'warning';
}

/** Minimum fields shared by every design result object. */
export interface BaseDesignResults {
  loadCaseId: string;
  warnings: DesignWarning[];
  status: 'OK' | 'NG' | 'Warning';
}

/** Minimum fields shared by every load case. */
export interface BaseLoadCase {
  id: string;
  label: string;
}

/** Minimum fields shared by every member. */
export interface BaseMember {
  id: string;
  label: string;
  material: MaterialProps;
  span?: number;  // member length (ft)
}
