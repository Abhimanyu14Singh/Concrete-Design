/**
 * The per-L/3 region cages: what the ⚑/◨ bar-count controls can actually reduce to,
 * and what the elevation drawing is handed.
 *
 * Two separate questions were confused in a bug report — "the elevation doesn't change"
 * (a wiring bug) and "I can't reduce the end-third bottom bars" (the code As,min floor,
 * working as intended). These pin both so neither is re-diagnosed as the other.
 */
import { describe, it, expect } from 'vitest';
import { continuousCage, minBarsForArea } from '../curtailment';
import { runDesign } from '../../engines';
import type { BarGroup, SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../types';

const material: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 };
const lc: LoadCase = { id: 'x', label: 'x', Mu_pos: 200, Mu_neg: 150, Vu: 60, Tu: 0, Pu: 0 };

const asMinOf = (section: SectionDimensions, rebar: RebarLayout) =>
  runDesign(section, material, rebar, lc, 24, 'ACI318-19').As_min;

/** SectionCard's `bumpEndBot('count', dir)` clamp, reproduced exactly. */
function bumpEndBotCount(
  botBars: BarGroup[], asMin: number, explicit: BarGroup[] | null, dir: 1 | -1,
): BarGroup {
  const cur = explicit?.[0] ?? continuousCage(botBars, asMin)[0];
  return { ...cur, numBars: Math.max(minBarsForArea(asMin, cur.barSize), cur.numBars + dir) };
}

/** MemberResults' elevation-region build, reproduced exactly. */
function elevRegions(rebar: RebarLayout, mid?: BarGroup[], opp?: BarGroup[], endBot?: BarGroup[]) {
  if (!mid?.length && !opp?.length && !endBot?.length) return undefined;
  const { topBars, botBars } = rebar;
  const eb = endBot?.length ? endBot : botBars;
  return [
    { title: 'Mark End', top: topBars, bot: eb },
    { title: 'Middle ⅓', top: mid?.length ? mid : topBars, bot: botBars },
    { title: 'Opp. End', top: opp?.length ? opp : topBars, bot: eb },
  ];
}

const section: SectionDimensions = { type: 'rectangular_beam', b: 20, h: 32, coverClear: 1.5, stirrupDia: 4 };
const rebar: RebarLayout = {
  topBars: [{ numBars: 4, barSize: 9 }],
  botBars: [{ numBars: 8, barSize: 9 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
};

describe('end-third bottom cage — the reduction floor is code As,min, not a lock', () => {
  it('reduces step by step down to the As,min floor, then holds', () => {
    const asMin = asMinOf(section, rebar);
    const floor = minBarsForArea(asMin, 9);
    let cur: BarGroup | null = null;
    const steps: number[] = [];
    for (let i = 0; i < 5; i++) { cur = bumpEndBotCount(rebar.botBars, asMin, cur ? [cur] : null, -1); steps.push(cur.numBars); }
    // Auto cage is ~50% of 8 bars = 4; it then walks down and parks on the floor.
    expect(steps[0]).toBeLessThan(8);
    expect(steps[steps.length - 1]).toBe(floor);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(floor);
  });

  it('a light cage is ALREADY at the floor, so −1 is legitimately a no-op', () => {
    const light: RebarLayout = { ...rebar, botBars: [{ numBars: 4, barSize: 8 }] };
    const lightSec: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 };
    const asMin = asMinOf(lightSec, light);
    const auto = continuousCage(light.botBars, asMin)[0].numBars;
    expect(auto).toBe(minBarsForArea(asMin, 8));            // nothing left to take out
    expect(bumpEndBotCount(light.botBars, asMin, null, -1).numBars).toBe(auto);
  });

  it('never drops below 2 bars, whatever the demand', () => {
    expect(minBarsForArea(0, 9)).toBe(2);
    expect(minBarsForArea(0.01, 18)).toBe(2);
  });
});

describe('elevation regions reflect the cages the engineer set', () => {
  it('is undefined when no region cage is set (plain single-cage drawing)', () => {
    expect(elevRegions(rebar)).toBeUndefined();
  });

  it('a reduced end-third bottom cage shows on BOTH end regions, not mid-span', () => {
    const endBot: BarGroup[] = [{ numBars: 3, barSize: 9 }];
    const r = elevRegions(rebar, undefined, undefined, endBot)!;
    expect(r[0].bot).toEqual(endBot);      // Mark End
    expect(r[2].bot).toEqual(endBot);      // Opp. End
    expect(r[1].bot).toEqual(rebar.botBars); // Middle ⅓ keeps the full cage
  });

  it('a reduced opposite-end top cage shows only on the opposite end', () => {
    const opp: BarGroup[] = [{ numBars: 2, barSize: 9 }];
    const r = elevRegions(rebar, undefined, opp, undefined)!;
    expect(r[2].top).toEqual(opp);
    expect(r[0].top).toEqual(rebar.topBars);
    expect(r[1].top).toEqual(rebar.topBars);
  });

  it('changing the bar count changes what the drawing is handed', () => {
    const before = elevRegions(rebar, undefined, undefined, [{ numBars: 4, barSize: 9 }])!;
    const after = elevRegions(rebar, undefined, undefined, [{ numBars: 3, barSize: 9 }])!;
    expect(before[0].bot[0].numBars).toBe(4);
    expect(after[0].bot[0].numBars).toBe(3);
  });
});
