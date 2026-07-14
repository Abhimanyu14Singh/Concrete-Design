/**
 * The distilled, plain-JSON payload the Group Dashboard consumes — small enough
 * to relay over IPC to a popped-out window (a few scalars per group/member, never
 * the full model). Built in ModelMapView off already-computed design results, so
 * no extra runDesign happens here.
 */
import type {
  DesignGroup, Member, SectionDimensions, RebarLayout, DesignResults, DesignWarning, DesignCode,
} from '../types';
import { flexSteelRatioPct, steelWeightPerFt } from './autoGroup';
import { modeDCRs, worstOf } from '../components/Dashboard/dashboardShared';

export interface DashboardGroup {
  id: string;
  label: string;
  color?: string;
  source?: 'auto' | 'manual';
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
      if (r) {
        const md = modeDCRs(r, code);
        maxFlexPos = Math.max(maxFlexPos, md.flexPos);
        maxFlexNeg = Math.max(maxFlexNeg, md.flexNeg);
        maxShear = Math.max(maxShear, md.shear);
      }
    }
    const repMember = (govId ? memberById.get(govId) : undefined) ?? beams[0] ?? gMembers[0];
    const section = repMember?.section ?? FALLBACK_SECTION;
    const rebar = g.rebar ?? repMember?.rebar ?? { topBars: [], botBars: [] };
    for (const m of gMembers) memberGroupId.set(m.id, g.id);
    return {
      id: g.id,
      label: g.label,
      color: g.color,
      source: g.source,
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
      modeDCRs: modeDCRs(r, code),
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
