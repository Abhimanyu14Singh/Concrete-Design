/**
 * suggestGroupRebar — picks the lightest *practical* rebar layout for a design
 * group that meets the group's worst demand at the target DCR.
 *
 * Approach: a **capacity-inversion search**, not a linear demand estimate. The
 * flexural capacity M_Rd is monotonically increasing in total steel area across
 * the whole practical range, so for each candidate bar size we enumerate the full
 * ladder of buildable layouts (1..MAX_LAYERS layers, area-ascending) and
 * BINARY-SEARCH the lightest rung whose *engine-computed* DCR ≤ target — exact,
 * because DCR is monotone in area. Shear is solved the same way over a
 * cost-ordered stirrup ladder (DCR_shear depends only on the link steel rate).
 * This replaces the old "linear As≈M/(0.9·d·f_y) seed + 5 correction retries",
 * which under-seeded and ran out of budget on heavily-loaded deep sections
 * (where the real lever arm collapses well below 0.9·d) and wrongly reported
 * "needs a larger section" for cages that a designer could clearly build.
 *
 * Guardrails: floors every face at As,min, and GATES at As,max (ρmax) so it never
 * proposes an over-reinforced / illegal cage — in that case, or when even the
 * richest catalog layout can't carry the demand (flexure) or the compression
 * strut governs (shear), it returns a specific, honest error naming the limit.
 *
 * Practical envelope (typical office detailing):
 *   longitudinal #5–#11 (EC2 Ø10–Ø32), 2–4 layers, ≥2 bars/layer, outer ≥ inner;
 *   stirrups #4/#5/#6 (EC2 Ø8/10/12), 2/3/4/6 legs, spacings {4,6,8,10,12} in
 *   (EC2 100–250 mm), zoned [end, mid, end] with the mid third relaxed when slack.
 */
import type { Member, RebarLayout, Project, DesignResults, LoadCase } from '../types';
import { runDesign } from '../engines';
import { getBarArea, getBarDiam } from './concreteDesign';
import { memberSteelWeightLb } from './autoGroup';
import { suggestColumnRebar, isColumnMember } from './suggestColumnRebar';
import { minSkinReinforcement } from '../adapters/etabs/rebarSeed';

const LONG_BAR_SIZES_US  = [5, 6, 7, 8, 9, 10, 11];
const LONG_BAR_SIZES_EC2 = [-10, -12, -16, -20, -25, -32];

// US stirrup candidates
const STIRRUP_SIZES_US       = [4, 5, 6];
const STIRRUP_SPACINGS_US    = [4, 6, 8, 10, 12]; // in

// EC2 stirrup candidates — Ø8, Ø10, Ø12 links; spacings 100/125/150/175/200/250 mm → in
const STIRRUP_SIZES_EC2      = [-8, -10, -12];
const STIRRUP_SPACINGS_EC2   = [100, 125, 150, 175, 200, 250].map(mm => mm / 25.4); // in

// Leg counts to try, fewest first: a single closed hoop (2), +1 crosstie (3),
// two hoops / a hoop + 2 crossties (4), then 6 for wide/heavily-loaded webs.
const STIRRUP_LEGS = [2, 3, 4, 6];

// Longitudinal layers allowed. 3–4 layers only appear when fewer can't hold the
// demand; a 4-layer cage pushes x/d up, which the engine flags (§5.5 / brittle).
const MAX_LAYERS = 4;

const EPS = 1e-6;

export interface SuggestResult {
  rebar: RebarLayout;
  worstDCRFlex: number;       // columns: governing P-M interaction DCR
  worstDCRShear: number;
  steelLb: number;           // total longitudinal steel for the group (lb)
  governingMemberId: string;
  /** 'column' when produced by the column auto-design path; 'beam'/undefined otherwise. */
  kind?: 'beam' | 'column';
  worstDCRAxial?: number;    // columns only — governing axial DCR
  rhoPct?: number;           // columns only — final longitudinal steel ratio (%)
}

export interface SuggestError { error: string }

export function isSuggestError(r: SuggestResult | SuggestError): r is SuggestError {
  return 'error' in r;
}

/** Max bars per layer that fit the web width with ≥ max(1", db) clear spacing. */
export function maxBarsPerLayer(member: Member, barSize: number): number {
  const db = getBarDiam(barSize);
  const bw = member.section.bw ?? member.section.b;
  const dStir = getBarDiam(member.section.stirrupDia);
  const clear = Math.max(1, db);
  const usable = bw - 2 * (member.section.coverClear + dStir);
  // n·db + (n−1)·clear ≤ usable → n ≤ (usable + clear) / (db + clear)
  return Math.max(0, Math.floor((usable + clear) / (db + clear)));
}

interface Rung {
  layers: { numBars: number; barSize: number }[];
  As: number;        // in²
  totalBars: number;
}

/**
 * Balanced split of `total` bars into the fewest layers that hold them, each layer
 * in [2, nMax] and non-increasing (outer ≥ inner). Returns null if `total` can't be
 * laid out that way (e.g. 3 bars into 2-per-layer webs).
 */
function layerSplit(total: number, nMax: number, maxLayers: number): number[] | null {
  const L = Math.ceil(total / nMax);
  if (L > maxLayers) return null;
  const base = Math.floor(total / L);
  const rem = total % L;
  const layers: number[] = [];
  for (let i = 0; i < L; i++) layers.push(base + (i < rem ? 1 : 0)); // first `rem` get +1 → non-increasing
  if (layers[L - 1] < 2 || layers[0] > nMax) return null;
  return layers;
}

/** Full ladder of one face's layouts at a fixed bar size, lightest (fewest bars) first. */
function faceLadder(size: number, nMax: number): Rung[] {
  if (nMax < 2) return [];
  const Ab = getBarArea(size);
  const out: Rung[] = [];
  for (let total = 2; total <= nMax * MAX_LAYERS; total++) {
    const split = layerSplit(total, nMax, MAX_LAYERS);
    if (!split) continue;
    out.push({ layers: split.map(n => ({ numBars: n, barSize: size })), As: total * Ab, totalBars: total });
  }
  return out; // area-ascending by construction
}

/** First index i in [0,n) where `pass(i)` is true, assuming pass is monotone false→true. -1 if none. */
function firstPassing(n: number, pass: (i: number) => boolean): number {
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pass(mid)) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

export function suggestGroupRebar(
  members: Member[],
  code: Project['code'],
  targetDCR = 0.9,
): SuggestResult | SuggestError {
  // Column groups use the dedicated column auto-design path (symmetric cage +
  // tie sizing against the P-M / axial / shear checks). Only fall through to the
  // beam path when the group has no loaded columns.
  const hasColumns = members.some(m => isColumnMember(m) && m.loads.length > 0);
  const beams = members.filter(m => m.memberType === 'beam' && m.loads.length > 0);
  if (hasColumns && !beams.length) {
    return suggestColumnRebar(members, code, targetDCR);
  }
  if (!beams.length) return { error: 'No designed beam members with loads in this group.' };

  const isEC2 = code === 'EN1992-1-1';
  const LONG_BAR_SIZES   = isEC2 ? LONG_BAR_SIZES_EC2   : LONG_BAR_SIZES_US;
  const STIRRUP_SIZES    = isEC2 ? STIRRUP_SIZES_EC2    : STIRRUP_SIZES_US;
  const STIRRUP_SPACINGS = isEC2 ? STIRRUP_SPACINGS_EC2 : STIRRUP_SPACINGS_US;

  // 1. One design pass per beam: surface hard errors up front, take the group's As,min
  //    floor / As,max cap, and record the governing member+LC for each action (worst
  //    hogging, sagging, shear). The binary searches below probe only these governing
  //    members — a single common cage on a same-section group is governed by the worst
  //    demand — and step 4 re-verifies the assembled cage on EVERY member × load case.
  let AsMinFloor = 0, AsMaxCap = Infinity;
  let governing: Member = beams[0], govScore = -1;
  let topGov = { m: beams[0], lc: beams[0].loads[0] };
  let botGov = topGov, shearGov = topGov;
  let topGovM = -Infinity, botGovM = -Infinity, shearGovV = -Infinity;
  for (const m of beams) {
    const negLC = m.loads.reduce((a, b) => (b.Mu_neg ?? 0) > (a.Mu_neg ?? 0) ? b : a);
    const posLC = m.loads.reduce((a, b) => (b.Mu_pos ?? 0) > (a.Mu_pos ?? 0) ? b : a);
    const vLC   = m.loads.reduce((a, b) => Math.abs(b.Vu ?? 0) > Math.abs(a.Vu ?? 0) ? b : a);
    if ((negLC.Mu_neg ?? 0) > topGovM)     { topGovM = negLC.Mu_neg ?? 0; topGov = { m, lc: negLC }; }
    if ((posLC.Mu_pos ?? 0) > botGovM)     { botGovM = posLC.Mu_pos ?? 0; botGov = { m, lc: posLC }; }
    if (Math.abs(vLC.Vu ?? 0) > shearGovV) { shearGovV = Math.abs(vLC.Vu ?? 0); shearGov = { m, lc: vLC }; }
    let r: DesignResults;
    try {
      r = runDesign(m.section, m.material, m.rebar, posLC, m.span, code, m.crackParams);
    } catch (e) {
      return { error: `Design failed for ${m.label}: ${(e as Error).message}` };
    }
    AsMinFloor = Math.max(AsMinFloor, r.As_min);
    AsMaxCap = Math.min(AsMaxCap, r.As_max);
    const score = Math.max(posLC.Mu_pos ?? 0, negLC.Mu_neg ?? 0);
    if (score > govScore) { govScore = score; governing = m; }
  }

  // Flexural DCR of the governing member for a trial cage. One face's DCR is
  // (near-)independent of the other face and of the stirrups, so the fixed "other"
  // rung / seed stirrup below never affects the probed number.
  const tieSeed = { barSize: STIRRUP_SIZES[0], spacing: STIRRUP_SPACINGS[Math.floor(STIRRUP_SPACINGS.length / 2)], legs: 2 };
  const probe = (m: Member, lc: LoadCase, top: Rung, bot: Rung): DesignResults | null => {
    try { return runDesign(m.section, m.material, { topBars: top.layers, botBars: bot.layers, ties: tieSeed }, lc, m.span, code, m.crackParams); }
    catch { return null; }
  };
  const worstFlexNeg = (top: Rung, bot: Rung): number => probe(topGov.m, topGov.lc, top, bot)?.DCR_flex_neg ?? Infinity;
  const worstFlexPos = (top: Rung, bot: Rung): number => probe(botGov.m, botGov.lc, top, bot)?.DCR_flex_pos ?? Infinity;

  // 2. Flexure: over every common bar size, binary-search each face for the lightest
  //    rung meeting As,min AND DCR ≤ target, then keep the size giving the lightest
  //    total steel. Minimising area is self-correcting on layer count — extra layers
  //    lower the effective depth and therefore RAISE the area needed — so the search
  //    naturally avoids gratuitous layers and tiny-bar pile-ups. Ties break to fewer
  //    layers, then smaller bars (better crack distribution).
  let chosen: { top: Rung; bot: Rung; combinedAs: number; layers: number } | null = null;
  let sawOverReinforced = false;
  for (const size of LONG_BAR_SIZES) {
    const nMax = Math.min(...beams.map(m => maxBarsPerLayer(m, size)));
    const ladder = faceLadder(size, nMax);
    if (ladder.length < 1) continue;
    // Fix the opposite face at the lightest rung while probing one face — a face's
    // flexural DCR is (near-)independent of the other, and the min rung is always a
    // valid, non-over-reinforced section (a huge opposite face can make runDesign
    // return NaN/throw). Conservative if the engine credits compression steel.
    const fixedOpp = ladder[0];
    const ti = firstPassing(ladder.length, i => ladder[i].As >= AsMinFloor - EPS && worstFlexNeg(ladder[i], fixedOpp) <= targetDCR + EPS);
    if (ti < 0) continue;
    const bi = firstPassing(ladder.length, i => ladder[i].As >= AsMinFloor - EPS && worstFlexPos(fixedOpp, ladder[i]) <= targetDCR + EPS);
    if (bi < 0) continue;
    // ρmax gate — refuse an over-reinforced (brittle / non-code) cage.
    if (ladder[ti].As > AsMaxCap + EPS || ladder[bi].As > AsMaxCap + EPS) { sawOverReinforced = true; continue; }
    const combinedAs = ladder[ti].As + ladder[bi].As;
    const layers = ladder[ti].layers.length + ladder[bi].layers.length;
    if (!chosen || combinedAs < chosen.combinedAs - EPS ||
        (Math.abs(combinedAs - chosen.combinedAs) <= EPS && layers < chosen.layers)) {
      chosen = { top: ladder[ti], bot: ladder[bi], combinedAs, layers };
    }
  }
  if (!chosen) {
    return { error: sawOverReinforced
      ? 'Flexure would exceed the maximum reinforcement ratio (ρmax / over-reinforced) — enlarge the section.'
      : 'Flexural demand exceeds the largest practical cage (up to #11/Ø32 in 4 layers) — enlarge the section.' };
  }
  const { top: chosenTop, bot: chosenBot } = chosen;

  // 3. Shear: cheapest stirrup layout (by steel rate) whose DCR_shear ≤ target, using
  //    the chosen flexural cage (so any bottom-steel contribution to V_c is included).
  //    DCR_shear depends only on the link steel rate (legs·Ab/s), so the rate-sorted
  //    ladder is monotone → binary-search the lightest passing rung.
  interface Tie { size: number; legs: number; spacing: number; rate: number; }
  const tieRungs: Tie[] = [];
  for (const size of STIRRUP_SIZES)
    for (const legs of STIRRUP_LEGS)
      for (const spacing of STIRRUP_SPACINGS)
        tieRungs.push({ size, legs, spacing, rate: legs * getBarArea(size) / spacing });
  tieRungs.sort((a, b) => a.rate - b.rate || a.legs - b.legs || b.spacing - a.spacing || Math.abs(a.size) - Math.abs(b.size));

  const shearDCR = (tie: Tie, zones: { spacing: number }[]): number => {
    try {
      return runDesign(shearGov.m.section, shearGov.m.material, {
        topBars: chosenTop.layers, botBars: chosenBot.layers,
        ties: { barSize: tie.size, spacing: tie.spacing, legs: tie.legs },
        tieZones: zones as RebarLayout['tieZones'],
      }, shearGov.lc, shearGov.m.span, code, shearGov.m.crackParams).DCR_shear;
    } catch { return Infinity; }
  };
  const uniform = (t: Tie) => [{ spacing: t.spacing }, { spacing: t.spacing }, { spacing: t.spacing }];
  const si = firstPassing(tieRungs.length, i => shearDCR(tieRungs[i], uniform(tieRungs[i])) <= targetDCR + EPS);
  if (si < 0) {
    // Even the richest catalog layout fails → the section/strut governs, not the links.
    return { error: isEC2
      ? "Shear: compression strut V_Rd,max exceeded — widen the web or raise f_ck (more links won't help)."
      : "Shear: section capacity (V_c + max V_s) exceeded — widen the web or raise f′c (more links won't help)." };
  }
  const chosenTie = tieRungs[si];
  // Relax the middle third one increment when there's slack (nicer, lighter cage).
  let zones = uniform(chosenTie);
  const spIdx = STIRRUP_SPACINGS.findIndex(s => Math.abs(s - chosenTie.spacing) < 1e-9);
  if (spIdx >= 0 && spIdx < STIRRUP_SPACINGS.length - 1) {
    const relaxed = [{ spacing: chosenTie.spacing }, { spacing: STIRRUP_SPACINGS[spIdx + 1] }, { spacing: chosenTie.spacing }];
    if (shearDCR(chosenTie, relaxed) <= targetDCR + EPS) zones = relaxed;
  }

  // 4. Assemble + verify the full cage on EVERY member × EVERY load case (catches
  //    mixed-section groups a single-member design would miss).
  const cage: RebarLayout = {
    topBars: chosenTop.layers,
    botBars: chosenBot.layers,
    ties: { barSize: chosenTie.size, spacing: chosenTie.spacing, legs: chosenTie.legs },
    tieZones: zones as RebarLayout['tieZones'],
  };
  let worstFlex = 0, worstShearFinal = 0;
  for (const m of beams) {
    for (const lc of m.loads) {
      let r: DesignResults;
      try { r = runDesign(m.section, m.material, cage, lc, m.span, code, m.crackParams); }
      catch (e) { return { error: `Verification failed for ${m.label}: ${(e as Error).message}` }; }
      worstFlex = Math.max(worstFlex, r.DCR_flex_pos, r.DCR_flex_neg);
      worstShearFinal = Math.max(worstShearFinal, r.DCR_shear);
    }
  }
  if (worstFlex > targetDCR + EPS || worstShearFinal > targetDCR + EPS) {
    return { error: 'Could not satisfy every member with one common cage at the target — check for mixed sections in this group.' };
  }

  // Longitudinal steel weight for the group (governing per-member length).
  const steelLb = beams.reduce((s, m) => {
    const len = m.etabs?.pt1 && m.etabs?.pt2
      ? Math.hypot(m.etabs.pt2.x - m.etabs.pt1.x, m.etabs.pt2.y - m.etabs.pt1.y, m.etabs.pt2.z - m.etabs.pt1.z)
      : (m.span ?? 20);
    return s + memberSteelWeightLb(chosenTop.As + chosenBot.As, len);
  }, 0);

  // Deep beams (ACI §9.7.2.3 / EC2 §7.3.3): add code-based skin/side bars (per face).
  // Side bars don't change flex/shear DCR, so no re-verify. For EC2 the count is
  // area-driven (As,min = kc·k·fct·Act/σs), so pass the section's fck (MPa).
  const skin = minSkinReinforcement(governing.section, code, isEC2 ? -12 : 5,
    isEC2 ? { fckMPa: governing.material.fc * 0.00689476 } : undefined);

  return {
    rebar: skin ? { ...cage, sideBars: [skin] } : cage,
    worstDCRFlex: worstFlex,
    worstDCRShear: worstShearFinal,
    steelLb,
    governingMemberId: governing.id,
  };
}
