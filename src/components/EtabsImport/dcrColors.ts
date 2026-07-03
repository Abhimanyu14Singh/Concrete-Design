import { MAP_DCR_BANDS, MAP_GRAY } from '../../theme';

/** Plan-map DCR color scale — the shared MAP_DCR_BANDS, so every legend and
 *  fill uses the same status hues. */
export function dcrToColor(dcr: number): string {
  if (!Number.isFinite(dcr)) return MAP_GRAY.unassigned;
  for (const band of MAP_DCR_BANDS) {
    if (dcr < band.max) return band.color;
  }
  return MAP_DCR_BANDS[MAP_DCR_BANDS.length - 1].color;
}
