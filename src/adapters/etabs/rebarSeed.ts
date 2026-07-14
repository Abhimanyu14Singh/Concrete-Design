/**
 * Rebar seeding — turns the wizard's "typical reinforcement" inputs
 * (steel percentages + three stirrup spacings) into a concrete RebarLayout
 * for a given section size. Pure functions, unit-tested.
 */
import type { RebarLayout, SectionDimensions, TieZone, DesignCode, BarGroup } from '../../types';
import { getBarArea, getBarDiam, effectiveDepth } from '../../utils/concreteDesign';
import { skinMinArea } from '../../engines/ec2/ec2Beam';

export interface SeedOptions {
  rhoTopPct: number;             // top steel, % of b·d (e.g. 0.4)
  rhoBotPct: number;             // bottom steel, % of b·d
  stirrupSpacings: [number, number, number]; // [end, middle, end] (in)
  stirrupBarSize?: number;       // default #4
  stirrupLegs?: number;          // default 2
  /** Auto-impose minimum side/skin reinforcement on deep beams per the design code. */
  imposeSkinReinf?: boolean;
  /** Bar size to use for the skin/side bars (default #5 / Ø12). */
  skinBarSize?: number;
  /** Clear cover to stirrup face (in). Overrides section default (1.5"). */
  coverClear?: number;
}

const IN_TO_MM = 25.4;
const IN2_TO_MM2 = 645.16;

/**
 * Code-based minimum side/skin reinforcement for a deep beam. Returns the side
 * bars PER FACE and bar size, or undefined when the section is too shallow to
 * require skin steel. (Beam convention — the section drawing, the crack engine,
 * and the .SCO all count skin bars per face; the column seed doubles this to a
 * both-faces total since columns pool their side bars.)
 *
 *  - ACI 318 §9.7.2.3: required when h > 36 in, distributed over the lower h/2 of
 *    the web at ≤ 12 in spacing (geometric).
 *  - EC2 §7.3.3(3)+§7.3.2(2): required when h > 1000 mm, and — crucially — sized to
 *    the minimum crack-control AREA As,min = kc·k·fct·Act/σs (not just a spacing
 *    rule). This is what governs a deep, lightly-loaded beam, and matches
 *    S-CONCRETE. The ≤300 mm spacing rule is kept as a lower-bound floor. Pass the
 *    section's fck (MPa) and any axial NEd for an accurate area; without them a
 *    representative fck and pure bending are assumed.
 */
export function minSkinReinforcement(
  section: SectionDimensions,
  code: DesignCode | string,
  barSize: number,
  opts?: { fckMPa?: number; NEd_N?: number; wLimitFace?: number },
): BarGroup | undefined {
  const isEC2 = code === 'EN1992-1-1';
  const thresholdIn = isEC2 ? 1000 / IN_TO_MM : 36;
  const h = section.h;
  if (h <= thresholdIn) return undefined;
  const cover = section.coverClear ?? 1.5;
  const bySpacing = Math.max(1, Math.ceil(Math.max(0, h / 2 - cover) / (isEC2 ? 300 / IN_TO_MM : 12)));
  if (isEC2) {
    // Area-driven per EC2 (see doc): enough bars to meet As,min, ≥ the spacing floor.
    const b_mm = (section.bw ?? section.b) * IN_TO_MM;
    const dia_mm = getBarDiam(barSize) * IN_TO_MM;
    const skin = skinMinArea(b_mm, h * IN_TO_MM, opts?.NEd_N ?? 0, opts?.fckMPa ?? 30, dia_mm, opts?.wLimitFace ?? 0.3);
    const areaOne_mm2 = getBarArea(barSize) * IN2_TO_MM2;
    const byArea = skin && areaOne_mm2 > 0 ? Math.ceil(skin.AsMin / areaOne_mm2 / 2) : 0; // per face
    return { numBars: Math.max(byArea, bySpacing), barSize };
  }
  return { numBars: bySpacing, barSize }; // ACI — bars PER FACE (beam convention)
}

// US bars (#5–#11) and metric bars (Ø16–Ø32, stored negative). pickBars
// chooses the candidate set from the design code so EC2 sections get metric
// bars (Ø) and ACI sections get US (#) bars.
const CANDIDATE_SIZES_US = [5, 6, 7, 8, 9, 10, 11];
const CANDIDATE_SIZES_METRIC = [-16, -20, -25, -32];
const MIN_BARS = 2;
const MAX_BARS = 8;

function candidateSizes(code?: DesignCode | string): number[] {
  return code === 'EN1992-1-1' ? CANDIDATE_SIZES_METRIC : CANDIDATE_SIZES_US;
}

/**
 * Pick the bar size/count whose total area best meets `AsTarget` while
 * fitting in the web width with ACI minimum clear spacing
 * (max of 1", db — §25.2.1).
 */
export function pickBars(
  AsTarget: number,
  section: SectionDimensions,
  stirrupBarSize = 4,
  code?: DesignCode | string,
): { numBars: number; barSize: number } {
  const bw = section.bw ?? section.b;
  const clearWidth = bw - 2 * (section.coverClear + getBarDiam(stirrupBarSize));
  const sizes = candidateSizes(code);

  let best: { numBars: number; barSize: number; over: number } | null = null;
  for (const size of sizes) {
    const db = getBarDiam(size);
    const area = getBarArea(size);
    const minClear = Math.max(1, db);
    // Largest count that fits in one layer
    const maxFit = Math.max(MIN_BARS, Math.floor((clearWidth + minClear) / (db + minClear)));
    const n = Math.min(Math.max(MIN_BARS, Math.ceil(AsTarget / area)), MAX_BARS, maxFit);
    const As = n * area;
    if (As >= AsTarget) {
      const over = As - AsTarget;
      if (!best || over < best.over) best = { numBars: n, barSize: size, over };
    }
  }
  // Nothing meets the target within limits — return the biggest workable set
  if (!best) {
    const size = sizes[sizes.length - 1];
    return { numBars: MAX_BARS, barSize: size };
  }
  return { numBars: best.numBars, barSize: best.barSize };
}

/** Build a full RebarLayout (with three stirrup zones) from percentages. */
export function seedRebar(section: SectionDimensions, opts: SeedOptions, code?: DesignCode | string): RebarLayout {
  const isEC2 = code === 'EN1992-1-1';
  const bw = section.bw ?? section.b;
  const stirrupBarSize = opts.stirrupBarSize ?? (isEC2 ? -10 : 4);
  const d = effectiveDepth({ ...section, stirrupDia: stirrupBarSize }, 8);

  const AsTop = (opts.rhoTopPct / 100) * bw * d;
  const AsBot = (opts.rhoBotPct / 100) * bw * d;

  const tieZones: [TieZone, TieZone, TieZone] = [
    { spacing: opts.stirrupSpacings[0] },
    { spacing: opts.stirrupSpacings[1] },
    { spacing: opts.stirrupSpacings[2] },
  ];

  // Code-based minimum skin reinforcement for deep members (opt-in via wizard).
  // minSkinReinforcement returns bars PER FACE (beam convention); columns pool
  // their side bars as a both-faces total, so double for column sections.
  const skinPerFace = opts.imposeSkinReinf && code
    ? minSkinReinforcement(section, code, opts.skinBarSize ?? (isEC2 ? -12 : 5))
    : undefined;
  const skin = skinPerFace && section.type.endsWith('_column')
    ? { ...skinPerFace, numBars: skinPerFace.numBars * 2 }
    : skinPerFace;

  return {
    topBars: [pickBars(AsTop, section, stirrupBarSize, code)],
    botBars: [pickBars(AsBot, section, stirrupBarSize, code)],
    ties: {
      barSize: stirrupBarSize,
      // Engine single-spacing checks use the tightest (end) spacing
      spacing: Math.min(...opts.stirrupSpacings),
      legs: opts.stirrupLegs ?? 2,
    },
    tieZones,
    ...(skin ? { sideBars: [skin] } : {}),
  };
}
