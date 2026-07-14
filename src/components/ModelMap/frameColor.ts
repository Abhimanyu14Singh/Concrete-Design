/**
 * Shared frame-coloring logic for the model-map 2D plan canvas. Colors members
 * by DCR, design group (optionally numbered), section, a metric ramp (steel %,
 * stirrups, weight, height, width), concrete/steel grade, or the auto-group overlay.
 */
import type { MapFrame, DesignGroup, AutoGroupBin } from '../../types';
import { dcrToColor } from '../EtabsImport/dcrColors';
import { valueToRampColor } from './colorRamp';
import { groupColor } from './groupColors';
import { MAP_GRAY, STATUS, type DcrBand } from '../../theme';

export type ColorMode =
  | 'dcr' | 'group' | 'groupTags' | 'section' | 'flexSteel' | 'stirrups' | 'weight'
  | 'height' | 'width' | 'concGrade' | 'steelGrade' | 'autoGroup' | 'sconcrete';

/** Metric ramp modes — a continuous value colored on the shared blue→red ramp. */
export const METRIC_MODES: ColorMode[] = ['flexSteel', 'stirrups', 'weight', 'height', 'width'];

const UNLINKED = MAP_GRAY.unlinked;    // imported frame with no designed member
const NO_GROUP = MAP_GRAY.unassigned;  // member not in any group / overlay bin
const SCO_NONE = MAP_GRAY.notRun;      // member with no S-Concrete result yet

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

/** Build a memberId → group index (0-based) map — for on-plan group tags & legend. */
export function buildGroupIndexMap(designGroups: DesignGroup[]): Map<string, number> {
  const map = new Map<string, number>();
  designGroups.forEach((g, i) => g.memberIds.forEach((mid) => map.set(mid, i)));
  return map;
}

const PSI_PER_MPA = 145.0377;
/** Human concrete-grade label for a strength (psi): SI → "C30", imperial → "4 ksi". */
export function concGradeLabel(fcPsi: number, si: boolean): string {
  return si ? `C${Math.round(fcPsi / PSI_PER_MPA)}` : `${+(fcPsi / 1000).toFixed(1)} ksi`;
}
/** Human steel-grade label for a yield (psi): SI → "B500", imperial → "Gr 60". */
export function steelGradeLabel(fyPsi: number, si: boolean): string {
  return si ? `B${Math.round(fyPsi / PSI_PER_MPA)}` : `Gr ${Math.round(fyPsi / 1000)}`;
}

export interface FrameColorContext {
  colorMode: ColorMode;
  dcrById: Record<string, number>;
  groupColorMap: Map<string, string>;
  autoGroupColorMap: Map<string, string>;
  metricById: Record<string, number>;
  metricRange?: { min: number; max: number };
  /** memberId → categorical color for the 'concGrade' / 'steelGrade' modes. */
  gradeColorMap?: Map<string, string>;
  /** Persisted S-Concrete pass/fail per member (for the 'sconcrete' mode). */
  scoStatusById?: Record<string, 'OK' | 'NG'>;
  /** The Map's (possibly user-edited) DCR bands. Defaults to MAP_DCR_BANDS. */
  dcrBands?: readonly DcrBand[];
}

/** Color a frame for the current mode. Mirrors the original MapCanvas logic 1:1. */
export function frameColorFor(f: Pick<MapFrame, 'memberId' | 'sectionName'>, ctx: FrameColorContext): string {
  const { colorMode, dcrById, groupColorMap, autoGroupColorMap, metricById, metricRange, gradeColorMap, scoStatusById, dcrBands } = ctx;
  if (colorMode === 'sconcrete') {
    if (f.memberId) {
      const s = scoStatusById?.[f.memberId];
      if (s === 'OK') return STATUS.ok;
      if (s === 'NG') return STATUS.fail;
    }
    return SCO_NONE; // not run / not covered
  }
  if (colorMode === 'autoGroup') {
    if (f.memberId) {
      const c = autoGroupColorMap.get(f.memberId);
      if (c) return c;
    }
    return NO_GROUP;
  }
  if (colorMode === 'group' || colorMode === 'groupTags') {
    if (f.memberId) {
      const c = groupColorMap.get(f.memberId);
      if (c) return c;
    }
    return NO_GROUP;
  }
  if ((colorMode === 'concGrade' || colorMode === 'steelGrade') && f.memberId) {
    return gradeColorMap?.get(f.memberId) ?? NO_GROUP;
  }
  if (METRIC_MODES.includes(colorMode) && f.memberId) {
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
    return dcrToColor(dcr, dcrBands);
  }
  return UNLINKED;
}
