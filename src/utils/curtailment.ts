/**
 * L/3 bar-curtailment check for a design group.
 *
 * A group's cage is sized for the WORST section — top bars for the peak hogging at
 * the supports, bottom bars for the peak sagging near mid-span. Away from those
 * points the moment falls off, so a designer can curtail (cut off) a portion of
 * the bars. A common rule of thumb keeps ~50 % continuous and cuts the rest. Using
 * the imported ETABS station moments this check asks, per face:
 *
 *   • TOP bars resist hogging (−M), largest at the supports. Their curtailment
 *     region is the MIDDLE third [L/3, 2L/3]: how much top steel does the hogging
 *     there actually require?
 *   • BOTTOM bars resist sagging (+M), largest at mid-span. Their curtailment
 *     region is the two END thirds [0, L/3] ∪ [2L/3, L]; we take the worse edge.
 *
 * "% needed" = As_required(region moment) / As_provided(face) × 100. The required
 * area comes straight from the design engine, so it already honours code As,min —
 * you can never curtail below the code minimum. Then:
 *
 *   • pctNeeded > 50 %  → 50 % of the bars do NOT envelope the region demand.
 *     RED flag: you must keep more than half continuous here.
 *   • pctNeeded ≤ 50 %  → the face is over-provided in that region.
 *     PURPLE flag: a curtailment opportunity ("you don't need that many bars here").
 *
 * Needs member.stationForces (populated on ETABS import). Members without station
 * data are skipped; a group with none yields no flags (hasStationData = false).
 */
import type { Member, RebarLayout, DesignCode, LoadCase, BarGroup, DesignResults } from '../types';
import { runDesign } from '../engines';
import { getBarArea } from './concreteDesign';

export type CurtailFlag = 'red' | 'purple';

/** The 50 % curtailment threshold (fraction of provided steel). */
export const CURTAIL_THRESHOLD_PCT = 50;

export interface FaceCurtailment {
  face: 'top' | 'bot';
  /** Region examined: top → middle third, bottom → worse end third. */
  region: 'middle-third' | 'end-thirds';
  /** Governing demand moment magnitude in the region (kip-ft). */
  demandMoment: number;
  /** Steel provided on this face by the group cage (in²). */
  asProvided: number;
  /** Steel the region demand requires, already floored at code As,min (in²). */
  asRequired: number;
  /** Code minimum steel for the section (in²) — the floor on any curtailment. */
  asMin: number;
  /** asRequired / asProvided × 100. */
  pctNeeded: number;
  /** What drives asRequired here — the region moment, or the code minimum. */
  governedBy: 'moment' | 'code-min';
  /** Does 50 % of the provided steel envelope the region demand? */
  fiftyEnvelopes: boolean;
  flag: CurtailFlag;
  /** Member whose region check governs this face. */
  governingMemberId: string;
}

export interface GroupCurtailment {
  /** True when at least one beam in the group carries station forces. */
  hasStationData: boolean;
  top: FaceCurtailment | null;
  bot: FaceCurtailment | null;
}

const EPS = 1e-9;

function faceArea(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((s, g) => s + Math.max(0, g.numBars) * getBarArea(g.barSize), 0);
}

/**
 * Peak hogging over the middle third and peak sagging over the worse end third,
 * across all combos, for one member. Null when the member has no usable stations.
 * Positions are taken as a fraction of the member's own station span, so a model
 * whose stations don't start exactly at x = 0 still bins correctly.
 */
function regionMoments(m: Member): { midHog: number; edgeSag: number } | null {
  const combos = m.stationForces ?? [];
  let minX = Infinity, maxX = -Infinity;
  for (const cf of combos) for (const st of cf.stations) {
    if (st.x < minX) minX = st.x;
    if (st.x > maxX) maxX = st.x;
  }
  if (!isFinite(minX) || maxX - minX < EPS) return null;
  const L = maxX - minX;
  let midHog = 0, edgeSag = 0;
  for (const cf of combos) for (const st of cf.stations) {
    const f = (st.x - minX) / L;             // 0..1 along the span
    const hog = Math.max(-st.M, 0);          // hogging magnitude (top bars)
    const sag = Math.max(st.M, 0);           // sagging magnitude (bottom bars)
    if (f >= 1 / 3 - EPS && f <= 2 / 3 + EPS) midHog = Math.max(midHog, hog);
    if (f < 1 / 3 - EPS || f > 2 / 3 + EPS)   edgeSag = Math.max(edgeSag, sag);
  }
  return { midHog, edgeSag };
}

/**
 * Analyse a design group's curtailment at the third-points. `rebar` is the group
 * cage (what the section card shows); `members` are the group's members (only
 * beams with station forces participate). Each face reports the WORST member.
 */
export function analyzeGroupCurtailment(
  members: Member[],
  rebar: RebarLayout,
  code: DesignCode,
): GroupCurtailment {
  const beams = members.filter(
    m => (m.memberType === 'beam' || !m.memberType) && (m.stationForces?.length ?? 0) > 0,
  );
  if (!beams.length) return { hasStationData: false, top: null, bot: null };

  const asTop = faceArea(rebar.topBars);
  const asBot = faceArea(rebar.botBars);
  let top: FaceCurtailment | null = null;
  let bot: FaceCurtailment | null = null;

  for (const m of beams) {
    const rm = regionMoments(m);
    if (!rm) continue;
    // One design pass with the region demands as a synthetic envelope: Mu_neg =
    // middle-third hogging (governs the top-bar region), Mu_pos = worse end-third
    // sagging (governs the bottom-bar region). As_req_* come back floored at As,min.
    const lc: LoadCase = {
      id: 'curtail', label: 'L/3 region',
      Mu_pos: rm.edgeSag, Mu_neg: rm.midHog, Vu: 0, Tu: 0, Pu: 0,
    };
    let r;
    try { r = runDesign(m.section, m.material, rebar, lc, m.span ?? 20, code, m.crackParams); }
    catch { continue; }

    if (asTop > EPS) {
      const pct = (r.As_req_neg / asTop) * 100;
      if (!top || pct > top.pctNeeded) {
        top = {
          face: 'top', region: 'middle-third', demandMoment: rm.midHog,
          asProvided: asTop, asRequired: r.As_req_neg, asMin: r.As_min, pctNeeded: pct,
          governedBy: r.As_req_neg > r.As_min + 1e-4 ? 'moment' : 'code-min',
          fiftyEnvelopes: pct <= CURTAIL_THRESHOLD_PCT,
          flag: pct > CURTAIL_THRESHOLD_PCT ? 'red' : 'purple',
          governingMemberId: m.id,
        };
      }
    }
    if (asBot > EPS) {
      const pct = (r.As_req_pos / asBot) * 100;
      if (!bot || pct > bot.pctNeeded) {
        bot = {
          face: 'bot', region: 'end-thirds', demandMoment: rm.edgeSag,
          asProvided: asBot, asRequired: r.As_req_pos, asMin: r.As_min, pctNeeded: pct,
          governedBy: r.As_req_pos > r.As_min + 1e-4 ? 'moment' : 'code-min',
          fiftyEnvelopes: pct <= CURTAIL_THRESHOLD_PCT,
          flag: pct > CURTAIL_THRESHOLD_PCT ? 'red' : 'purple',
          governingMemberId: m.id,
        };
      }
    }
  }
  return { hasStationData: true, top, bot };
}

// ── Opposite-end top reinforcement ───────────────────────────────────────────

/** Peak hogging near the start support (first third) and end support (last third). */
function endHogging(m: Member): { startHog: number; endHog: number } | null {
  const combos = m.stationForces ?? [];
  let minX = Infinity, maxX = -Infinity;
  for (const cf of combos) for (const st of cf.stations) {
    if (st.x < minX) minX = st.x;
    if (st.x > maxX) maxX = st.x;
  }
  if (!isFinite(minX) || maxX - minX < EPS) return null;
  const L = maxX - minX;
  let startHog = 0, endHog = 0;
  for (const cf of combos) for (const st of cf.stations) {
    const f = (st.x - minX) / L;
    const hog = Math.max(-st.M, 0);
    if (f <= 1 / 3 + EPS) startHog = Math.max(startHog, hog);
    if (f >= 2 / 3 - EPS) endHog = Math.max(endHog, hog);
  }
  return { startHog, endHog };
}

export interface OppositeEndResult {
  hasStationData: boolean;
  /** Which end governs the top steel (the "mark" side). */
  markEnd: 'start' | 'end';
  markDemand: number;         // hogging at the mark end, group max (kip-ft)
  oppositeDemand: number;     // hogging at the opposite end, group max (kip-ft)
  markAsProvided: number;     // mark-side top steel = the group cage (in²)
  oppositeAsRequired: number; // steel the opposite end needs, incl. code As,min (in²)
  /** The opposite end can carry its demand with LESS steel than the mark side. */
  reductionPossible: boolean;
  reductionPct: number;       // oppositeAsRequired / markAsProvided × 100
  governingMemberId: string;
  /** An opposite-end cage has been set on the group. */
  hasOpposite: boolean;
  oppositeAsProvided: number; // steel of the set opposite cage (in²)
  /** The opposite cage covers every beam's opposite-end hogging (DCR ≤ 1). */
  oppositeDcrMet: boolean;
  worstOppositeDcr: number;   // worst opposite-end flexural DCR with the opposite cage
}

const EMPTY_OPP: OppositeEndResult = {
  hasStationData: false, markEnd: 'start', markDemand: 0, oppositeDemand: 0,
  markAsProvided: 0, oppositeAsRequired: 0, reductionPossible: false, reductionPct: 0,
  governingMemberId: '', hasOpposite: false, oppositeAsProvided: 0, oppositeDcrMet: false, worstOppositeDcr: 0,
};

/**
 * Analyse whether the OPPOSITE (non-governing) end of a group's beams can take
 * less top steel than the mark side, and — when an opposite cage is given —
 * whether that cage covers the opposite-end hogging for every beam.
 *
 * `rebar.topBars` is the mark-side top steel. The two supports usually see
 * different hogging; the lower one (opposite end) can often be curtailed to a
 * smaller cage. Needs station forces; a group without them returns hasStationData
 * = false.
 */
export function analyzeOppositeEnd(
  members: Member[],
  rebar: RebarLayout,
  oppositeTopBars: BarGroup[] | undefined,
  code: DesignCode,
): OppositeEndResult {
  const beams = members.filter(
    m => (m.memberType === 'beam' || !m.memberType) && (m.stationForces?.length ?? 0) > 0,
  );
  if (!beams.length) return EMPTY_OPP;

  const asTop = faceArea(rebar.topBars);
  let groupStart = 0, groupEnd = 0;
  const perBeam: { m: Member; startHog: number; endHog: number }[] = [];
  for (const m of beams) {
    const e = endHogging(m);
    if (!e) continue;
    groupStart = Math.max(groupStart, e.startHog);
    groupEnd = Math.max(groupEnd, e.endHog);
    perBeam.push({ m, startHog: e.startHog, endHog: e.endHog });
  }
  if (!perBeam.length) return EMPTY_OPP;

  const markEnd: 'start' | 'end' = groupStart >= groupEnd ? 'start' : 'end';
  const markDemand = Math.max(groupStart, groupEnd);
  const oppositeDemand = Math.min(groupStart, groupEnd);
  const oppHogOf = (pb: { startHog: number; endHog: number }) => markEnd === 'start' ? pb.endHog : pb.startHog;

  // Steel required at the opposite end (max over beams, each on its own section).
  let oppositeAsRequired = 0, governingMemberId = perBeam[0].m.id;
  for (const pb of perBeam) {
    const lc: LoadCase = { id: 'opp', label: 'opposite end', Mu_pos: 0, Mu_neg: oppHogOf(pb), Vu: 0, Tu: 0, Pu: 0 };
    let r; try { r = runDesign(pb.m.section, pb.m.material, rebar, lc, pb.m.span ?? 20, code, pb.m.crackParams); } catch { continue; }
    if (r.As_req_neg > oppositeAsRequired) { oppositeAsRequired = r.As_req_neg; governingMemberId = pb.m.id; }
  }
  // Only an OPPORTUNITY when the two ends genuinely differ (asymmetric hogging)
  // AND the opposite end needs less steel than the full mark cage provides.
  const reductionPossible = asTop > EPS && oppositeAsRequired < asTop - 1e-3 && markDemand > oppositeDemand + 1e-3;

  const oppBars = oppositeTopBars ?? [];
  const oppositeAsProvided = faceArea(oppBars);
  const hasOpposite = oppBars.length > 0 && oppositeAsProvided > EPS;
  let worstOppositeDcr = 0;
  if (hasOpposite) {
    for (const pb of perBeam) {
      const lc: LoadCase = { id: 'opp', label: 'opposite end', Mu_pos: 0, Mu_neg: oppHogOf(pb), Vu: 0, Tu: 0, Pu: 0 };
      let r; try { r = runDesign(pb.m.section, pb.m.material, { ...rebar, topBars: oppBars }, lc, pb.m.span ?? 20, code, pb.m.crackParams); }
      catch { worstOppositeDcr = Infinity; continue; }
      worstOppositeDcr = Math.max(worstOppositeDcr, r.DCR_flex_neg);
    }
  }

  return {
    hasStationData: true, markEnd, markDemand, oppositeDemand,
    markAsProvided: asTop, oppositeAsRequired,
    reductionPossible, reductionPct: asTop > EPS ? (oppositeAsRequired / asTop) * 100 : 100,
    governingMemberId, hasOpposite, oppositeAsProvided,
    oppositeDcrMet: hasOpposite && worstOppositeDcr <= 1 + 1e-6, worstOppositeDcr,
  };
}

/** Suggest a reduced opposite-end cage: the mark bar size, fewest bars (≥2) that
 *  meet the opposite-end requirement. A sensible starting point the user tweaks. */
export function suggestOppositeCage(rebar: RebarLayout, opp: OppositeEndResult): BarGroup[] {
  const markLayer = rebar.topBars.find(b => b.numBars > 0) ?? { numBars: 2, barSize: 8 };
  const Ab = getBarArea(markLayer.barSize);
  const n = Math.max(2, Math.ceil(opp.oppositeAsRequired / Ab - 1e-6));
  const markTotal = rebar.topBars.reduce((s, b) => s + Math.max(0, b.numBars), 0);
  return [{ numBars: Math.min(n, Math.max(2, markTotal)), barSize: markLayer.barSize }];
}

/** One-line schedule note for a face's curtailment result. */
export function curtailmentNote(fc: FaceCurtailment): string {
  const pct = Math.round(fc.pctNeeded);
  const where = fc.face === 'top' ? 'middle third (L/3)' : 'end thirds (L/3)';
  const faceName = fc.face === 'top' ? 'Top' : 'Bottom';
  const min = fc.governedBy === 'code-min' ? ' (code As,min governs)' : '';
  return `${faceName} steel: ${pct}% required through the ${where}${min}; the balance may be curtailed (respect development + code minimum).`;
}

// ── Stepped moment capacity (for the L/3 diagram overlay) ─────────────────────

/** Fraction of a face's cage kept continuous through its curtailment region — the
 *  "~50% continuous" rule of thumb this module is built around (see file header). */
export const CURTAIL_CONTINUOUS_FRAC = 0.5;

export interface SteppedMomentCapacity {
  /** Hogging capacity with the full top cage — governs the END thirds (kip-ft). */
  negFull: number;
  /** Hogging capacity with the default ~50% continuous top cage (kip-ft). */
  negReduced: number;
  /** Hogging capacity through the MIDDLE third — the user's midThirdTopBars if set,
   *  otherwise the default `negReduced` (kip-ft). */
  negMid: number;
  /** Hogging capacity at the OPPOSITE end third — oppositeTopBars if set, else the
   *  full cage `negFull` (kip-ft). */
  negOpp: number;
  /** Which end third carries the reduced opposite cage (null when none is set). */
  oppEnd: 'start' | 'end' | null;
  /** Sagging capacity with the full bottom cage — governs the MIDDLE third (kip-ft). */
  posFull: number;
  /** Sagging capacity with the curtailed bottom cage — the END thirds (kip-ft). */
  posReduced: number;
  /** Continuous fraction assumed through the curtailment region (0..1). */
  continuousFrac: number;
}

/** The continuous cage kept through a face's curtailment region: the same bar
 *  size, `CURTAIL_CONTINUOUS_FRAC` of the area but never below code As,min and
 *  never above the full cage. */
export function continuousCage(bars: BarGroup[], asMin: number): BarGroup[] {
  const layer = bars.find(b => b.numBars > 0);
  if (!layer) return bars;
  const Ab = getBarArea(layer.barSize);
  if (Ab <= EPS) return bars;
  const fullN = bars.reduce((s, b) => s + Math.max(0, b.numBars), 0);
  const keepAs = Math.max(CURTAIL_CONTINUOUS_FRAC * faceArea(bars), asMin);
  const n = Math.max(2, Math.min(fullN, Math.ceil(keepAs / Ab - 1e-6)));
  return [{ numBars: n, barSize: layer.barSize }];
}

/** Fewest bars (≥2) of the given size whose area meets a code As,min — the floor
 *  every per-region cage edit must respect so minimum steel is never violated. */
export function minBarsForArea(asMin: number, barSize: number): number {
  const Ab = getBarArea(barSize);
  if (Ab <= EPS) return 2;
  return Math.max(2, Math.ceil(asMin / Ab - 1e-6));
}

/** A starting middle-third top cage: ~50% of the mark cage, floored at code
 *  As,min. The user then tweaks the percentage (bar count/size). */
export function suggestMidThirdCage(topBars: BarGroup[], asMin: number): BarGroup[] {
  return continuousCage(topBars, asMin);
}

/** φMn for one face after swapping in `cage` — capacity only, so a zero load. */
function faceCapacity(member: Member, code: DesignCode, span: number, face: 'top' | 'bot', cage: BarGroup[]): number | null {
  const lc: LoadCase = { id: 'cap', label: 'capacity', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 };
  try {
    const rebar = face === 'top' ? { ...member.rebar, topBars: cage } : { ...member.rebar, botBars: cage };
    const r = runDesign(member.section, member.material, rebar, lc, span, code, member.crackParams);
    return face === 'top' ? r.phi_Mn_neg : r.phi_Mn_pos;
  } catch { return null; }
}

/**
 * Full vs curtailed ±φMn for the stepped moment-capacity overlay. Top steel
 * resists hogging and is detailed for the two END thirds; through the MIDDLE
 * third it may be curtailed (default ~50% continuous, never below code As,min),
 * so the hogging capacity dips there. Bottom steel mirrors this — full across the
 * middle third, curtailed toward the ends. When the group carries explicit
 * per-region top cages (`opts.midThirdTopBars`, `opts.oppositeTopBars`) they
 * override the defaults, and the opposite cage is placed on the member's
 * lighter-hogging end. Capacity is load-independent, so a zero load case is used.
 */
export function steppedMomentCapacity(
  member: Member, result: DesignResults, code: DesignCode,
  opts?: { midThirdTopBars?: BarGroup[]; oppositeTopBars?: BarGroup[] },
): SteppedMomentCapacity {
  const span = member.span ?? 20;
  const negFull = result.phi_Mn_neg, posFull = result.phi_Mn_pos;
  const negReduced = Math.min(faceCapacity(member, code, span, 'top', continuousCage(member.rebar.topBars, result.As_min)) ?? negFull, negFull);
  const posReduced = Math.min(faceCapacity(member, code, span, 'bot', continuousCage(member.rebar.botBars, result.As_min)) ?? posFull, posFull);

  // Middle-third top: an explicit user cage overrides the 50% default.
  const negMid = opts?.midThirdTopBars?.length
    ? Math.min(faceCapacity(member, code, span, 'top', opts.midThirdTopBars) ?? negReduced, negFull)
    : negReduced;

  // Opposite-end top: an explicit user cage sits on the member's lighter end.
  let negOpp = negFull, oppEnd: 'start' | 'end' | null = null;
  if (opts?.oppositeTopBars?.length) {
    negOpp = Math.min(faceCapacity(member, code, span, 'top', opts.oppositeTopBars) ?? negFull, negFull);
    const e = endHogging(member);
    oppEnd = e ? (e.startHog <= e.endHog ? 'start' : 'end') : null;
  }

  return { negFull, negReduced, negMid, negOpp, oppEnd, posFull, posReduced, continuousFrac: CURTAIL_CONTINUOUS_FRAC };
}
