/**
 * Unit system support — DISPLAY-LAYER CONVERSION ONLY.
 *
 * Every stored value and every calculation stays imperial (in, psi, kips, kip-ft). SI is
 * something that happens on the way to the screen and is undone on the way back in. Two
 * consequences worth stating plainly:
 *
 *  • Never store a `toDisplay` result. Round-tripping through SI and back loses precision,
 *    and a member saved in "SI" would design differently from the same member saved in
 *    imperial. `fromDisplay` is the ONLY way a user-entered SI number re-enters the model.
 *
 *  • Never hand-format a number with a unit. Go through `fmt`/`fmtVal` (or the `useUnits()`
 *    hook that wraps them) so the digits and the label always agree with the active system.
 *
 * The `Quantity` a value is tagged with picks its factor, its label AND its idiomatic
 * precision — mm want 0 decimals where inches want 2 — so tagging a value with the wrong
 * quantity produces a plausible-looking wrong number, not an obvious error.
 */

export type UnitSystem = 'imperial' | 'si';

/** What kind of quantity a number is. Drives conversion factor, label and precision. */
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

/** The unit label alone, e.g. 'mm' or 'in'. */
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

/** localStorage key for the user's unit preference. */
export const UNITS_STORAGE_KEY = 'sc-units';

/** Read the saved unit preference. Falls back to imperial on anything unexpected —
 *  including a throwing localStorage (private mode, or a renderer without storage). */
export function loadUnits(): UnitSystem {
  try {
    const v = localStorage.getItem(UNITS_STORAGE_KEY);
    return v === 'si' ? 'si' : 'imperial';
  } catch {
    return 'imperial';
  }
}

/** Persist the unit preference. Silently ignores storage failures — a display setting
 *  that can't be saved must not break the app. */
export function saveUnits(u: UnitSystem): void {
  try { localStorage.setItem(UNITS_STORAGE_KEY, u); } catch { /* ignore */ }
}

// ── Code-dependent capacity labels ───────────────────────────────────────────

/** Symbols for the capacity quantities, as the active code writes them. */
export interface CapacityLabels {
  Mn: string; Vn: string; Tn: string; Vc: string; Vs: string; Tcr: string;
}

/**
 * Capacity symbols for a design code.
 *
 * This is not cosmetic. EC2 resistances are γ-factored design values, so they are
 * labelled M_Rd / V_Rd with NO φ — writing "φMn" over an EC2 number would state that a
 * strength-reduction factor was applied when none was.
 */
export function capacityLabels(code: string): CapacityLabels {
  if (code === 'EN1992-1-1') {
    return { Mn: 'M_Rd', Vn: 'V_Rd', Tn: 'T_Rd', Vc: 'V_Rd,c', Vs: 'V_Rd,s', Tcr: 'T_Rd,c' };
  }
  return { Mn: 'φMn', Vn: 'φVn', Tn: 'φTn', Vc: 'Vc', Vs: 'Vs', Tcr: 'Tcr' };
}
