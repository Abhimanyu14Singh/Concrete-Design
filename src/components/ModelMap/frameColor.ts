/**
 * Shared frame-coloring logic for the model-map views (2D plan canvas + 3D orbit
 * canvas). Extracted so both views color members identically — by DCR, design
 * group, section, a metric ramp, or the auto-group overlay.
 */
import type { MapFrame, DesignGroup, AutoGroupBin } from '../../types';
import { dcrToColor } from '../EtabsImport/dcrColors';
import { valueToRampColor } from './colorRamp';
import { groupColor } from './groupColors';

export type ColorMode = 'dcr' | 'group' | 'section' | 'flexSteel' | 'stirrups' | 'weight' | 'autoGroup';

const UNLINKED = '#d1d5db';   // imported frame with no designed member
const NO_GROUP = '#9ca3af';   // member not in any group / overlay bin

/** Build a memberId → color map from the design groups (group display color, by index). */
export function buildGroupColorMap(designGroups: DesignGroup[]): Map<string, string> {
  const map = new Map<string, string>();
  designGroups.forEach((g, i) => {
    const color = groupColor(g.color, i);
    g.memberIds.forEach((mid) => map.set(mid, color));
  });
  return map;
}

/** Build a memberId → color map from auto-group overlay bins. */
export function buildAutoGroupColorMap(bins: AutoGroupBin[]): Map<string, string> {
  const map = new Map<string, string>();
  bins.forEach((bin) => bin.memberIds.forEach((mid) => map.set(mid, bin.color)));
  return map;
}

export interface FrameColorContext {
  colorMode: ColorMode;
  dcrById: Record<string, number>;
  groupColorMap: Map<string, string>;
  autoGroupColorMap: Map<string, string>;
  metricById: Record<string, number>;
  metricRange?: { min: number; max: number };
}

/** Color a frame for the current mode. Mirrors the original MapCanvas logic 1:1. */
export function frameColorFor(f: Pick<MapFrame, 'memberId' | 'sectionName'>, ctx: FrameColorContext): string {
  const { colorMode, dcrById, groupColorMap, autoGroupColorMap, metricById, metricRange } = ctx;
  if (colorMode === 'autoGroup') {
    if (f.memberId) {
      const c = autoGroupColorMap.get(f.memberId);
      if (c) return c;
    }
    return NO_GROUP;
  }
  if (colorMode === 'group') {
    if (f.memberId) {
      const c = groupColorMap.get(f.memberId);
      if (c) return c;
    }
    return NO_GROUP;
  }
  if ((colorMode === 'flexSteel' || colorMode === 'stirrups' || colorMode === 'weight') && f.memberId) {
    const v = metricById[f.memberId];
    if (v !== undefined && metricRange) {
      return valueToRampColor(v, metricRange.min, metricRange.max);
    }
    return UNLINKED;
  }
  if (colorMode === 'section') {
    let h = 0;
    for (const ch of f.sectionName) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
    return `hsl(${(h * 137) % 360},60%,45%)`;
  }
  if (f.memberId) {
    const dcr = dcrById[f.memberId] ?? 0;
    return dcrToColor(dcr);
  }
  return UNLINKED;
}
