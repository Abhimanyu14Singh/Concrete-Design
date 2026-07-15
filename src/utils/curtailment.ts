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
import type { Member, RebarLayout, DesignCode, LoadCase } from '../types';
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

/** One-line schedule note for a face's curtailment result. */
export function curtailmentNote(fc: FaceCurtailment): string {
  const pct = Math.round(fc.pctNeeded);
  const where = fc.face === 'top' ? 'middle third (L/3)' : 'end thirds (L/3)';
  const faceName = fc.face === 'top' ? 'Top' : 'Bottom';
  const min = fc.governedBy === 'code-min' ? ' (code As,min governs)' : '';
  return `${faceName} steel: ${pct}% required through the ${where}${min}; the balance may be curtailed (respect development + code minimum).`;
}
