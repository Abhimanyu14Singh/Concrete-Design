/**
 * Rebar seeding — turns the wizard's "typical reinforcement" inputs
 * (steel percentages + three stirrup spacings) into a concrete RebarLayout
 * for a given section size. Pure functions, unit-tested.
 */
import type { RebarLayout, SectionDimensions, TieZone, DesignCode, BarGroup } from '../../types';
import { getBarArea, getBarDiam, effectiveDepth } from '../../utils/concreteDesign';

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
}

const IN_TO_MM = 25.4;

/**
 * Code-based minimum side/skin reinforcement for a deep beam.
 *  - ACI 318 §9.7.2.3: required when h > 36 in, distributed over the lower h/2
 *    of the web at ≤ 12 in spacing.
 *  - EC2 §7.3.3: surface/skin reinforcement when h > 1000 mm, at ≤ 300 mm.
 * Returns the total side bars (both faces) and bar size, or undefined when the
 * section is too shallow to require skin steel.
 */
export function minSkinReinforcement(
  section: SectionDimensions,
  code: DesignCode | string,
  barSize: number,
): BarGroup | undefined {
  const isEC2 = code === 'EN1992-1-1';
  const thresholdIn = isEC2 ? 1000 / IN_TO_MM : 36;
  const h = section.h;
  if (h <= thresholdIn) return undefined;
  const sMaxIn = isEC2 ? 300 / IN_TO_MM : 12;
  const cover = section.coverClear ?? 1.5;
  const region = Math.max(0, h / 2 - cover); // lower (tension) half of the web
  const perFace = Math.max(1, Math.ceil(region / sMaxIn));
  return { numBars: 2 * perFace, barSize }; // both faces
}

const CANDIDATE_SIZES = [5, 6, 7, 8, 9, 10, 11];
const MIN_BARS = 2;
const MAX_BARS = 8;

/**
 * Pick the bar size/count whose total area best meets `AsTarget` while
 * fitting in the web width with ACI minimum clear spacing
 * (max of 1", db — §25.2.1).
 */
export function pickBars(
  AsTarget: number,
  section: SectionDimensions,
  stirrupBarSize = 4,
): { numBars: number; barSize: number } {
  const bw = section.bw ?? section.b;
  const clearWidth = bw - 2 * (section.coverClear + getBarDiam(stirrupBarSize));

  let best: { numBars: number; barSize: number; over: number } | null = null;
  for (const size of CANDIDATE_SIZES) {
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
    const size = CANDIDATE_SIZES[CANDIDATE_SIZES.length - 1];
    return { numBars: MAX_BARS, barSize: size };
  }
  return { numBars: best.numBars, barSize: best.barSize };
}

/** Build a full RebarLayout (with three stirrup zones) from percentages. */
export function seedRebar(section: SectionDimensions, opts: SeedOptions, code?: DesignCode | string): RebarLayout {
  const bw = section.bw ?? section.b;
  const stirrupBarSize = opts.stirrupBarSize ?? 4;
  const d = effectiveDepth({ ...section, stirrupDia: stirrupBarSize }, 8);

  const AsTop = (opts.rhoTopPct / 100) * bw * d;
  const AsBot = (opts.rhoBotPct / 100) * bw * d;

  const tieZones: [TieZone, TieZone, TieZone] = [
    { spacing: opts.stirrupSpacings[0] },
    { spacing: opts.stirrupSpacings[1] },
    { spacing: opts.stirrupSpacings[2] },
  ];

  // Code-based minimum skin reinforcement for deep beams (opt-in via wizard)
  const skin = opts.imposeSkinReinf && code
    ? minSkinReinforcement(section, code, opts.skinBarSize ?? 5)
    : undefined;

  return {
    topBars: [pickBars(AsTop, section, stirrupBarSize)],
    botBars: [pickBars(AsBot, section, stirrupBarSize)],
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
