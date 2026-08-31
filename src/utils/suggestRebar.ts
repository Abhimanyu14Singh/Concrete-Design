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
import { DEFAULT_CRACK_PARAMS } from '../types';
import type { BarFamily } from '../types';
import { runDesign } from '../engines';
import { coverFor, getBarArea, getBarDiam, steelLimits, zoneIndexAtX } from './concreteDesign';
import { memberSteelWeightLb } from './autoGroup';
import { minSkinReinforcement } from '../adapters/etabs/rebarSeed';
import { isSkinWarning } from './skinReinforcement';
import { resolveCrack } from './resolveCrack';

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

/**
 * Is torsion actually being DESIGNED for on this row, or is it under the threshold the
 * code lets you neglect it below? (ACI §22.7.1 φ·T_th, EC2 §6.3.1 T_Rd,c — both are
 * reported as `Tu_threshold`, in kip-ft like `LoadCase.Tu`.)
 *
 * It matters to the search because below that line `DCR_torsion` stops being a statement
 * about the links — see `torsDCRAt`.
 */
function torsionDesignedFor(r: DesignResults, lc: LoadCase): boolean {
  return (lc.Tu ?? 0) > (r.Tu_threshold ?? 0);
}

// Longitudinal layers allowed. A 3rd layer only appears when 1–2 can't hold the
// demand; a deep cage pushes x/d up, which the engine flags (§5.5 / brittle).
// 3 is the practical detailing cap — beyond it, enlarge the section instead.
const MAX_LAYERS = 3;

const EPS = 1e-6;

/** A successful suggestion: the cage, plus the DCRs and the member that governed it —
 *  so the user can see WHY this cage, not just what it is. */
export interface SuggestResult {
  rebar: RebarLayout;
  worstDCRFlex: number;       // columns: governing P-M interaction DCR
  /** Worst EC2 SLS crack-width DCR the suggested cage leaves. Undefined under ACI,
   *  which has no equivalent check. The search now CONSTRAINS this rather than
   *  ignoring it, so it should be ≤ 1 — it is reported so a caller can say so. */
  worstDCRCrack?: number;
  worstDCRShear: number;
  steelLb: number;           // total longitudinal steel for the group (lb)
  governingMemberId: string;
  /** 'column' when produced by the column auto-design path; 'beam'/undefined otherwise. */
  kind?: 'beam' | 'column';
  worstDCRAxial?: number;    // columns only — governing axial DCR
  rhoPct?: number;           // columns only — final longitudinal steel ratio (%)
  /**
   * The cage CARRIES the moment but exceeds ρmax — it is over-reinforced, and would
   * fail in the brittle mode the limit exists to prevent.
   *
   * Set only when no compliant cage exists at all: the search prefers a legal cage,
   * then a legal doubly-reinforced one, and produces this only if neither is available.
   * It is offered rather than withheld because the number is worth seeing — how far past
   * the line a section sits is what tells you whether it needs a bar size or a redesign
   * — but a caller that shows the cage MUST show this too. The DCR beside it is a
   * strength ratio and says nothing about ductility, so on its own it reads like a pass.
   */
  overReinforced?: boolean;
  /**
   * What the engine STILL says about the cage being handed back — one entry per clause,
   * worst severity kept, the row's numbers taken from the worst row. Omitted entirely on
   * a clean suggestion, so `if (r.residualWarnings)` reads as "this needs saying".
   *
   * The search resolves what a cage CAN resolve: strength, link spacing and legs, bar
   * fit across the web, the gap between layers, skin steel. What survives is what no
   * cage fixes — a section at its shear-crushing limit, a ρmax relaxation taken
   * deliberately — and it belongs in front of the engineer at the moment of the
   * suggestion rather than turning up on the member panel afterwards.
   */
  residualWarnings?: DesignWarning[];
  /**
   * The cage does NOT reach the target DCR — it is the richest one this section can
   * hold, returned so the shortfall can be measured rather than guessed at.
   *
   * Set only when no cage meets the demand at all. `worstDCRFlex` is then the ceiling of
   * the section, and it is above target by definition. A caller that shows the cage MUST
   * say this: applied without the warning it looks like an ordinary failing member, when
   * in fact no arrangement of bars in this section will fix it.
   */
  belowTarget?: boolean;
  /**
   * The links are the tightest practical ones and shear (or torsion, or the combined
   * shear+torsion link demand) is STILL over target — the section governs, and no
   * arrangement of stirrups closes the gap.
   *
   * Reported rather than refused so the flexural cage, which was solved correctly,
   * survives: a moment answer is not made wrong by a shear problem. `worstDCRShear` is
   * then above target and is the measure of how far.
   */
  shearBelowTarget?: boolean;
  /**
   * A CROSS-SECTION limit no reinforcement can answer — the shear+torsion crushing check
   * (ACI §22.7.7.1 / EC2 §6.3.2), or a hard detailing spacing the practical ladder
   * cannot reach. Carries the code's own message.
   *
   * The cage is still returned, because the flexural half of it is right and the links
   * are the tightest detailed; this says the concrete is the problem. A caller showing
   * the cage must show this — it is the one flag that means "no cage, ever".
   */
  sectionLimit?: string;
  /**
   * Advisory text about the RESULT, not a refusal — today: the group mixes members whose
   * demands are too far apart for one common cage. Distinct from `sectionLimit`, which
   * blames the concrete; this blames the grouping, and the remedy is to split it.
   */
  note?: string;
  /**
   * What the search settled on at each stage, in order.
   *
   * The suggester makes three decisions — the flexural cage, the links, then the
   * spacing/detailing adjustment — and each can move a DCR the previous one had already
   * settled. Reporting only the final numbers makes a cage that ends at shear 1.4
   * indistinguishable from one that was never close, and hides WHICH decision spent the
   * margin. Each entry is the state at the end of that stage: what was chosen, and what
   * every DCR read once it was.
   */
  steps?: SuggestStep[];
  /**
   * Everything still standing on the final cage — the engine's own code warnings, plus
   * the search's own verdicts (over ρmax, below target, section limit, mixed group).
   *
   * A suggestion that comes back flagged is still a suggestion; this is what makes the
   * flags readable rather than a set of booleans a caller has to translate.
   */
  warnings?: string[];
}

/** One decision in the search, with the DCRs it left behind. */
export interface SuggestStep {
  /**
   * Which decision this was, in the order they are taken: the SAGGING cage first, then
   * the HOGGING cage around it, then the links, then the detailing pass that moves
   * spacing to satisfy the code's own limits.
   */
  stage: 'flexure+' | 'flexure−' | 'shear' | 'detailing';
  /** Human-readable summary of what was chosen at this stage. */
  chose: string;
  flexDCR: number;
  shearDCR: number;
  torsionDCR: number;
  /** EC2 only — crack-width utilisation. */
  crackDCR?: number;
}

/** A refusal. `error` is user-facing; `kind` lets a caller branch on the reason. */
export interface SuggestError {
  error: string;
  /**
   * Why the suggestion could not be made, for callers that need to act on the reason
   * rather than print it.
   *
   * `'section-limit'` is the one that changes what the ENGINEER should do: the combined
   * shear + torsion cross-section check (ACI §22.7.7.1 / EC2 §6.3.2) caps the diagonal
   * compression in the CONCRETE, so it is not a cage that is missing — no arrangement of
   * links or bars satisfies it and the only fix is a bigger section. Every other failure
   * is a cage the search could not find within its ladders, which is a different
   * conversation.
   *
   * The rest exist so a sweep can be COUNTED by reason rather than by prose. "10 groups
   * unresolved" is not actionable; "7 hit the flexural ladder, 3 the crack limit" says
   * which ladder to widen. Adding one is additive — every caller either tests
   * `=== 'section-limit'` or ignores the field entirely.
   */
  kind?:
    | 'section-limit'      // shear + torsion crushes the section — no cage helps
    | 'no-beams'           // nothing in the group to size
    | 'bar-floor'          // the size floor excluded every candidate bar
    | 'design-threw'       // the engine raised on one of the members
    | 'crack-limit'        // EC2 §7.3.4 crack width — strong enough, cracks too wide
    | 'over-reinforced'    // ρmax / over-reinforced before a cage was found
    | 'flexure-ladder'     // flexural demand past the largest practical cage
    | 'shear-section'      // strut / V_c + max V_s exceeded — more links will not help
    | 'stirrup-spacing'    // no spacing in the ladder meets a HARD detailing limit
    | 'torsion-ladder'     // torsion past the tightest practical links
    | 'mixed-group'        // no single cage satisfies every member (mixed sections)
    | 'sweep-failure';     // the whole-cage verification sweep reported a failure
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
  /**
   * Upper bounds — "this size or SMALLER". The mirror of the floors above, and they
   * exist for a different reason: a floor is about constructability (do not detail me
   * #4s), a ceiling is about what the yard actually stocks, what will fit the
   * congestion, or a practice standard that stops at #9.
   *
   * Compared by DIAMETER like the floors (|size|), so they read the same in either bar
   * family. Undefined leaves that end of the ladder open, so an unconstrained search is
   * bit-for-bit the search that ran before these existed.
   */
  maxTopBar?: number;
  maxBotBar?: number;
  maxStirrup?: number;
  /**
   * Stirrup spacing bounds, in INCHES — stored-imperial like every other length that
   * crosses this boundary, converted at the dialog.
   *
   * `minSpacing` is a buildability floor ("do not hand me links at 3 inches"), NOT a
   * relaxation: the code's own maximum-spacing rules still apply on top, and where they
   * are tighter they win. `maxSpacing` is the reverse — cap the loosest zone.
   */
  minSpacing?: number;
  maxSpacing?: number;
}

/** Type guard separating a refusal from a suggestion. */
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
): { long: number[]; stirrup: number[]; spacing: number[] } {
  // The catalogue is the project's BAR FAMILY, not the design code: an ACI job
  // detailed in metric bars must be offered metric bars. Falls back to the
  // code's own convention when no family is supplied.
  const euro = (family ?? (code === 'EN1992-1-1' ? 'euro' : 'us')) === 'euro';
  return {
    long: euro ? LONG_BAR_SIZES_EC2 : LONG_BAR_SIZES_US,
    stirrup: euro ? STIRRUP_SIZES_EC2 : STIRRUP_SIZES_US,
    // The spacing rungs the search will actually try, in INCHES. Offered so the dialog's
    // spacing window is drawn from the same ladder rather than a second hard-coded list
    // that can drift from it — the bug that shipped twice in the bar catalogues.
    spacing: code === 'EN1992-1-1' ? STIRRUP_SPACINGS_EC2 : STIRRUP_SPACINGS_US,
  };
}

/**
 * Max bars per layer that fit the web width with ≥ max(1", db) clear spacing — the
 * inverse of the engine's own §25.2.1 test, so a cage this returns cannot be flagged
 * by the check that judges it.
 *
 * The width is set by the SIDE cover: bars sit between the stirrup legs, and
 * `coverFor(section, 'side')` is what `designMember` measures from. This read
 * `section.coverClear` — the single legacy value — so on any project whose side cover
 * differs from it the two disagreed, and the suggester packed a layer the engine then
 * rejected. A 12" web at 2.5" side cover was offered 5 bars where 3 fit, and the cage
 * came back carrying "§25.2.1 clear horizontal spacing 0.56" < 1.00"".
 */
export function maxBarsPerLayer(member: Member, barSize: number): number {
  const db = getBarDiam(barSize);
  const bw = member.section.bw ?? member.section.b;
  const dStir = getBarDiam(member.section.stirrupDia);
  const clear = Math.max(1, db);
  const usable = bw - 2 * (coverFor(member.section, 'side') + dStir);
  // n·db + (n−1)·clear ≤ usable → n ≤ (usable + clear) / (db + clear)
  return Math.max(0, Math.floor((usable + clear) / (db + clear)));
}

/**
 * The clear gap to detail BETWEEN layers.
 *
 * A flat 1", which is both the engine's default and what §25.2.2 actually asks for
 * ("a clear spacing between layers of at least 1 in."). This briefly returned
 * `max(1", db)` to satisfy a warning that demanded it — §25.2.1's HORIZONTAL rule
 * applied to the vertical direction. That warning has been removed, and with it the
 * reason to push stacked cages apart: the extra gap bought no compliance and cost
 * effective depth, so a three-layer #10 arrangement was being sized 0.27" deeper into
 * the section than it needed to be.
 *
 * Kept as a function rather than inlined because `probe` and `buildCage` must agree
 * about it — the gap moves d, so sizing at one value and shipping another sizes the
 * wrong beam.
 */
function layerGapFor(_top: Rung, _bot: Rung): number {
  return 1.0;
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

/**
 * Find the lightest cage that satisfies EVERY member of a design group.
 *
 * A group shares one cage, so the search is governed by the worst member on each check —
 * a cage that works for the average member is not a cage. Candidates are walked in
 * area-ascending ladders and selected by binary search (`firstPassing`), which is valid
 * because capacity is monotone in steel area: more steel never makes a check fail.
 *
 * Sizing is done through `runDesign` with the project's own settings (strut angle,
 * torsion policy), never a simplified internal check — otherwise the suggested cage
 * would be validated against different rules than the member panel then applies to it.
 *
 * Returns a `SuggestError` rather than throwing when no cage works; a section-limit
 * refusal is distinguished because it needs a bigger section, not more steel.
 */
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
  /**
   * The project's SLS quasi-permanent combo, for the EC2 §7.3.4 crack check.
   *
   * Without it the suggester sizes against `qpFactor × Mu` — the engine's fallback when
   * no quasi-permanent moment is supplied — while the member panel beside it uses the
   * REAL Mqp resolved from that combo's station forces. Two different crack demands, so
   * a cage sized here could read differently the moment it was applied.
   *
   * NOTE the positional tail. This is the eighth argument, and the last two bugs in this
   * area were both a caller stopping short of one: `ignoreTorsion` was omitted by the
   * workspace shell, and the crack check was omitted from the search entirely. Callers
   * with a `project` in hand should pass every one of these.
   */
  slsCombo?: string,
): SuggestResult | SuggestError {
  // Column groups use the dedicated column auto-design path (symmetric cage +
  // tie sizing against the P-M / axial / shear checks). Only fall through to the
  // beam path when the group has no loaded columns.
  const beams = members.filter(m => m.loads.length > 0);
  if (!beams.length) return { error: 'No designed beam members with loads in this group.', kind: 'no-beams' };

  const isEC2 = code === 'EN1992-1-1';
  /**
   * Crack-control parameters per member, resolved ONCE.
   *
   * The app never reads `member.crackParams` raw for a design — it goes through
   * `resolveCrack`, which substitutes the quasi-permanent moments from the project's SLS
   * combo when there is one. Doing it once here, and reading only from this map below,
   * is what keeps the seven `runDesign` calls in this file from drifting apart the way
   * the two that mattered already did.
   */
  const crackOf = new Map<string, ReturnType<typeof resolveCrack>>();
  const crackFor = (m: Member) => {
    if (!crackOf.has(m.id)) crackOf.set(m.id, resolveCrack(m, code, slsCombo));
    return crackOf.get(m.id);
  };
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
  // Ceilings. Taken as the SMALLER of the two face maxima for the same reason the floor
  // takes the larger: one longitudinal size serves both faces, so the usable window is
  // the intersection of what each face allows.
  const longCapMag = Math.min(
    floors?.maxTopBar ? Math.abs(floors.maxTopBar) : Infinity,
    floors?.maxBotBar ? Math.abs(floors.maxBotBar) : Infinity,
  );
  const stirrupCapMag = floors?.maxStirrup ? Math.abs(floors.maxStirrup) : Infinity;
  const inBand = (v: number, lo: number, hi: number) => Math.abs(v) >= lo && Math.abs(v) <= hi;
  const LONG_BAR_SIZES   = (euroBars ? LONG_BAR_SIZES_EC2 : LONG_BAR_SIZES_US).filter(s => inBand(s, longFloorMag, longCapMag));
  const STIRRUP_SIZES    = (euroBars ? STIRRUP_SIZES_EC2  : STIRRUP_SIZES_US ).filter(s => inBand(s, stirrupFloorMag, stirrupCapMag));
  // Spacing bounds are a BUILDABILITY window, not a code relaxation: §9.7.6.2.2 and the
  // torsion floor are applied on top of whatever survives here, and where they are
  // tighter they win. A window that excludes everything is reported rather than silently
  // ignored — see the guard below.
  const spMin = floors?.minSpacing ?? 0;
  const spMax = floors?.maxSpacing ?? Infinity;
  const STIRRUP_SPACINGS = (isEC2 ? STIRRUP_SPACINGS_EC2 : STIRRUP_SPACINGS_US)
    .filter(x => x >= spMin - 1e-9 && x <= spMax + 1e-9);
  if (!LONG_BAR_SIZES.length) return { error: 'No longitudinal bar size fits the requested min/max window — widen it.', kind: 'bar-floor' };
  if (!STIRRUP_SPACINGS.length) return { error: `No stirrup spacing in the practical ladder falls between the requested ${spMin}" and ${spMax}" — widen the window.`, kind: 'bar-floor' };
  if (!STIRRUP_SIZES.length)  return { error: 'No stirrup size fits the requested min/max window — widen it.', kind: 'bar-floor' };

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
      r = runDesign(m.section, m.material, m.rebar, posLC, m.span, code, crackFor(m), cotTheta, ignoreTorsion);
    } catch (e) {
      return { error: `Design failed for ${m.label}: ${(e as Error).message}`, kind: 'design-threw' };
    }
    AsMinFloor = Math.max(AsMinFloor, r.As_min);
    AsMaxCap = Math.min(AsMaxCap, r.As_max);
    const score = Math.max(posLC.Mu_pos ?? 0, negLC.Mu_neg ?? 0);
    if (score > govScore) { govScore = score; governing = m; }
  }

  // Flexural DCR of the governing member for a trial cage.
  //
  // THE STIRRUP IN THIS SEED IS THE LARGEST one shear may go on to choose, not the
  // smallest. Flexure and shear are solved in sequence, but they are coupled: the link
  // diameter sits between the cover and the longitudinal bars, so a bigger link pushes
  // the bars inward, shrinks d, and RAISES the flexural DCR of a cage that was already
  // chosen. Seeding with the smallest link (as this did) sized flexure against a depth
  // the finished beam does not have — a cage settled at 0.89 came back over target once
  // shear picked #6, and the final group sweep then reported it as "mixed sections",
  // blaming the group for an arithmetic mismatch inside this function.
  //
  // Seeding with the WORST case makes the two checks true together by construction: the
  // flexural cage is valid for every link the shear stage can pick, so shear can never
  // invalidate it. It costs a little steel when a small link is chosen in the end — d is
  // then larger than assumed and the cage is slightly conservative — which is the right
  // side to be wrong on, and cheaper than an iteration that can oscillate.
  const worstStirrup = STIRRUP_SIZES.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), STIRRUP_SIZES[0]);
  const tieSeed = { barSize: worstStirrup, spacing: STIRRUP_SPACINGS[Math.floor(STIRRUP_SPACINGS.length / 2)], legs: 2 };
  const probe = (m: Member, lc: LoadCase, top: Rung, bot: Rung): DesignResults | null => {
    // `layerClearSpacing` matters here, not just on the final cage: it sets where the
    // inner layers sit, so it moves d and therefore the DCR being probed. Sizing at the
    // engine's 1.0" default and shipping a cage detailed at 1.41" is sizing the wrong beam.
    try { return runDesign(m.section, m.material, { topBars: top.layers, botBars: bot.layers, ties: tieSeed, layerClearSpacing: layerGapFor(top, bot) }, lc, m.span, code, crackFor(m), cotTheta, ignoreTorsion); }
    catch { return null; }
  };
  const worstFlexNeg = (top: Rung, bot: Rung): number => probe(topGov.m, topGov.lc, top, bot)?.DCR_flex_neg ?? Infinity;
  const worstFlexPos = (top: Rung, bot: Rung): number => probe(botGov.m, botGov.lc, top, bot)?.DCR_flex_pos ?? Infinity;

  /**
   * Crack-width utilisation on ONE face, for a trial cage. EC2 only — ACI has no
   * equivalent DCR, so this is 0 there and the predicates below collapse to flexure.
   *
   * WHY THE SEARCH HAS TO SEE THIS. Everything else here is an ULS check that gets
   * EASIER with more steel, so "lightest cage that passes" is a safe objective. Crack
   * width runs the other way: σs rises as the cage is trimmed, so the cheapest cage that
   * satisfies flexure can be one that cracks too wide. Without this the suggester would
   * take a beam that PASSED §7.3.4 and hand back one that fails it — measured on a
   * C30/37 300×600 at a 0.25 mm limit, 8-Ø20 (w/w_lim = 0.21) became 4-Ø16 at 1.08,
   * and at 0.15 mm it reached 1.81. The group then reads red immediately after running
   * the tool meant to fix it.
   *
   * PER FACE, not the combined `DCR_crack`. Hogging cracking is controlled by the TOP
   * cage and sagging by the BOTTOM; the combined figure is the max of both, so using it
   * on each face would size one face against the other's problem — and, because the
   * opposite face is pinned at its lightest rung while probing, could make the predicate
   * unsatisfiable at every rung.
   *
   * MONOTONE within a ladder, which is what `firstPassing`'s binary search needs: a
   * ladder holds ONE bar size, so adding bars raises As and lowers σs while sr,max (∝ ø)
   * is unchanged — crack utilisation falls as the index rises, exactly like the flexural
   * DCR it sits beside.
   */
  const crackLimit = (m: Member, face: 'top' | 'bot'): number => {
    const cp = { ...DEFAULT_CRACK_PARAMS, ...(crackFor(m) ?? {}) };
    return face === 'top' ? cp.wLimitTop : cp.wLimitBot;
  };
  const crackNeg = (top: Rung, bot: Rung): number => {
    if (!isEC2) return 0;
    const r = probe(topGov.m, topGov.lc, top, bot);
    const lim = crackLimit(topGov.m, 'top');
    if (!r || !(lim > 0)) return 0;
    return (r.wk_top ?? 0) / lim;
  };
  const crackPos = (top: Rung, bot: Rung): number => {
    if (!isEC2) return 0;
    const r = probe(botGov.m, botGov.lc, top, bot);
    const lim = crackLimit(botGov.m, 'bot');
    if (!r || !(lim > 0)) return 0;
    return (r.wk_bot ?? 0) / lim;
  };

  // 2. Flexure: over every common bar size, binary-search each face for the lightest
  //    rung meeting As,min AND DCR ≤ target, then keep the size giving the lightest
  //    total steel. Minimising area is self-correcting on layer count — extra layers
  //    lower the effective depth and therefore RAISE the area needed — so the search
  //    naturally avoids gratuitous layers and tiny-bar pile-ups. Ties break to fewer
  //    layers, then smaller bars (better crack distribution).
  let chosen: { top: Rung; bot: Rung; combinedAs: number; layers: number } | null = null;
  let sawOverReinforced = false;
  // Distinguishes "no cage is strong enough" from "no cage of THIS bar size cracks
  // narrowly enough". They call for opposite moves — a bigger section versus smaller
  // bars — so reporting the flexure message for a crack-limited search sends the
  // engineer looking for strength that is already there.
  let sawCrackLimited = false;
  for (const size of LONG_BAR_SIZES) {
    const nMax = Math.min(...beams.map(m => maxBarsPerLayer(m, size)));
    const ladder = faceLadder(size, nMax);
    if (ladder.length < 1) continue;
    // Fix the opposite face at the lightest rung while probing one face — a face's
    // flexural DCR is (near-)independent of the other, and the min rung is always a
    // valid, non-over-reinforced section (a huge opposite face can make runDesign
    // return NaN/throw). Conservative if the engine credits compression steel.
    const fixedOpp = ladder[0];
    // SAGGING FIRST. The bottom face is solved against the worst +M in the group with the
    // top pinned at its lightest rung — conservative on purpose, because at this point
    // there is no chosen top cage to credit as compression steel, and assuming one that
    // has not been sized yet would be sizing against a beam that does not exist.
    const bi = firstPassing(ladder.length, i => ladder[i].As >= AsMinFloor - EPS
      && worstFlexPos(fixedOpp, ladder[i]) <= targetDCR + EPS
      && crackPos(fixedOpp, ladder[i]) <= 1 + EPS);
    if (bi < 0) {
      // Two probes, only on failure: was the heaviest rung strong enough but still
      // cracking too wide? Then this size is crack-limited, not strength-limited.
      const last = ladder.length - 1;
      if (last >= 0 && worstFlexPos(fixedOpp, ladder[last]) <= targetDCR + EPS
          && crackPos(fixedOpp, ladder[last]) > 1 + EPS) sawCrackLimited = true;
      continue;
    }
    // HOGGING SECOND, and against the bottom cage that was just CHOSEN rather than the
    // lightest rung. Two reasons. It is the honest picture — that bottom steel is really
    // there, and for hogging it sits in the compression zone, so the top face earns the
    // credit for it. And it is the order an engineer works in: the sagging cage is
    // settled, now detail the supports around it.
    const ti = firstPassing(ladder.length, i => ladder[i].As >= AsMinFloor - EPS
      && worstFlexNeg(ladder[i], ladder[bi]) <= targetDCR + EPS
      && crackNeg(ladder[i], ladder[bi]) <= 1 + EPS);
    if (ti < 0) {
      const last = ladder.length - 1;
      if (last >= 0 && worstFlexNeg(ladder[last], ladder[bi]) <= targetDCR + EPS
          && crackNeg(ladder[last], ladder[bi]) > 1 + EPS) sawCrackLimited = true;
      continue;
    }
    // ρmax gate — refuse an over-reinforced (brittle / non-code) cage.
    if (ladder[ti].As > AsMaxCap + EPS || ladder[bi].As > AsMaxCap + EPS) { sawOverReinforced = true; continue; }
    const combinedAs = ladder[ti].As + ladder[bi].As;
    const layers = ladder[ti].layers.length + ladder[bi].layers.length;
    if (!chosen || combinedAs < chosen.combinedAs - EPS ||
        (Math.abs(combinedAs - chosen.combinedAs) <= EPS && layers < chosen.layers)) {
      chosen = { top: ladder[ti], bot: ladder[bi], combinedAs, layers };
    }
  }
  // ── Doubly-reinforced fallback ───────────────────────────────────────────────
  //
  // The pass above probes each face with the OPPOSITE one pinned at its lightest rung.
  // That is fast and right for the ordinary beam, but it throws away the one move a
  // designer reaches for when the tension face runs out of room: put steel in the
  // COMPRESSION zone. Compression steel raises Mn and, by pulling the neutral axis up,
  // restores the tensile strain that ρmax exists to protect — so a cage the single-face
  // pass rejects as over-reinforced can be perfectly legal once the other face is
  // counted. On an 18×60 at Mu+ = 4500 kip-ft the pass above gives up; 6-#10 in three
  // layers with 4-#10 top is φMn = 5031 kip-ft, DCR 0.89.
  //
  // Only ever runs where we would OTHERWISE RETURN AN ERROR, so it cannot change a
  // result the fast path already found, and it cannot cost anything on a model that
  // does not need it. Within it, both DCRs are monotone decreasing in both faces' areas
  // (more steel never hurts either check), so the inner face is still binary-searched;
  // the outer loop walks the tension ladder from light to heavy and stops as soon as the
  // combined area passes the best already found, which is what keeps it bounded.
  if (!chosen) {
    for (const size of LONG_BAR_SIZES) {
      const nMax = Math.min(...beams.map(m => maxBarsPerLayer(m, size)));
      const ladder = faceLadder(size, nMax).filter(r => r.As <= AsMaxCap + EPS);
      if (ladder.length < 1) continue;
      for (let ti = 0; ti < ladder.length; ti++) {
        const top = ladder[ti];
        if (top.As < AsMinFloor - EPS) continue;
        // No bottom rung can beat what we already have from here on — and ti only grows.
        if (chosen && top.As + ladder[0].As >= chosen.combinedAs - EPS) break;
        const bi = firstPassing(ladder.length, i => ladder[i].As >= AsMinFloor - EPS
          && worstFlexNeg(top, ladder[i]) <= targetDCR + EPS
          && worstFlexPos(top, ladder[i]) <= targetDCR + EPS
          && crackNeg(top, ladder[i]) <= 1 + EPS
          && crackPos(top, ladder[i]) <= 1 + EPS);
        if (bi < 0) continue;
        const combinedAs = top.As + ladder[bi].As;
        const layers = top.layers.length + ladder[bi].layers.length;
        if (!chosen || combinedAs < chosen.combinedAs - EPS ||
            (Math.abs(combinedAs - chosen.combinedAs) <= EPS && layers < chosen.layers)) {
          chosen = { top, bot: ladder[bi], combinedAs, layers };
        }
      }
    }
    // It found one, so the section was never the problem — the earlier verdict was an
    // artifact of probing one face at a time.
    if (chosen) { sawOverReinforced = false; sawCrackLimited = false; }
  }

  // ── Over-reinforced pass: show the cage anyway ───────────────────────────────
  //
  // ρmax is a DUCTILITY rule, not a strength one. A cage past it still carries the
  // moment — it just does so by crushing the concrete before the steel yields, which is
  // the brittle failure the limit exists to prevent. Refusing to draw it left the
  // engineer with a message and nothing to look at: no way to see how far past the line
  // the section is, or whether it is a bar size out or a whole section short.
  //
  // So the cage is produced and FLAGGED, in that order of preference — legal first,
  // doubly-reinforced legal second, this only if neither exists. `overReinforced` on the
  // result is what callers show it by; the engine's own §9.3.3 / §7.3 warnings then ride
  // along on every design run of the applied cage, so the member panel and the chips
  // keep saying so long after this dialog is closed.
  //
  // THE DCR TARGET IS STILL ENFORCED. This relaxes one code limit; it does not propose a
  // cage that fails the demand. A layout that cannot carry the moment is not a layout to
  // look at, it is a wrong answer — so ladder exhaustion below still refuses.
  let overReinforced = false;
  if (!chosen) {
    for (const size of LONG_BAR_SIZES) {
      const nMax = Math.min(...beams.map(m => maxBarsPerLayer(m, size)));
      const ladder = faceLadder(size, nMax);            // no AsMaxCap filter — the point
      if (ladder.length < 1) continue;
      for (let ti = 0; ti < ladder.length; ti++) {
        const top = ladder[ti];
        if (top.As < AsMinFloor - EPS) continue;
        if (chosen && top.As + ladder[0].As >= chosen.combinedAs - EPS) break;
        const bi = firstPassing(ladder.length, i => ladder[i].As >= AsMinFloor - EPS
          && worstFlexNeg(top, ladder[i]) <= targetDCR + EPS
          && worstFlexPos(top, ladder[i]) <= targetDCR + EPS
          && crackNeg(top, ladder[i]) <= 1 + EPS
          && crackPos(top, ladder[i]) <= 1 + EPS);
        if (bi < 0) continue;
        const combinedAs = top.As + ladder[bi].As;
        const layers = top.layers.length + ladder[bi].layers.length;
        if (!chosen || combinedAs < chosen.combinedAs - EPS ||
            (Math.abs(combinedAs - chosen.combinedAs) <= EPS && layers < chosen.layers)) {
          chosen = { top, bot: ladder[bi], combinedAs, layers };
        }
      }
    }
    if (chosen) {
      // Only claim it if it IS over ρmax — the pass can also succeed on a cage the
      // earlier ones skipped for an unrelated reason, and mislabelling a legal cage as
      // brittle is its own kind of wrong.
      overReinforced = chosen.top.As > AsMaxCap + EPS || chosen.bot.As > AsMaxCap + EPS;
      sawCrackLimited = false;
    }
  }

  // ── Best-effort pass: the richest cage that fits, even if it is not enough ────
  //
  // Past this point no cage meets the target, so the honest verdict is "enlarge the
  // section" — but a message alone leaves nothing to look at, and the engineer's next
  // question is always the same: HOW FAR short is it? A cage at DCR 1.05 is a bar size
  // away; one at 1.9 is a different beam. That is a number, and it is only visible if
  // the cage is produced.
  //
  // So the richest buildable cage is returned, `belowTarget` set. It is NOT a proposal
  // — it is the ceiling of this section, offered for measurement. Callers must show the
  // flag; the DCR alone will read as a normal failing member, which understates it.
  let belowTarget = false;
  if (!chosen) {
    for (const size of LONG_BAR_SIZES) {
      const nMax = Math.min(...beams.map(m => maxBarsPerLayer(m, size)));
      const ladder = faceLadder(size, nMax);
      if (ladder.length < 1) continue;
      const top = ladder[ladder.length - 1], bot = ladder[ladder.length - 1];
      const dcr = Math.max(worstFlexNeg(top, bot), worstFlexPos(top, bot));
      if (!Number.isFinite(dcr)) continue;
      // Best = lowest DCR reachable, not lightest: there is no "lightest that passes"
      // here, and among cages that all fall short the strongest is the informative one.
      const cur = chosen ? Math.max(worstFlexNeg(chosen.top, chosen.bot),
                                    worstFlexPos(chosen.top, chosen.bot)) : Infinity;
      if (dcr < cur - EPS) {
        chosen = { top, bot, combinedAs: top.As + bot.As, layers: top.layers.length + bot.layers.length };
      }
    }
    if (chosen) {
      belowTarget = true;
      overReinforced = chosen.top.As > AsMaxCap + EPS || chosen.bot.As > AsMaxCap + EPS;
    }
  }

  if (!chosen) {
    if (sawCrackLimited && !sawOverReinforced) {
      return { error: 'No cage satisfies the EC2 §7.3.4 crack-width limit at this exposure — the section is strong enough, but the crack width needs more, SMALLER bars than fit, a lower cover, or a relaxed exposure class.', kind: 'crack-limit' };
    }
    return sawOverReinforced
      ? { error: 'Flexure would exceed the maximum reinforcement ratio (ρmax / over-reinforced) — enlarge the section.', kind: 'over-reinforced' }
      : { error: 'Flexural demand exceeds the largest practical cage (up to #11/Ø32 in 3 layers) — enlarge the section.', kind: 'flexure-ladder' };
  }
  const { top: chosenTop, bot: chosenBot } = chosen;

  // The running record. Each stage appends the state it settled on, so the caller can
  // see where the margin went rather than only where it ended up.
  const steps: SuggestStep[] = [];
  const barsOf = (r: Rung) => r.layers.map(l => `${l.numBars}${l.barSize < 0 ? `Ø${-l.barSize}` : `-#${l.barSize}`}`).join(' + ');
  {
    // One row per moment face, in the order they were solved. Both are read on the seed
    // links — shear has not been sized yet — so their shear figures are "with the seed",
    // not a claim about the final cage.
    //
    // The sagging row is deliberately read with the top pinned LIGHT, which is the state
    // the bottom face was actually chosen in. Reading it against the finished cage would
    // print a number the decision never saw.
    const light = { layers: chosenTop.layers.slice(0, 1).map(l => ({ ...l, numBars: 2 })), As: 0, totalBars: 2 };
    const rPos = probe(botGov.m, botGov.lc, light, chosenBot);
    steps.push({
      stage: 'flexure+',
      chose: `bot ${barsOf(chosenBot)}`,
      flexDCR: rPos?.DCR_flex_pos ?? 0,
      shearDCR: rPos?.DCR_shear ?? 0,
      torsionDCR: rPos?.DCR_torsion ?? 0,
      ...(isEC2 ? { crackDCR: crackPos(light as Rung, chosenBot) } : {}),
    });
    const rNeg = probe(topGov.m, topGov.lc, chosenTop, chosenBot);
    steps.push({
      stage: 'flexure−',
      chose: `top ${barsOf(chosenTop)}`,
      flexDCR: rNeg?.DCR_flex_neg ?? 0,
      shearDCR: rNeg?.DCR_shear ?? 0,
      torsionDCR: rNeg?.DCR_torsion ?? 0,
      ...(isEC2 ? { crackDCR: crackNeg(chosenTop, chosenBot) } : {}),
    });
  }

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
      }, at.lc, at.m.span, code, crackFor(at.m), cotTheta, ignoreTorsion);
    } catch { return null; }
  };
  const shearDCRAt = (at: { m: Member; lc: LoadCase }, tie: Tie, zones: { spacing: number }[]): number =>
    designAt(at, tie, zones)?.DCR_shear ?? Infinity;

  /**
   * Torsion DCR **as a link-driven number**, or 0 when torsion is not being designed
   * for on this row.
   *
   * Below the code's own threshold — ACI §22.7.1 φ·T_th, EC2 §6.3.1 T_Rd,c — torsion may
   * be neglected, and the engines then report DCR_torsion as a utilisation of the
   * CONCRETE's torsional resistance rather than the links':
   *
   *     EC2   DCR_torsion = T_Ed ≤ T_Rd,c ? T_Ed/T_Rd,c : T_Ed/T_Rd
   *
   * The first branch does not move when you add link steel. A beam sitting at, say, 95 %
   * of T_Rd,c therefore reads DCR_torsion = 0.95 for EVERY rung on the ladder, so a
   * search for "the lightest rung with DCR ≤ 0.9" finds nothing and concludes the
   * section cannot carry the torsion — when in fact the code says there is no torsion to
   * design for. That is what made Suggest refuse essentially every EC2 group carrying
   * any torsion at all; ACI escaped it only because its DCR_torsion is T_u/φT_n in both
   * regimes and so is always monotone in A_t/s.
   */
  const torsDCRAt = (at: { m: Member; lc: LoadCase }, tie: Tie, zones: { spacing: number }[]): number => {
    const r = designAt(at, tie, zones);
    if (!r) return Infinity;
    return torsionDesignedFor(r, at.lc) ? r.DCR_torsion : 0;
  };
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
    // Judged on UNIFORM zones: torsional capacity is read at the loosest zone, so a
    // relaxation can only weaken it, and `zonesFor` re-checks torsion before accepting.
    const k = firstPassing(legLadder.length, i => torsDCRAt(torsGov!, legLadder[i], uniform(legLadder[i])) <= targetDCR + EPS);
    // Nothing on the ladder carries it ⇒ seed the RICHEST rung and let the verification
    // sweep name the limit on a cage that actually exists. Refusing here instead was
    // wrong twice over: under EC2 the blocker is nearly always T_Rd,max — a SECTION
    // limit the engine reports as §6.3.2(4), so the group deserves "enlarge the
    // section", not "unresolved" — and the message was written in ACI's notation
    // (T_u kip-ft, φT_n, "#6 @ 4 in") whatever code the project was on.
    legFloor = perLegRate(legLadder[k < 0 ? legLadder.length - 1 : k]);
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

  // Shear, best effort — the same rule flexure follows above.
  //
  // When no rung meets the target the section/strut governs and more links genuinely do
  // not help. But REFUSING here threw away the flexural cage that was just solved, and
  // handed back nothing: the group kept its old bars, its old links, and a sentence. The
  // moment problem was fixable and got fixed, and then the answer was discarded because
  // a DIFFERENT check could not be.
  //
  // So the tightest practical links are used instead and the shortfall is flagged. The
  // cage that comes back is the best this section can be given — right on flexure,
  // as-close-as-possible on shear — which is strictly more useful than the beam's
  // existing arbitrary cage, and it puts a NUMBER on how far over the section is.
  let shearBelowTarget = false;
  let si = lightestPassing(Infinity);
  if (si < 0) {
    // The rate-sorted ladder's last rung is the richest: most steel per inch of span.
    si = tieRungs.length - 1;
    shearBelowTarget = si >= 0;
  }
  if (si < 0) {
    return {
      error: isEC2
        ? "Shear: compression strut V_Rd,max exceeded — widen the web or raise f_ck (more links won't help)."
        : "Shear: section capacity (V_c + max V_s) exceeded — widen the web or raise f′c (more links won't help).",
      kind: 'shear-section',
    };
  }

  {
    // Shear's own numbers, on the cage flexure settled — this is the pair being met
    // together, and it is the entry that shows whether sizing the links cost any of the
    // flexural margin (it should not: the seed above is the worst-case link).
    const t = tieRungs[si];
    const r = designAt(shearGov, t, uniform(t));
    steps.push({
      stage: 'shear',
      chose: `${t.size < 0 ? `Ø${-t.size}` : `#${t.size}`} ${t.legs}-leg @ ${t.spacing.toFixed(2)}`,
      flexDCR: Math.max(r?.DCR_flex_pos ?? 0, r?.DCR_flex_neg ?? 0),
      shearDCR: r?.DCR_shear ?? Infinity,
      torsionDCR: r?.DCR_torsion ?? 0,
    });
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
    worstFlex: number; worstShear: number; worstTors: number; worstVT: number;
    worstCrack: number;
    spacing: DesignWarning | null; crushing: { w: DesignWarning; at: string } | null; failure?: string;
  }
  /**
   * The checks that CANNOT be answered with a bigger cage: they cap the diagonal
   * compression in the concrete, and each engine says so in its own message ("more
   * stirrups will not help" / "adding more links won't help").
   *
   * `EC2 §6.3.2` is deliberately NOT in here even though it is error-severity, and the
   * distinction matters: that code covers "combined shear+torsion links NG — required
   * Asw/s > provided", which is the opposite kind of problem. More links are exactly
   * what fixes it. Treating it as a section limit made the search abandon every EC2
   * group with meaningful torsion on the first sweep and hand back "enlarge the
   * section" for a cage it had not finished trying to build.
   */
  const SECTION_LIMIT_CODES = new Set([
    'ACI §22.7.7.1',   // √(vu² + vt²) > φ(Vc/bw·d + 8λ√f'c)
    'ACI §22.5.1.2',   // Vu > φ(Vc + 8√f'c·bw·d) — the web crushes, links cannot help
    'EC2 §6.2.3',      // V_Ed > V_Rd,max (strut crushing)
    'EC2 §6.3.2(4)',   // T_Ed/T_Rd,max + V_Ed/V_Rd,max > 1
    // "bar layers occupy ≥ h/2 — section cannot fit this layout". Not a code clause but
    // the same kind of answer: no cage resolves it, the section has to grow. Without it
    // the search happily returned a stack that does not physically fit.
    'GEOM',
  ]);
  const sweep = (trial: RebarLayout): Sweep => {
    const out: Sweep = { worstFlex: 0, worstShear: 0, worstTors: 0, worstVT: 0, worstCrack: 0, spacing: null, crushing: null };
    for (const m of beams) {
      for (const lc of m.loads) {
        let r: DesignResults;
        try { r = runDesign(m.section, m.material, trial, lc, m.span, code, crackFor(m), cotTheta, ignoreTorsion); }
        catch (e) { return { ...out, failure: `Verification failed for ${m.label}: ${(e as Error).message}` }; }
        out.worstFlex = Math.max(out.worstFlex, r.DCR_flex_pos, r.DCR_flex_neg);
        out.worstShear = Math.max(out.worstShear, r.DCR_shear);
        // Only where torsion is designed for — below the threshold DCR_torsion is a
        // concrete utilisation no cage moves (see `torsDCRAt`).
        out.worstTors = Math.max(out.worstTors, torsionDesignedFor(r, lc) ? r.DCR_torsion : 0);
        // EC2 §6.3.2: shear and torsion link demands ADD, and neither DCR_shear nor
        // DCR_torsion sees the sum — a cage can pass both and still be short. Undefined
        // under ACI, where the combined demand is already inside DCR_torsion.
        out.worstVT = Math.max(out.worstVT, r.VT_util ?? 0);
        // EC2 SLS crack width. Tracked so the assembled cage is verified against the
        // check the search now constrains — the search probes only the GOVERNING member
        // per face, and this is what confirms every other member agrees.
        out.worstCrack = Math.max(out.worstCrack, r.DCR_crack ?? 0);
        for (const w of r.warnings) {
          // An error-severity violation outranks a warning-severity one: it is the
          // one worth failing the suggestion over if no spacing can satisfy it.
          if (SPACING_CODES.has(w.code) && (!out.spacing || (w.severity === 'error' && out.spacing.severity !== 'error')))
            out.spacing = w;
          if (w.severity === 'error' && SECTION_LIMIT_CODES.has(w.code))
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
    // Detailed gap between layers — see `layerGapFor`. Stated explicitly rather than
    // left to the engine's default so the cage that goes out carries the same geometry
    // the search sized it on.
    layerClearSpacing: layerGapFor(chosenTop, chosenBot),
  });

  let chosenTie = tieRungs[si];
  let zones = zonesFor(chosenTie, Infinity);
  let cage = buildCage(chosenTie, zones);
  let check = sweep(cage);
  if (check.failure) return { error: check.failure, kind: 'sweep-failure' };

  // Ratchet. Two knobs, both driven by what the engine actually reported on the cage
  // just assembled, and both bounded by their own ladder so this always terminates:
  //   spacing  — cap one increment below the loosest zone that drew a detailing
  //              complaint (§9.7.6.2.2 / §9.7.6.3.3 / EC2 §9.2.2);
  //   links    — raise the per-leg floor one rung when torsion, or EC2's COMBINED
  //              shear+torsion link demand, is still over. Two reasons that is not just
  //              the torsion governor's business: on mixed sections the biggest T_Ed is
  //              not always on the smallest A_o, and §6.3.2 sums two demands that
  //              DCR_shear and DCR_torsion each see only half of.
  const maxRounds = STIRRUP_SPACINGS.length + legLadder.length;
  for (let round = 0; round < maxRounds; round++) {
    if (check.crushing) break;                    // section limit; links can't fix it
    const needSpacing = !!check.spacing;
    // SHEAR, measured on the assembled cage across every member × every row × the zone
    // each row actually sits in. The binary search probes one governor per zone, which is
    // exact for a single-section group but not for a mixed one — a shallower member has
    // less lever arm z and so less V_Rd,s at the same links, and it need not be the row
    // carrying the biggest V_Ed. `worstShear` was computed here from the start and then
    // read only by the final guard, so that case fell straight through to "check for
    // mixed sections" without the search ever having tried a tighter cage. Tightening the
    // cap raises the rate `lightestPassing` must clear, so this converges on the ladder.
    const needShear = check.worstShear > targetDCR + EPS;
    const needLinks = check.worstTors > targetDCR + EPS || check.worstVT > targetDCR + EPS;
    if (!needSpacing && !needShear && !needLinks) break;

    let cap = Math.max(...zones.map(z => z.spacing));
    if (needSpacing || needShear) {
      const tighter = [...STIRRUP_SPACINGS].sort((a, b) => b - a).find(s => s < cap - EPS);
      if (tighter === undefined && !needLinks) break;     // already at the tightest we detail
      if (tighter !== undefined) cap = tighter;
    }
    if (needLinks) {
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
    if (check.failure) return { error: check.failure, kind: 'sweep-failure' };
  }

  // The cross-section crushing limit (ACI §22.7.7.1 / EC2 §6.3.2) caps the diagonal
  // compression in the CONCRETE, so it is the one verdict no cage can answer. It is
  // still not a reason to withhold the cage: the flexural answer is correct, the links
  // are the tightest detailed, and "your section is over the crushing limit BY THIS
  // MUCH, and here is the best cage it could hold" is strictly more use than the same
  // sentence with nothing attached. Flagged, not refused.
  let sectionLimit: string | undefined;
  if (check.crushing) {
    sectionLimit = `Shear + torsion on ${check.crushing.at}: ${check.crushing.w.message}`;
    shearBelowTarget = true;
  }
  // Nothing in the practical ladder satisfies a HARD spacing limit ⇒ the section is the
  // problem. A warning-severity limit left standing (torsion Ph/8, ρw,min) keeps its
  // cage: it is a flag for the engineer, not a reason to refuse to suggest anything.
  if (check.spacing?.severity === 'error') {
    sectionLimit ??= `Stirrup spacing: ${check.spacing.message} — no spacing in the practical ladder (${STIRRUP_SPACINGS.map(s => (isEC2 ? `${Math.round(s * 25.4)} mm` : `${s}"`)).join(', ')}) satisfies it. Deepen the section or widen the web.`;
    shearBelowTarget = true;
  }
  // Torsion, and EC2's combined shear+torsion link demand, in the project's own
  // notation. A message that says "T_u … kip-ft" and "#6 @ 4 in" to someone working in
  // EN 1992-1-1 reads as a bug in the tool, whatever it is trying to tell them.
  // Torsion past the tightest links is a SECTION verdict, and it used to discard the
  // whole cage to say so. It is flagged instead, for the same reason shear is: the
  // flexural answer was correct and is worth keeping, and the links on their way to
  // being wrong are still the tightest ones available — which is the best this section
  // can be detailed, and the number that says how far over it is.
  if (check.worstTors > targetDCR + EPS || check.worstVT > targetDCR + EPS) {
    shearBelowTarget = true;
  }
  const { worstFlex, worstShear: worstShearFinal, worstCrack: worstCrackFinal } = check;
  {
    // The detailing stage: spacing tightened for §9.7.6.2.2 / §9.7.6.3.3 and the torsion
    // floor, then the whole cage re-verified on EVERY member and load case. These are the
    // numbers that actually ship, and they can differ from the shear row above — which is
    // the point of recording both.
    const t = chosenTie;
    steps.push({
      stage: 'detailing',
      chose: `${t.size < 0 ? `Ø${-t.size}` : `#${t.size}`} ${t.legs}-leg @ `
        + `${zones.map(z => z.spacing.toFixed(2)).join('/')}`,
      flexDCR: worstFlex,
      shearDCR: worstShearFinal,
      torsionDCR: Math.max(check.worstTors, check.worstVT),
      ...(isEC2 ? { crackDCR: worstCrackFinal } : {}),
    });
  }
  // `belowTarget` means the flexural shortfall is already KNOWN and deliberate — the
  // cage is the section's ceiling, returned to be measured. Failing it here as
  // "mixed sections" would both throw that away and blame the wrong thing. Shear is
  // still enforced: it has its own ladder and its own specific refusals above, so a
  // shear miss here really is the group disagreeing with itself.
  // Only a shortfall we did NOT already know about points at mixed sections. Both
  // best-effort paths set their flag before this, so what is left here is the genuine
  // case: every check had a rung that passes on its governing member, and some other
  // member in the group still fails on the common cage. That is the group disagreeing
  // with itself, and it is worth naming — the other two are section verdicts and are
  // reported on the result instead.
  // A shortfall we did NOT already know about means the group disagrees with itself:
  // every ladder found a rung that passes on its own governing member, and some OTHER
  // member still fails on the common cage. That has a real and different remedy — split
  // the group — so it is worth saying out loud.
  //
  // It is still not worth discarding the cage for. The cage is the best common one the
  // group can have, and an engineer who can see it (and the DCRs it leaves) can tell at
  // a glance which members are the outliers. So: flagged, with the advice attached.
  let note: string | undefined;
  if (worstFlex > targetDCR + EPS && !belowTarget) {
    belowTarget = true;
    note = 'No single cage satisfies every member at the target — the group mixes members whose demands are too far apart. Splitting it will resolve this.';
  }
  if (worstShearFinal > targetDCR + EPS && !shearBelowTarget) {
    shearBelowTarget = true;
    note ??= 'No single cage satisfies every member at the target — the group mixes members whose demands are too far apart. Splitting it will resolve this.';
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
      wLimitFace: crackFor(m)?.wLimitFace,
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
          try { r = runDesign(m.section, m.material, { ...cage, sideBars: [side] }, lc, m.span, code, crackFor(m), cotTheta, ignoreTorsion); }
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

  // ── Final verification of the cage that is actually handed back ─────────────
  //
  // Everything above verifies the cage AS IT IS BUILT, one lever at a time. This runs the
  // finished article — skin bars included — through the engine once more and keeps
  // whatever it still says, because the cage the engineer sees is this one, and a
  // suggestion that quietly carries a clause it never mentioned is exactly how "Suggest
  // gave me a design the panel then flagged" happens.
  //
  // It also makes `overReinforced` honest. That flag was set only where the SEARCH knew
  // it had relaxed ρmax, and the cap it compared against was read once off each member's
  // PRE-EXISTING cage — but §9.3.3.1 is written on d, which the new cage changes. A
  // layout that stacked a third layer therefore sat under a limit computed for a
  // shallower one and came back unflagged. Asking the engine about the final cage costs
  // one sweep and cannot drift from what the member panel is about to say.
  const finalCage: RebarLayout = skin ? { ...cage, sideBars: [skin] } : cage;
  const residual = new Map<string, DesignWarning>();
  for (const m of beams) {
    for (const lc of m.loads) {
      let rr: DesignResults;
      try { rr = runDesign(m.section, m.material, finalCage, lc, m.span, code, crackFor(m), cotTheta, ignoreTorsion); }
      catch { continue; }
      for (const w of rr.warnings) {
        // Collapse on the clause and the SHAPE of the sentence: the messages embed each
        // row's own numbers, so keying on the text returns one entry per load row.
        const key = w.code + '|' + w.message.replace(/-?\d[\d,.]*/g, '#');
        const prev = residual.get(key);
        if (!prev || (w.severity === 'error' && prev.severity !== 'error')) residual.set(key, w);
      }
    }
  }
  const residualWarnings = [...residual.values()];
  const stillOverReinforced = residualWarnings.some(w => w.code === 'ACI §9.3.3');

  return {
    rebar: finalCage,
    worstDCRFlex: worstFlex,
    worstDCRShear: worstShearFinal,
    ...(isEC2 ? { worstDCRCrack: worstCrackFinal } : {}),
    steelLb,
    governingMemberId: governing.id,
    // Only present when true, so `if (r.overReinforced)` reads the same in every caller
    // and the field never appears on an ordinary, compliant suggestion.
    ...(overReinforced || stillOverReinforced ? { overReinforced: true } : {}),
    ...(belowTarget ? { belowTarget: true } : {}),
    ...(shearBelowTarget ? { shearBelowTarget: true } : {}),
    ...(sectionLimit ? { sectionLimit } : {}),
    ...(note ? { note } : {}),
    steps,
    // Everything still standing on the cage that is being handed back. Assembled here,
    // once, from the search's own verdicts — a caller should be able to render this list
    // and have said everything, rather than re-deriving the same sentences from four
    // booleans and getting one of them subtly wrong.
    ...(() => {
      const w: string[] = [];
      if (overReinforced) {
        w.push('Exceeds ρmax (over-reinforced) — carries the moment by crushing the concrete '
          + 'before the steel yields. Not code-compliant; enlarge the section.');
      }
      if (belowTarget) {
        w.push(`Flexure ${worstFlex.toFixed(2)} is over the ${targetDCR.toFixed(2)} target `
          + 'on the richest cage this section can hold — no arrangement of bars closes it.');
      }
      if (shearBelowTarget) {
        const worstT = Math.max(check.worstTors, check.worstVT);
        w.push(worstT > worstShearFinal
          ? `Torsion ${worstT.toFixed(2)} is over target with the tightest practical links — `
            + 'φTn rises only with A_t/s, so more legs do not help.'
          : `Shear ${worstShearFinal.toFixed(2)} is over the ${targetDCR.toFixed(2)} target with `
            + 'the tightest practical links.');
      }
      if (sectionLimit) w.push(sectionLimit);
      if (note) w.push(note);
      return w.length ? { warnings: w } : {};
    })(),
    ...(residualWarnings.length ? { residualWarnings } : {}),
  };
}
