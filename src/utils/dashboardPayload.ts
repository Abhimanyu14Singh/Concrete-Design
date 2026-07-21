/**
 * The distilled, plain-JSON payload the Group Dashboard consumes — small enough
 * to relay over IPC to a popped-out window (a few scalars per group/member, never
 * the full model). Built in ModelMapView off already-computed design results; the
 * only extra engine work is the per-group L/3 curtailment analysis (one design
 * pass per member over the third-point demands).
 */
import type {
  DesignGroup, Member, SectionDimensions, RebarLayout, DesignResults, DesignWarning, DesignCode, BarGroup,
} from '../types';
import { flexSteelRatioPct, steelWeightPerFt } from './autoGroup';
import { modeDCRs, worstOf } from '../components/Dashboard/dashboardShared';
import { analyzeGroupCurtailment, analyzeOppositeEnd, regionCageDcr, continuousCage, type GroupCurtailment, type OppositeEndResult } from '../utils/curtailment';

export interface DashboardGroup {
  id: string;
  label: string;
  color?: string;
  source?: 'auto' | 'manual';
  /** Governing face (split-by-face groups) → shown as a (T)/(B) badge. */
  face?: 'top' | 'bot';
  /** Representative (governing beam's) section, for the card drawing. */
  section: SectionDimensions;
  /** The group's cage template (what inline edits mutate). */
  rebar: RebarLayout;
  memberIds: string[];
  govDCR: number;
  /** Worst per-mode DCR across the group's beams (M⁺ / M⁻ / V). */
  maxFlexPos: number;
  maxFlexNeg: number;
  maxShear: number;
  govResult?: DesignResults;
  rhoTop: number;
  rhoBot: number;
  steelWtLbFt: number;
  beamCount: number;
  /** Beams in the group whose design fails (status NG) — the error count. */
  errorBeamCount: number;
  /** Beams in the group that are merely warned (not NG, but Warning / carry warnings). */
  warnBeamCount: number;
  /** Engineer sign-off — the group's NG/warnings are presented as "Reviewed". */
  reviewed: boolean;
  /** L/3 curtailment analysis for the group cage (red/purple flags + %). */
  curtailment: GroupCurtailment;
  /** Opposite-(non-governing-)end top-steel analysis (can it take less?). */
  oppositeEnd: OppositeEndResult;
  /** The reduced opposite-end top cage the user set (if any). */
  oppositeTopBars?: BarGroup[];
  /** The reduced middle-third top cage the user set (if any). */
  midThirdTopBars?: BarGroup[];
  /** The reduced end-third bottom cage the user set (if any). */
  endThirdBotBars?: BarGroup[];
  /** Exact worst middle-third hogging DCR carried by the middle-third top cage
   *  (set only when that cage is set). From a per-beam design pass, not an As-ratio. */
  midThirdDcr?: number;
  /** Exact worst end-third sagging DCR carried by the end-third bottom cage
   *  (explicit or the auto ~continuous cage; set only when the ⚑ bottom note is pinned). */
  endThirdDcr?: number;
  /** Code minimum flexural steel area (in²) for the group's section — the floor
   *  every per-region cage edit must respect so min steel is never violated. */
  asMin: number;
  /** Which faces the user pinned to the schedule notes. */
  notePinned: { top: boolean; bot: boolean };
}

export interface DashboardMember {
  id: string;
  label: string;
  groupId: string;
  b: number;
  h: number;
  modeDCRs: { flexPos: number; flexNeg: number; shear: number; wk?: number };
  maxDCR: number;
  status: DesignResults['status'];
  warnings: DesignWarning[];
}

export interface DashboardPayload {
  code: DesignCode;
  units: 'imperial' | 'si';
  groups: DashboardGroup[];
  members: DashboardMember[];
}

export type DashboardCommand =
  | { type: 'select-group'; groupId: string | null }
  | { type: 'apply-rebar'; groupId: string; rebar: RebarLayout }
  | { type: 'move-member'; memberId: string; groupId: string }
  | { type: 'create-group-for-member'; memberId: string }
  | { type: 'suggest-all' }
  | { type: 'toggle-curtailment-note'; groupId: string; face: 'top' | 'bot'; on: boolean }
  | { type: 'set-opposite-top'; groupId: string; bars: BarGroup[] | null }
  | { type: 'set-mid-third-top'; groupId: string; bars: BarGroup[] | null }
  | { type: 'set-end-third-bot'; groupId: string; bars: BarGroup[] | null }
  | { type: 'set-reviewed'; groupId: string; on: boolean }
  | { type: 'open-member'; memberId: string }
  | { type: 'pop-in' }
  | { type: 'ready' };

const FALLBACK_SECTION: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 };

/**
 * Build the dashboard payload. `designResultsById`/`dcrById` are the beams-only
 * governing results already computed by ModelMapView, so the dashboard (this pass)
 * naturally covers beams.
 */
export function buildDashboardPayload(
  groups: DesignGroup[],
  members: Member[],
  designResultsById: Record<string, DesignResults>,
  dcrById: Record<string, number>,
  /** Worst per-mode DCR across ALL load rows, per member — governs the M⁺/M⁻/V
   *  chips so they never read green while a different row pushes the mode past 1. */
  modeDcrById: Record<string, { flexPos: number; flexNeg: number; shear: number; wk: number }>,
  code: DesignCode,
  units: 'imperial' | 'si',
): DashboardPayload {
  const memberById = new Map(members.map(m => [m.id, m]));
  const memberGroupId = new Map<string, string>();

  const payloadGroups: DashboardGroup[] = groups.map(g => {
    const gMembers = g.memberIds.map(id => memberById.get(id)).filter((m): m is Member => !!m);
    const beams = gMembers.filter(m => m.memberType === 'beam');
    // Governing (worst-DCR) member drives the representative section + metrics.
    // Alongside it, track the worst per-mode DCR (M⁺ / M⁻ / V) across the group so
    // the card can surface all three instead of a single governing number.
    let govDCR = 0, govId: string | null = null;
    let maxFlexPos = 0, maxFlexNeg = 0, maxShear = 0;
    for (const m of gMembers) {
      const d = dcrById[m.id] ?? 0;
      if (d >= govDCR) { govDCR = d; govId = m.id; }
      const r = designResultsById[m.id];
      // Per-mode governing across all rows (fallback to the representative row only
      // when the precomputed map is absent).
      const md = modeDcrById[m.id] ?? (r ? modeDCRs(r, code) : null);
      if (md) {
        maxFlexPos = Math.max(maxFlexPos, md.flexPos);
        maxFlexNeg = Math.max(maxFlexNeg, md.flexNeg);
        maxShear = Math.max(maxShear, md.shear);
      }
    }
    const repMember = (govId ? memberById.get(govId) : undefined) ?? beams[0] ?? gMembers[0];
    const section = repMember?.section ?? FALLBACK_SECTION;
    const rebar = g.rebar ?? repMember?.rebar ?? { topBars: [], botBars: [] };
    for (const m of gMembers) memberGroupId.set(m.id, g.id);

    // Exact per-region DCRs (one design pass per beam vs its region demand). Only
    // computed for the cage the card actually shows: the middle-third top cage when
    // set, and the end-third bottom cage (explicit or auto) when the ⚑ bottom note
    // is pinned — so the rows read a true moment DCR, not an area ratio.
    const asMin = (repMember ? designResultsById[repMember.id]?.As_min : undefined) ?? 0;
    const midThirdDcr = g.midThirdTopBars?.length
      ? regionCageDcr(beams, rebar, g.midThirdTopBars, 'mid-top', code) : undefined;
    const endThirdDcr = g.curtailmentNotes?.bot
      ? regionCageDcr(beams, rebar, g.endThirdBotBars?.length ? g.endThirdBotBars : continuousCage(rebar.botBars, asMin), 'end-bot', code)
      : undefined;
    return {
      id: g.id,
      label: g.label,
      color: g.color,
      source: g.source,
      face: g.face,
      section,
      rebar,
      memberIds: g.memberIds.slice(),
      govDCR,
      maxFlexPos,
      maxFlexNeg,
      maxShear,
      govResult: govId ? designResultsById[govId] : undefined,
      rhoTop: repMember ? flexSteelRatioPct(repMember, 'top') : 0,
      rhoBot: repMember ? flexSteelRatioPct(repMember, 'bot') : 0,
      steelWtLbFt: repMember ? steelWeightPerFt(repMember).totalLbFt : 0,
      beamCount: beams.length,
      errorBeamCount: beams.filter(m => designResultsById[m.id]?.status === 'NG').length,
      warnBeamCount: beams.filter(m => {
        const r = designResultsById[m.id];
        return r && r.status !== 'NG' && (r.status === 'Warning' || r.warnings.length > 0);
      }).length,
      reviewed: !!g.reviewed,
      curtailment: analyzeGroupCurtailment(beams, rebar, code),
      oppositeEnd: analyzeOppositeEnd(beams, rebar, g.oppositeTopBars, code),
      oppositeTopBars: g.oppositeTopBars,
      midThirdTopBars: g.midThirdTopBars,
      endThirdBotBars: g.endThirdBotBars,
      midThirdDcr,
      endThirdDcr,
      asMin,
      notePinned: { top: !!g.curtailmentNotes?.top, bot: !!g.curtailmentNotes?.bot },
    };
  });

  const payloadMembers: DashboardMember[] = [];
  for (const m of members) {
    const gId = memberGroupId.get(m.id);
    if (!gId) continue;
    const r = designResultsById[m.id];
    if (!r) continue; // no design result (columns are skipped upstream — beams only this pass)
    payloadMembers.push({
      id: m.id,
      label: m.label,
      groupId: gId,
      b: m.section.b,
      h: m.section.h ?? 0,
      // Per-mode governing DCRs (worst M⁺/M⁻/V across all rows), not the single
      // representative row — so a mode that peaks on another station reads red here.
      modeDCRs: modeDcrById[m.id]
        ? { flexPos: modeDcrById[m.id].flexPos, flexNeg: modeDcrById[m.id].flexNeg, shear: modeDcrById[m.id].shear, wk: code === 'EN1992-1-1' ? modeDcrById[m.id].wk : undefined }
        : modeDCRs(r, code),
      maxDCR: dcrById[m.id] ?? worstOf(r),
      status: r.status,
      warnings: r.warnings,
    });
  }

  return { code, units, groups: payloadGroups, members: payloadMembers };
}

/**
 * Resolve a group's beam rows for the dashboard detail table. Looks members up by
 * the group's OWN memberIds against the flat members list (which carries one entry
 * per member) — never a reverse per-member `groupId` tag. A beam that belongs to
 * more than one design group is tagged in `member.groupId` to only the LAST group
 * that claimed it, so filtering by that tag empties every earlier group's table
 * (the "0 beams / No beams in this group" bug). Deduped, order-preserving, and
 * silently skips members with no design result (not present in `payload.members`).
 */
export function membersForGroup(payload: DashboardPayload, groupId: string | null): DashboardMember[] {
  if (!groupId) return [];
  const group = payload.groups.find(g => g.id === groupId);
  if (!group) return [];
  const byId = new Map(payload.members.map(m => [m.id, m]));
  const out: DashboardMember[] = [];
  const seen = new Set<string>();
  for (const id of group.memberIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const m = byId.get(id);
    if (m) out.push(m);
  }
  return out;
}
