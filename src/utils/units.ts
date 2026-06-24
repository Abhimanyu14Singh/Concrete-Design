/**
 * Unit system support — display-layer conversion only.
 * All stored data and calculations remain imperial (in, psi, kips, kip-ft).
 */

export type UnitSystem = 'imperial' | 'si';

export type Quantity =
  | 'length'      // in ↔ mm
  | 'stress'      // psi ↔ MPa
  | 'stressKsi'   // ksi ↔ MPa
  | 'force'       // kips ↔ kN
  | 'moment'      // kip-ft ↔ kN·m
  | 'area'        // in² ↔ mm²
  | 'spanLength'  // ft ↔ m
  | 'steelWeight'    // lb ↔ kg
  | 'steelWeightPerLength' // lb/ft ↔ kg/m
  | 'areaPerLength'; // in²/in ↔ mm²/mm  (also used for in²/ft → mm²/m display)

/** Multiplicative factors: imperial value × factor = SI value */
const TO_SI: Record<Quantity, number> = {
  length:     25.4,
  stress:     0.00689476,
  stressKsi:  6.89476,
  force:      4.44822,
  moment:     1.35582,
  area:       645.16,
  spanLength: 0.3048,
  steelWeight: 0.453592,           // lb → kg
  steelWeightPerLength: 1.48816,   // lb/ft → kg/m
  areaPerLength: 25.4,             // in²/in → mm²/mm
};

const SI_LABEL: Record<Quantity, string> = {
  length: 'mm', stress: 'MPa', stressKsi: 'MPa', force: 'kN',
  moment: 'kN·m', area: 'mm²', spanLength: 'm',
  steelWeight: 'kg', steelWeightPerLength: 'kg/m', areaPerLength: 'mm²/mm',
};
const IMP_LABEL: Record<Quantity, string> = {
  length: 'in', stress: 'psi', stressKsi: 'ksi', force: 'kips',
  moment: 'kip-ft', area: 'in²', spanLength: 'ft',
  steelWeight: 'lb', steelWeightPerLength: 'lb/ft', areaPerLength: 'in²/in',
};

/** Idiomatic decimal places for SI display */
const SI_DIGITS: Record<Quantity, number> = {
  length: 0, stress: 1, stressKsi: 0, force: 1, moment: 1, area: 0, spanLength: 2,
  steelWeight: 0, steelWeightPerLength: 1, areaPerLength: 3,
};
const IMP_DIGITS: Record<Quantity, number> = {
  length: 2, stress: 0, stressKsi: 0, force: 1, moment: 1, area: 2, spanLength: 1,
  steelWeight: 0, steelWeightPerLength: 1, areaPerLength: 4,
};

/** Imperial (stored) value → display value in the chosen unit system. */
export function toDisplay(v: number, q: Quantity, u: UnitSystem): number {
  return u === 'si' ? v * TO_SI[q] : v;
}

/** Display value (in the chosen unit system) → imperial value for storage. */
export function fromDisplay(v: number, q: Quantity, u: UnitSystem): number {
  return u === 'si' ? v / TO_SI[q] : v;
}

export function unitLabel(q: Quantity, u: UnitSystem): string {
  return u === 'si' ? SI_LABEL[q] : IMP_LABEL[q];
}

/** Format an imperial value for display, e.g. fmt(22, 'length', 'si') → "559 mm" */
export function fmt(v: number, q: Quantity, u: UnitSystem, digits?: number): string {
  const d = digits ?? (u === 'si' ? SI_DIGITS[q] : IMP_DIGITS[q]);
  return `${toDisplay(v, q, u).toFixed(d)} ${unitLabel(q, u)}`;
}

/** Format just the number (no label). */
export function fmtVal(v: number, q: Quantity, u: UnitSystem, digits?: number): string {
  const d = digits ?? (u === 'si' ? SI_DIGITS[q] : IMP_DIGITS[q]);
  return toDisplay(v, q, u).toFixed(d);
}

export const UNITS_STORAGE_KEY = 'sc-units';

export function loadUnits(): UnitSystem {
  try {
    const v = localStorage.getItem(UNITS_STORAGE_KEY);
    return v === 'si' ? 'si' : 'imperial';
  } catch {
    return 'imperial';
  }
}

export function saveUnits(u: UnitSystem): void {
  try { localStorage.setItem(UNITS_STORAGE_KEY, u); } catch { /* ignore */ }
}

// ── Code-dependent capacity labels ───────────────────────────────────────────

export interface CapacityLabels {
  Mn: string; Vn: string; Tn: string; Vc: string; Vs: string; Tcr: string;
}

export function capacityLabels(code: string): CapacityLabels {
  if (code === 'EN1992-1-1') {
    return { Mn: 'M_Rd', Vn: 'V_Rd', Tn: 'T_Rd', Vc: 'V_Rd,c', Vs: 'V_Rd,s', Tcr: 'T_Rd,c' };
  }
  return { Mn: 'φMn', Vn: 'φVn', Tn: 'φTn', Vc: 'Vc', Vs: 'Vs', Tcr: 'Tcr' };
}
