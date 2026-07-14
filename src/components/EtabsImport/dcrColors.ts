import { MAP_DCR_BANDS, MAP_GRAY, type DcrBand } from '../../theme';

/** Plan-map DCR color scale — every legend and fill uses the same status hues.
 *  Pass custom `bands` (from the Map's editable scale) to recolor; defaults to the
 *  shared MAP_DCR_BANDS. */
export function dcrToColor(dcr: number, bands: readonly DcrBand[] = MAP_DCR_BANDS): string {
  if (!Number.isFinite(dcr)) return MAP_GRAY.unassigned;
  for (const band of bands) {
    if (dcr < band.max) return band.color;
  }
  return bands[bands.length - 1].color;
}
