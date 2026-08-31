/**
 * Rebar designation helpers.
 *
 * Encoding convention: positive barSize = US bar (#3..#18, ASTM A615);
 * NEGATIVE barSize = metric bar diameter in mm (e.g. -16 = Ø16).
 * getBarArea/getBarDiam in concreteDesign.ts handle both, returning in²/in.
 */

/** US bar designations (#3..#18, ASTM A615). Note the gaps — #12, #13 do not exist. */
export const US_BAR_SIZES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 18];

import type { BarFamily } from '../types';

/** European metric bar diameters (mm), stored as negative barSize values. */
export const METRIC_BAR_DIAMETERS = [8, 10, 12, 16, 20, 25, 32, 40];
/** The same metric bars as stored `barSize` values (negated — see the file header). */
export const METRIC_BAR_SIZES = METRIC_BAR_DIAMETERS.map(d => -d);

/** True for a metric bar. The sign IS the family — there is no separate flag to check. */
export function isMetricBar(size: number): boolean {
  return size < 0;
}

/** "#8" for US bars, "Ø16" for metric bars. */
export function formatBarLabel(size: number): string {
  return size < 0 ? `Ø${-size}` : `#${size}`;
}

/**
 * The bar catalogue offered in a picker.
 *
 * Keyed on the project's BAR FAMILY, not its display units: a job detailed in
 * millimetres may still specify US #-bars (and vice versa), so the two settings
 * are deliberately independent. Legacy unit strings are accepted so older call
 * sites keep working — 'si' maps to euro, 'imperial' to us.
 */
export function barSizeOptions(family: BarFamily | 'imperial' | 'si', current?: number): number[] {
  const euro = family === 'euro' || family === 'si';
  const base = euro ? METRIC_BAR_SIZES : US_BAR_SIZES;
  if (current !== undefined && !base.includes(current)) {
    return [current, ...base];
  }
  return [...base];
}

/**
 * Step a bar size one increment up (dir=+1, larger bar) or down (dir=-1, smaller
 * bar), staying within the same unit family (US #n vs metric Ø mm, chosen by the
 * sign of `size`). Clamps at the ends of the family; a size not in the family list
 * (custom bar) is returned unchanged. Used by the inline click-to-edit bar labels.
 */
export function barSizeStep(size: number, dir: 1 | -1): number {
  const family = size < 0 ? METRIC_BAR_SIZES : US_BAR_SIZES; // metric list is ascending: -8,-10,… (more negative = smaller)
  const idx = family.indexOf(size);
  if (idx === -1) return size;
  const next = idx + dir;
  if (next < 0 || next >= family.length) return size; // clamp at the ends
  return family[next];
}

/** Nominal diameter (mm) of any bar size, whichever family it belongs to.
 *  US #n is n/8 inch — #8 = 1" = 25.4 mm — which is what makes the two
 *  catalogues comparable at all. */
export function barDiamMm(size: number): number {
  return size < 0 ? -size : (size / 8) * 25.4;
}

/**
 * The closest bar in `family` to `size`, matched on nominal diameter.
 *
 * Used when a project switches catalogues: a #8 becomes Ø25 (25.4 → 25 mm) so
 * the whole job reads in one system. It is a SUBSTITUTION, not a relabel — the
 * areas differ slightly, so every check must re-run afterwards (which
 * applyProjectSettings does). Sizes already in the target family are returned
 * untouched.
 */
export function toBarFamily(size: number, family: BarFamily): number {
  const target = family === 'euro' ? METRIC_BAR_SIZES : US_BAR_SIZES;
  if (target.includes(size)) return size;
  const want = barDiamMm(size);
  return target.reduce((best, cand) =>
    Math.abs(barDiamMm(cand) - want) < Math.abs(barDiamMm(best) - want) ? cand : best, target[0]);
}

/** Sensible starting sizes for a family — the one place defaults are decided,
 *  so a new member, a seeded import and a group default all agree. */
export function defaultBarSizes(family: BarFamily): { long: number; stirrup: number; skin: number } {
  return family === 'euro'
    ? { long: -16, stirrup: -10, skin: -12 }
    : { long: 8, stirrup: 4, skin: 5 };
}
