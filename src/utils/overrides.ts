/**
 * Engineer-override helpers — shared by the results UI and the PDF report.
 *
 * An override is a DISPLAY-LAYER concern only: the design engines always return
 * the true DCR values and warnings. These helpers decide how a member's checks
 * should be presented (status, colors, which warnings remain visible) once an
 * engineer has manually accepted one or more failing checks.
 */

import type {
  DesignResults, DesignWarning, MemberOverrides, OverrideKey,
} from '../types';

/** Human-readable labels for each override key. */
export const OVERRIDE_KEY_LABEL: Record<OverrideKey, string> = {
  DCR_crack: 'Crack width',
  DCR_shear: 'Shear',
  DCR_flex_pos: 'Flexure (+M)',
  DCR_flex_neg: 'Flexure (−M)',
  DCR_torsion: 'Torsion',
  DCR_axial: 'Axial',
  DCR_PM: 'P-M interaction',
  all: 'Entire member',
};

/**
 * Classify a code warning into the design-check category it belongs to, so an
 * override on that category can suppress it. Matches by the standard clause
 * prefix (ACI 318-19 / EN 1992-1-1) rather than enumerating every sub-clause.
 * Returns null when the warning is not tied to a single DCR check.
 */
export function warningOverrideKey(code: string, message: string): OverrideKey | null {
  // Crack control — EC2 §7.3.x, ACI §24.3.x
  if (/§7\.3/.test(code) || /§24\.3/.test(code)) return 'DCR_crack';
  // Torsion — EC2 §6.3.x, ACI §22.7.x  (test before shear so §6.3 ≠ §6.2)
  if (/§6\.3/.test(code) || /§22\.7/.test(code)) return 'DCR_torsion';
  // Shear — EC2 §6.2.x / §8.2 / §9.2.2.x, ACI §22.5.x / §9.6.3 / §9.7.6
  if (/§6\.2/.test(code) || /§8\.2/.test(code) || /§9\.2\.2/.test(code)
      || /§22\.5/.test(code) || /§9\.6\.3/.test(code) || /§9\.7\.6/.test(code)) return 'DCR_shear';
  // Column axial / P-M — EC2 §5.8.9, ACI §22.4 / §10.6 / §10.7
  if (/§5\.8\.9/.test(code) || /§22\.4/.test(code) || /§10\.6/.test(code) || /§10\.7/.test(code)) return 'DCR_PM';
  // Flexure — EC2 §6.1 / §5.5 / §9.2.1, ACI §22.3 / §9.3.3 / §9.6.1
  if (/§6\.1/.test(code) || /§5\.5/.test(code) || /§9\.2\.1/.test(code)
      || /§22\.3/.test(code) || /§9\.3\.3/.test(code) || /§9\.6\.1/.test(code)) {
    return /negative/i.test(message) ? 'DCR_flex_neg' : 'DCR_flex_pos';
  }
  return null;
}

/** Whether a specific check key is covered by an override (directly or via 'all'). */
export function isOverridden(overrides: MemberOverrides | undefined, key: OverrideKey): boolean {
  if (!overrides) return false;
  return !!overrides.all || !!overrides[key];
}

/** DCR keys that are failing or near-capacity (> 0.9) for a result — the
 *  candidates an engineer may want to review. */
export function failingKeys(r: DesignResults): OverrideKey[] {
  const keys: OverrideKey[] = [];
  const chk = (k: OverrideKey, v?: number) => { if (v !== undefined && v > 0.9) keys.push(k); };
  chk('DCR_flex_pos', r.DCR_flex_pos);
  chk('DCR_flex_neg', r.DCR_flex_neg);
  chk('DCR_shear', r.DCR_shear);
  chk('DCR_torsion', r.DCR_torsion);
  chk('DCR_crack', r.DCR_crack);
  chk('DCR_axial', r.DCR_axial);
  chk('DCR_PM', r.DCR_PM);
  return keys;
}

/** A result's effective status after applying engineer overrides. Downgrades to
 *  'OK' only when every failing check AND every error warning is covered. */
export function effectiveStatus(r: DesignResults, overrides?: MemberOverrides): DesignResults['status'] {
  if (!overrides || Object.keys(overrides).length === 0) return r.status;
  if (overrides.all) return 'OK';
  const allFailsCovered = failingKeys(r).every(k => isOverridden(overrides, k));
  const allWarnsCovered = r.warnings.every(w => {
    const k = warningOverrideKey(w.code, w.message);
    return k ? isOverridden(overrides, k) : w.severity !== 'error';
  });
  return allFailsCovered && allWarnsCovered ? 'OK' : r.status;
}

/** Warnings that remain visible after overrides (suppressed ones removed). */
export function visibleWarnings(warnings: DesignWarning[], overrides?: MemberOverrides): DesignWarning[] {
  if (!overrides) return warnings;
  if (overrides.all) return [];
  return warnings.filter(w => {
    const k = warningOverrideKey(w.code, w.message);
    return !(k && isOverridden(overrides, k));
  });
}

/** Entries of the overrides map as [key, MemberOverride] tuples (typed). */
export function overrideEntries(overrides?: MemberOverrides): [OverrideKey, NonNullable<MemberOverrides[OverrideKey]>][] {
  if (!overrides) return [];
  return Object.entries(overrides) as [OverrideKey, NonNullable<MemberOverrides[OverrideKey]>][];
}
