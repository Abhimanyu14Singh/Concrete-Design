/**
 * Rebar designation helpers.
 *
 * Encoding convention: positive barSize = US bar (#3..#18, ASTM A615);
 * NEGATIVE barSize = metric bar diameter in mm (e.g. -16 = Ø16).
 * getBarArea/getBarDiam in concreteDesign.ts handle both, returning in²/in.
 */

export const US_BAR_SIZES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 18];

/** European metric bar diameters (mm), stored as negative barSize values. */
export const METRIC_BAR_DIAMETERS = [8, 10, 12, 16, 20, 25, 32, 40];
export const METRIC_BAR_SIZES = METRIC_BAR_DIAMETERS.map(d => -d);

export function isMetricBar(size: number): boolean {
  return size < 0;
}

/** "#8" for US bars, "Ø16" for metric bars. */
export function formatBarLabel(size: number): string {
  return size < 0 ? `Ø${-size}` : `#${size}`;
}

/** Bar sizes to offer in the picker for the active unit system. */
export function barSizeOptions(units: 'imperial' | 'si', current?: number): number[] {
  const base = units === 'si' ? METRIC_BAR_SIZES : US_BAR_SIZES;
  if (current !== undefined && !base.includes(current)) {
    return [current, ...base];
  }
  return [...base];
}
