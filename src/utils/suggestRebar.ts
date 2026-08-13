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
 *   longitudinal #5–#11 (EC2 Ø10–Ø32), up to 3 layers, ≥2 bars/layer, outer ≥ inner;
 *   stirrups #4/#5/#6 (EC2 Ø8/10/12), 2/3/4/6 legs, spacings {4,6,8,10,12} in
 *   (EC2 100–250 mm), zoned [end, mid, end] with the mid third relaxed when slack.
 */
import type { Member, RebarLayout, Project, DesignResults, DesignWarning, LoadCase, BarGroup } from '../types';
import type { BarFamily } from '../types';
import { runDesign } from '../engines';
import { getBarArea, getBarDiam, zoneIndexAtX } from './concreteDesign';
import { memberSteelWeightLb } from './autoGroup';
import { minSkinReinforcement } from '../adapters/etabs/rebarSeed';
import { isSkinWarning } from './skinReinforcement';

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

// Skin / face-reinforcement candidates, smallest first. Escalation raises the
// COUNT at one size before stepping the size up: more, smaller bars is the better
// crack-control detail, and EC2 Table 7.2N pays for it directly (a smaller bar is
// allowed a higher steel stress, so it needs less area to satisfy §7.3.3).
const SKIN_BAR_SIZES_US  = [5, 6, 7];
const SKIN_BAR_SIZES_EC2 = [-12, -16, -20];
// Detailing cap per face. Past this the answer is a different section, not more
// face bars — a web that still cracks with 10 bars a side is not a rebar problem.
const MAX_SKIN_PER_FACE = 10;

const KIP_TO_N   = 4448.22;
const PSI_TO_MPA = 0.00689476;

// Longitudinal layers allowed. A 3rd layer only appears when 1–2 can't hold the
// demand; a deep cage pushes x/d up, which the engine flags (§5.5 / brittle).
// 3 is the practical detailing cap — beyond it, enlarge the section instead.
const MAX_LAYERS = 3;

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

export interface SuggestError {
  error: string;
  /**
   * Why the suggestion could not be made, for callers that need to act on the reason
   * rather than print it.
   *
   * `'section-limit'` is the one worth distinguishing: the combined shear + torsion
   * cross-section check (ACI §22.7.7.1 / EC2 §6.3.2) caps the diagonal compression in
   * the CONCRETE, so it is not a cage that is missing — no arrangement of links or bars
   * satisfies it and the only fix is a bigger section. Every other failure is a cage the
   * search could not find within its ladders, which is a different conversation.
   *
   * Left undefined for those others, so this stays additive: a caller that ignores it
   * behaves exactly as before.
   */
  kind?: 'section-limit';
  /** The member the refusal is about, when one beam in the group caused it. */
  at?: string;
}

/**
 * Optional user-supplied minimum bar sizes ("use this size or larger"), collected
 * by the Suggest size-floor dialog. Sizes compare by DIAMETER (|size|): US #5<#6…,
 * EC2 Ø10<Ø12…. Top and bottom share one longitudinal size (constructability), so
 * the effective longitudinal floor is the larger of minTopBar / minBotBar. Any
 * field left undefined imposes no floor on that action.
 */
export interface SuggestFloors {
  minTopBar?: number;
  minBotBar?: number;
  minStirrup?: number;
}

export function isSuggestError(r: SuggestResult | SuggestError): r is SuggestError {
  return 'error' in r;
}

/**
 * Practical Suggest candidate sizes for a design code, smallest→largest by
 * diameter. The Suggest size-floor dialog offers these; suggestGroupRebar()
 * searches them. Longitudinal US #5–#11 / EC2 Ø10–Ø32; stirrups US #4–#6 /
 * EC2 Ø8–Ø12. (Encoding: US = positive #, EC2 = negative Ø mm.)
 */
export function suggestSizeCandidates(
  code: Project['code'], family?: BarFamily,
): { long: number[]; stirrup: number[] } {
  // The catalogue is the project's BAR FAMILY, not the design code: an ACI job
  // detailed in metric bars must be offered metric bars. Falls back to the
  // code's own convention when no family is supplied.
  const euro = (family ?? (code === 'EN1992-1-1' ? 'euro' : 'us')) === 'euro';
  return {
    long: euro ? LONG_BAR_SIZES_EC2 : LONG_BAR_SIZES_US,
    stirrup: euro ? STIRRUP_SIZES_EC2 : STIRRUP_SIZES_US,
  };
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
  floors?: SuggestFloors,
  family?: BarFamily,
  /** EC2 §6.2.3 strut angle, and the project's "neglect torsion" setting. Both are
   *  handed straight to `runDesign`, so the cage is sized against the SAME checks the
   *  member panel will run. Omitting `ignoreTorsion` designs for torsion, which is the
   *  safe default — but a project that neglects it would then get links it never
   *  needed, so callers with a `project` in hand should pass both. */
  cotTheta?: number,
  ignoreTorsion?: boolean,
): SuggestResult | SuggestError {
  // Column groups use the dedicated column auto-design path (symmetric cage +
  // tie sizing against the P-M / axial / shear checks). Only fall through to the
  // beam path when the group has no loaded columns.
  const beams = members.filter(m => m.loads.length > 0);
  if (!beams.length) return { error: 'No designed beam members with loads in this group.' };

  const isEC2 = code === 'EN1992-1-1';
  // Bar catalogue follows the project's family; spacing ladders stay with the code.
  const euroBars = (family ?? (isEC2 ? 'euro' : 'us')) === 'euro';
  // Optional "use this size or larger" floors from the Suggest dialog. Sizes
  // compare by diameter (|size|). Top and bottom share one longitudinal size, so
  // the effective longitudinal floor is the larger of the two requested face
  // minimums. Undefined → 0 → the full practical ladder (identical to the
  // unconstrained search, so the default suggestion is unchanged).
  const longFloorMag = Math.max(
    floors?.minTopBar ? Math.abs(floors.minTopBar) : 0,
    floors?.minBotBar ? Math.abs(floors.minBotBar) : 0,
  );
  const stirrupFloorMag = floors?.minStirrup ? Math.abs(floors.minStirrup) : 0;
  const LONG_BAR_SIZES   = (euroBars ? LONG_BAR_SIZES_EC2 : LONG_BAR_SIZES_US).filter(s => Math.abs(s) >= longFloorMag);
  const STIRRUP_SIZES    = (euroBars ? STIRRUP_SIZES_EC2  : STIRRUP_SIZES_US ).filter(s => Math.abs(s) >= stirrupFloorMag);
  const STIRRUP_SPACINGS = isEC2 ? STIRRUP_SPACINGS_EC2 : STIRRUP_SPACINGS_US;
  if (!LONG_BAR_SIZES.length) return { error: 'No longitudinal bar size at or above the requested minimum is available — lower the bar-size floor.' };
  if (!STIRRUP_SIZES.length)  return { error: 'No stirrup size at or above the requested minimum is available — lower the stirrup-size floor.' };

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
  // Worst shear demand sitting in the MIDDLE third specifically. The global shear
  // governor is always an end station, so probing a relaxed middle zone against it
  // measures nothing — capacity is now read at the demand's own zone, so the
  // relaxation always "passed" and was then rejected by the group verification
  // loop with a misleading mixed-sections error.
  let midGov: { m: Member; lc: LoadCase } | null = null;
  let midGovV = -Infinity;
  // Torsion's own governor. φTn = φ·2·A_o·(A_t/s)·f_yt rises with the PER-LEG rate
  // (A_b/s) and is flat in leg count, so the rung that answers shear most cheaply is
  // usually the wrong one for torsion — it buys capacity with legs. Different lever,
  // different governor. Skipped entirely when the project neglects torsion.
  let torsGov: { m: Member; lc: LoadCase } | null = null;
  let torsGovT = 0;
  for (const m of beams) {
    const negLC = m.loads.reduce((a, b) => (b.Mu_neg ?? 0) > (a.Mu_neg ?? 0) ? b : a);
    const posLC = m.loads.reduce((a, b) => (b.Mu_pos ?? 0) > (a.Mu_pos ?? 0) ? b : a);
    const vLC   = m.loads.reduce((a, b) => Math.abs(b.Vu ?? 0) > Math.abs(a.Vu ?? 0) ? b : a);
    for (const lc of m.loads) {
      if (!ignoreTorsion && (lc.Tu ?? 0) > torsGovT) { torsGovT = lc.Tu ?? 0; torsGov = { m, lc }; }
      if (lc.x === undefined || !m.span || !(m.span > 0)) continue;
      if (zoneIndexAtX(lc.x, m.span) !== 1) continue;
      if (Math.abs(lc.Vu ?? 0) > midGovV) { midGovV = Math.abs(lc.Vu ?? 0); midGov = { m, lc }; }
    }
    if ((negLC.Mu_neg ?? 0) > topGovM)     { topGovM = negLC.Mu_neg ?? 0; topGov = { m, lc: negLC }; }
    if ((posLC.Mu_pos ?? 0) > botGovM)     { botGovM = posLC.Mu_pos ?? 0; botGov = { m, lc: posLC }; }
    if (Math.abs(vLC.Vu ?? 0) > shearGovV) { shearGovV = Math.abs(vLC.Vu ?? 0); shearGov = { m, lc: vLC }; }
    let r: DesignResults;
    try {
      r = runDesign(m.section, m.material, m.rebar, posLC, m.span, code, m.crackParams, cotTheta, ignoreTorsion);
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
    try { return runDesign(m.section, m.material, { topBars: top.layers, botBars: bot.layers, ties: tieSeed }, lc, m.span, code, m.crackParams, cotTheta, ignoreTorsion); }
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
      : 'Flexural demand exceeds the largest practical cage (up to #11/Ø32 in 3 layers) — enlarge the section.' };
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

  const designAt = (at: { m: Member; lc: LoadCase }, tie: Tie, zones: { spacing: number }[]): DesignResults | null => {
    try {
      return runDesign(at.m.section, at.m.material, {
        topBars: chosenTop.layers, botBars: chosenBot.layers,
        ties: { barSize: tie.size, spacing: tie.spacing, legs: tie.legs },
        tieZones: zones as RebarLayout['tieZones'],
      }, at.lc, at.m.span, code, at.m.crackParams, cotTheta, ignoreTorsion);
    } catch { return null; }
  };
  const shearDCRAt = (at: { m: Member; lc: LoadCase }, tie: Tie, zones: { spacing: number }[]): number =>
    designAt(at, tie, zones)?.DCR_shear ?? Infinity;
  const torsDCRAt = (at: { m: Member; lc: LoadCase }, tie: Tie, zones: { spacing: number }[]): number =>
    designAt(at, tie, zones)?.DCR_torsion ?? Infinity;
  const shearDCR = (tie: Tie, zones: { spacing: number }[]): number => shearDCRAt(shearGov, tie, zones);
  const uniform = (t: Tie) => [{ spacing: t.spacing }, { spacing: t.spacing }, { spacing: t.spacing }];

  // ── The torsion floor on the PER-LEG rate ───────────────────────────────────
  //
  // Shear and torsion climb different ladders out of the same catalogue:
  //
  //     V:  φVs ∝ legs · A_b / s     T:  φTn = φ·2·A_o·(A_b/s)·f_yt   — no legs
  //
  // The rate-ordered search answers shear as cheaply as possible, and the cheapest
  // way to raise legs·A_b/s is usually to ADD A LEG — which leaves A_t/s untouched
  // and torsion exactly where it was. That is why a spandrel came back at DCR_T =
  // 1.16 with every other check comfortably on target: nothing in the search was
  // ever asked about torsion.
  //
  // It cannot simply join the shear predicate either: DCR_torsion is not monotone
  // along the rate order (4-leg #4@12 outranks 2-leg #5@6 on rate but is weaker in
  // torsion), so the binary search would return a wrong answer rather than a
  // conservative one. So torsion gets its own monotone ladder — the distinct
  // per-leg rates, ascending — searched for the smallest that carries it. The shear
  // search then runs over the rungs at or above that floor, where it is monotone
  // again and cheapest-passing still means cheapest.
  const perLegRate = (t: Tie) => getBarArea(t.size) / t.spacing;
  const legLadder = [...new Set(tieRungs.map(perLegRate))].sort((a, b) => a - b)
    // One representative rung per rate — fewest legs, since legs don't affect φTn.
    .map(rate => tieRungs.filter(t => Math.abs(perLegRate(t) - rate) < 1e-12)
      .sort((a, b) => a.legs - b.legs)[0]);

  let legFloor = 0;   // required A_b/s per leg; 0 = torsion not in play
  if (torsGov) {
    // Judged on UNIFORM zones: φTn is read at the loosest zone, so a relaxation can
    // only weaken it, and `zonesFor` re-checks torsion before accepting one.
    const k = firstPassing(legLadder.length, i => torsDCRAt(torsGov!, legLadder[i], uniform(legLadder[i])) <= targetDCR + EPS);
    if (k < 0) {
      return { error: `Torsion: T_u = ${torsGovT.toFixed(1)} kip-ft exceeds what closed links can carry on this section — φT_n = φ·2A_o·(A_t/s)·f_yt tops out below it at the tightest practical link (${isEC2 ? 'Ø12 @ 100 mm' : '#6 @ 4 in'}). Enlarge the section; more legs do not raise torsional capacity.` };
    }
    legFloor = perLegRate(legLadder[k]);
  }

  /** Lightest rung meeting DCR_shear within `cap`, at or above the torsion floor. */
  const lightestPassing = (cap: number): number => {
    // Both filters leave the survivors in rate order, so DCR_shear is still monotone
    // across them and the binary search stays exact.
    const idx = tieRungs.map((_, i) => i)
      .filter(i => tieRungs[i].spacing <= cap + EPS && perLegRate(tieRungs[i]) >= legFloor - EPS);
    const k = firstPassing(idx.length, j => shearDCR(tieRungs[idx[j]], uniform(tieRungs[idx[j]])) <= targetDCR + EPS);
    return k < 0 ? -1 : idx[k];
  };

  /** Zones for a rung: middle third relaxed one increment when there's slack for it. */
  const zonesFor = (tie: Tie, cap: number): { spacing: number }[] => {
    const spIdx = STIRRUP_SPACINGS.findIndex(s => Math.abs(s - tie.spacing) < 1e-9);
    if (spIdx < 0 || spIdx >= STIRRUP_SPACINGS.length - 1) return uniform(tie);
    const mid = STIRRUP_SPACINGS[spIdx + 1];
    if (mid > cap + EPS) return uniform(tie);   // the relaxation is what breaks s_max first
    const relaxed = [{ spacing: tie.spacing }, { spacing: mid }, { spacing: tie.spacing }];
    // Judge the relaxed middle zone against a demand that actually acts there.
    // With no located mid-span row we cannot prove the relaxation is safe, so
    // keep the uniform cage rather than accept it blind.
    const relaxOK = midGov ? shearDCRAt(midGov, tie, relaxed) <= targetDCR + EPS : false;
    // Torsion capacity is read at the LOOSEST zone, so a relaxation that saves a few
    // stirrups can hand back the torsion margin the floor above just bought.
    const torsOK = !torsGov || torsDCRAt(torsGov, tie, relaxed) <= targetDCR + EPS;
    return relaxOK && torsOK && shearDCR(tie, relaxed) <= targetDCR + EPS ? relaxed : uniform(tie);
  };

  const si = lightestPassing(Infinity);
  if (si < 0) {
    // Even the richest catalog layout fails → the section/strut governs, not the links.
    return { error: isEC2
      ? "Shear: compression strut V_Rd,max exceeded — widen the web or raise f_ck (more links won't help)."
      : "Shear: section capacity (V_c + max V_s) exceeded — widen the web or raise f′c (more links won't help)." };
  }

  // 4. Assemble + verify the full cage on EVERY member × EVERY load case (catches
  //    mixed-section groups a single-member design would miss), and read the code's
  //    STIRRUP-SPACING verdict off the same sweep.
  //
  //    Capacity is not the whole story for links. §9.7.6.2.2 caps the spacing at d/2
  //    — d/4 under heavy shear, where it is an ERROR, not a warning — and §9.7.6.3.3
  //    at Ph/8 once torsion is being designed for; EC2's §9.2.2 s_max = 0.75d and
  //    ρw,min are the same shape of rule. A rung can clear DCR_shear comfortably and
  //    break every one of them, because a wide spacing with a fat bar carries the same
  //    Av/s as a close spacing with a thin one, and the ladder is ordered on that rate.
  //    Worse, all of these judge the LOOSEST zone, so it is usually the relaxed middle
  //    third that trips them.
  //
  //    So the spacing is capped and the cap ratchets down until the engine stops
  //    complaining. Asking the engine beats re-deriving d_detail, the heavy-shear
  //    threshold and Ph here — those live in the engine and a copy would drift.
  const SPACING_CODES = new Set([
    'ACI §9.7.6.2.2',   // shear spacing, d/2 (d/4 heavy)
    'ACI §9.7.6.3.3',   // torsion spacing, Ph/8
    'EC2 §9.2.2(6)',    // s_max = 0.75d
    'EC2 §9.2.2(5)',    // ρw,min — met by tightening s, same lever
  ]);
  interface Sweep {
    worstFlex: number; worstShear: number; worstTors: number;
    spacing: DesignWarning | null; crushing: { w: DesignWarning; at: string } | null; failure?: string;
  }
  const sweep = (trial: RebarLayout): Sweep => {
    const out: Sweep = { worstFlex: 0, worstShear: 0, worstTors: 0, spacing: null, crushing: null };
    for (const m of beams) {
      for (const lc of m.loads) {
        let r: DesignResults;
        try { r = runDesign(m.section, m.material, trial, lc, m.span, code, m.crackParams, cotTheta, ignoreTorsion); }
        catch (e) { return { ...out, failure: `Verification failed for ${m.label}: ${(e as Error).message}` }; }
        out.worstFlex = Math.max(out.worstFlex, r.DCR_flex_pos, r.DCR_flex_neg);
        out.worstShear = Math.max(out.worstShear, r.DCR_shear);
        out.worstTors = Math.max(out.worstTors, r.DCR_torsion ?? 0);
        for (const w of r.warnings) {
          // An error-severity violation outranks a warning-severity one: it is the
          // one worth failing the suggestion over if no spacing can satisfy it.
          if (SPACING_CODES.has(w.code) && (!out.spacing || (w.severity === 'error' && out.spacing.severity !== 'error')))
            out.spacing = w;
          // Combined shear + torsion crushing. A section limit, not a cage one — the
          // engine's own message says "more stirrups will not help", so climbing the
          // ladder against it would just burn steel and still fail.
          if (w.severity === 'error' && (w.code === 'ACI §22.7.7.1' || w.code === 'EC2 §6.3.2'))
            out.crushing ??= { w, at: m.label };
        }
      }
    }
    return out;
  };

  const buildCage = (tie: Tie, zones: { spacing: number }[]): RebarLayout => ({
    topBars: chosenTop.layers,
    botBars: chosenBot.layers,
    ties: { barSize: tie.size, spacing: tie.spacing, legs: tie.legs },
    tieZones: zones as RebarLayout['tieZones'],
  });

  let chosenTie = tieRungs[si];
  let zones = zonesFor(chosenTie, Infinity);
  let cage = buildCage(chosenTie, zones);
  let check = sweep(cage);
  if (check.failure) return { error: check.failure };

  // Ratchet. Two knobs, both driven by what the engine actually reported on the cage
  // just assembled, and both bounded by their own ladder so this always terminates:
  //   spacing  — cap one increment below the loosest zone that drew a detailing
  //              complaint (§9.7.6.2.2 / §9.7.6.3.3 / EC2 §9.2.2);
  //   torsion  — raise the per-leg floor one rung when a member OTHER than the
  //              torsion governor is still over (mixed sections: the biggest T_u is
  //              not always on the smallest A_o).
  const maxRounds = STIRRUP_SPACINGS.length + legLadder.length;
  for (let round = 0; round < maxRounds; round++) {
    if (check.crushing) break;                    // section limit; links can't fix it
    const needSpacing = !!check.spacing;
    const needTorsion = check.worstTors > targetDCR + EPS;
    if (!needSpacing && !needTorsion) break;

    let cap = Math.max(...zones.map(z => z.spacing));
    if (needSpacing) {
      const tighter = [...STIRRUP_SPACINGS].sort((a, b) => b - a).find(s => s < cap - EPS);
      if (tighter === undefined && !needTorsion) break;   // already at the tightest we detail
      if (tighter !== undefined) cap = tighter;
    }
    if (needTorsion) {
      const next = legLadder.map(perLegRate).find(r => r > legFloor + EPS);
      if (next === undefined && !needSpacing) break;      // richest per-leg rung already
      if (next !== undefined) legFloor = next;
    }
    const i = lightestPassing(cap);
    if (i < 0) break;                             // a legal rung exists but can't carry V
    chosenTie = tieRungs[i];
    zones = zonesFor(chosenTie, cap);
    cage = buildCage(chosenTie, zones);
    check = sweep(cage);
    if (check.failure) return { error: check.failure };
  }

  // Hard stops, each naming the limit rather than handing back a cage that opens NG.
  if (check.crushing) {
    return {
      error: `Shear + torsion on ${check.crushing.at}: ${check.crushing.w.message}`,
      kind: 'section-limit',
      at: check.crushing.at,
    };
  }
  // Nothing in the practical ladder satisfies a HARD spacing limit ⇒ the section is the
  // problem. A warning-severity limit left standing (torsion Ph/8, ρw,min) keeps its
  // cage: it is a flag for the engineer, not a reason to refuse to suggest anything.
  if (check.spacing?.severity === 'error') {
    return { error: `Stirrup spacing: ${check.spacing.message} — no spacing in the practical ladder (${STIRRUP_SPACINGS.map(s => (isEC2 ? `${Math.round(s * 25.4)} mm` : `${s}"`)).join(', ')}) satisfies it. Deepen the section or widen the web.` };
  }
  if (check.worstTors > targetDCR + EPS) {
    return { error: `Torsion: DCR ${check.worstTors.toFixed(2)} > ${targetDCR} with the tightest practical links. φT_n rises only with A_t/s (bar area per leg ÷ spacing) — leg count does not help — so this needs a bigger section, not a bigger cage.` };
  }
  const { worstFlex, worstShear: worstShearFinal } = check;
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

  // 5. Skin / face reinforcement — ACI §9.7.2.3 (h > 36 in) and EC2 §7.3.3(3) +
  //    §7.3.2(2) (h > 1000 mm). Side bars change neither the flexural nor the shear
  //    DCR, which is why this can run after the cage is fixed without re-doing step
  //    4 — but it is not optional trim: on a deep web the engine warns until the
  //    face steel is there, and a suggestion that hands back a standing warning has
  //    not finished the job. The whole point of Suggest on a deep beam is to come
  //    back with a face reinforcement the engineer can proceed with.
  //
  //    Seeded from the code minimum, then VERIFIED against the engine and escalated
  //    until every member is quiet. Each part of that earns its place:
  //      • the seed is the worst requirement across the WHOLE group, because DEPTH
  //        triggers the rule and the deepest member is often not the moment-
  //        governing one this used to size on;
  //      • it is fed each member's real f_ck, worst axial N_Ed and the project's own
  //        face crack limit — the three inputs the engine checks with. Assuming pure
  //        bending and w_k = 0.3 mm under-provides on a tension member or a 0.2 mm
  //        project (Table 7.2N gives Ø12 σ_s = 240 MPa there, not 280 → ~17 % more
  //        steel), and the warning stayed up;
  //      • §7.3.4's crack-WIDTH warning is load-driven and has no closed form to seed
  //        from, so the only way to know it is satisfied is to ask the engine.
  const skinSizes = euroBars ? SKIN_BAR_SIZES_EC2 : SKIN_BAR_SIZES_US;
  /** The code minimum for ONE member at `size`, bars per face; 0 = rule doesn't apply. */
  const skinSeedFor = (m: Member, size: number): number => {
    // Worst axial across the member's rows — most TENSILE governs, since tension
    // grows A_ct and k_c and therefore As,min. Pu is compression-positive.
    const worstAxialKips = m.loads.reduce((lo, lc) => Math.min(lo, lc.Pu ?? 0), 0);
    return minSkinReinforcement(m.section, code, size, {
      fckMPa: m.material.fc * PSI_TO_MPA,
      NEd_N: worstAxialKips * KIP_TO_N,
      wLimitFace: m.crackParams?.wLimitFace,
      fyPsi: m.material.fy,
    })?.numBars ?? 0;
  };

  const deep = beams.filter(m => skinSeedFor(m, skinSizes[0]) > 0);
  let skin: BarGroup | undefined;
  if (deep.length) {
    /** What the engine says about one face cage, across every deep member × row. */
    const judge = (side: BarGroup): { flagged: boolean; crowded: boolean } => {
      let flagged = false, crowded = false;
      for (const m of deep) {
        for (const lc of m.loads) {
          let r: DesignResults;
          // A member the engine cannot design at all is step 4's problem, not this
          // loop's — swallowing it here keeps one bad row from escalating the whole
          // group's face steel to the cap.
          try { r = runDesign(m.section, m.material, { ...cage, sideBars: [side] }, lc, m.span, code, m.crackParams, cotTheta, ignoreTorsion); }
          catch { continue; }
          for (const w of r.warnings) {
            if (isSkinWarning(w)) flagged = true;
            // §8.2 clear spacing on the side face. Adding bars to satisfy a crack
            // rule can violate a detailing rule, and trading one error for another
            // is not a suggestion — so a crowded cage is never accepted, and the
            // ladder stops climbing at that size (more bars only crowd it further).
            else if (w.code === 'EC2 §8.2' && /^Side face/.test(w.message)) crowded = true;
          }
        }
      }
      return { flagged, crowded };
    };

    // Fallback when nothing in the ladder silences the engine: the CODE MINIMUM at
    // the smallest bar, not the richest thing tried. If 10 bars a side still crack,
    // proposing 10 bars a side is a worse answer than the minimum plus the warning
    // that tells the engineer to change the section.
    let codeMin: BarGroup | undefined;
    outer:
    for (const size of skinSizes) {
      const seed = Math.max(1, ...deep.map(m => skinSeedFor(m, size)));
      codeMin ??= { numBars: seed, barSize: size };
      for (let n = seed; n <= MAX_SKIN_PER_FACE; n++) {
        const cand: BarGroup = { numBars: n, barSize: size };
        const { flagged, crowded } = judge(cand);
        if (crowded) break;                              // next bar size
        if (!flagged) { skin = cand; break outer; }
      }
    }
    skin ??= codeMin;
  }

  return {
    rebar: skin ? { ...cage, sideBars: [skin] } : cage,
    worstDCRFlex: worstFlex,
    worstDCRShear: worstShearFinal,
    steelLb,
    governingMemberId: governing.id,
  };
}
