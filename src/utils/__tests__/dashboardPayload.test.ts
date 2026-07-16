/**
 * Group-dashboard detail rows must resolve through a group's OWN memberIds, not a
 * reverse per-member `groupId` tag. Regression for the "0 beams / No beams in this
 * group" bug: a beam shared by two design groups is tagged in `member.groupId` to
 * only the LAST group that claimed it (buildDashboardPayload's single-tag Map), so
 * the earlier group's filter-by-tag table came back empty even though its card
 * counted the beams and showed their DCRs.
 */
import { describe, it, expect } from 'vitest';
import { membersForGroup } from '../dashboardPayload';
import type { DashboardPayload, DashboardGroup, DashboardMember } from '../dashboardPayload';
import type { SectionDimensions, RebarLayout } from '../../types';

const SEC: SectionDimensions = { type: 'rectangular_beam', b: 20, h: 48, coverClear: 1.5, stirrupDia: 4 };
const REB: RebarLayout = { topBars: [{ numBars: 3, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }] };

const group = (id: string, memberIds: string[]): DashboardGroup => ({
  id, label: id, section: SEC, rebar: REB, memberIds,
  govDCR: 1, maxFlexPos: 1, maxFlexNeg: 0.5, maxShear: 0.4,
  rhoTop: 0.4, rhoBot: 0.6, steelWtLbFt: 30, beamCount: memberIds.length,
  errorBeamCount: 0,
  curtailment: { hasStationData: false, top: null, bot: null },
  oppositeEnd: { hasStationData: false, markEnd: 'start', markDemand: 0, oppositeDemand: 0, markAsProvided: 0, oppositeAsRequired: 0, reductionPossible: false, reductionPct: 0, governingMemberId: '', hasOpposite: false, oppositeAsProvided: 0, oppositeDcrMet: false, worstOppositeDcr: 0 },
  asMin: 0,
  notePinned: { top: false, bot: false },
});
const member = (id: string, groupId: string): DashboardMember => ({
  id, label: id, groupId, b: 20, h: 48,
  modeDCRs: { flexPos: 1, flexNeg: 0.5, shear: 0.4 },
  maxDCR: 1, status: 'OK', warnings: [],
});

// Two groups sharing every beam. buildDashboardPayload tags each member to the
// LAST group in the array (g2) — the exact lossy state that reached the UI.
const payload: DashboardPayload = {
  code: 'ACI318-19', units: 'imperial',
  groups: [group('g1', ['b1', 'b2', 'b3']), group('g2', ['b1', 'b2', 'b3'])],
  members: [member('b1', 'g2'), member('b2', 'g2'), member('b3', 'g2')],
};

describe('membersForGroup — overlap-safe detail resolution', () => {
  it("resolves ALL of an earlier group's beams even when tagged to a later group", () => {
    expect(membersForGroup(payload, 'g1').map(m => m.id)).toEqual(['b1', 'b2', 'b3']);
    expect(membersForGroup(payload, 'g2').map(m => m.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('the old filter-by-groupId is what emptied the table (the reported bug)', () => {
    const oldWay = (gid: string) => payload.members.filter(m => m.groupId === gid).map(m => m.id);
    expect(oldWay('g1')).toEqual([]);                    // ← "0 beams / No beams in this group"
    expect(oldWay('g2')).toEqual(['b1', 'b2', 'b3']);
  });

  it('returns [] for no selection or an unknown group', () => {
    expect(membersForGroup(payload, null)).toEqual([]);
    expect(membersForGroup(payload, 'nope')).toEqual([]);
  });

  it('dedupes repeated memberIds and skips members with no design result', () => {
    const p: DashboardPayload = {
      code: 'ACI318-19', units: 'imperial',
      groups: [group('g', ['b1', 'b1', 'b2', 'bMissing'])],
      members: [member('b1', 'g'), member('b2', 'g')], // bMissing has no design result
    };
    expect(membersForGroup(p, 'g').map(m => m.id)).toEqual(['b1', 'b2']);
  });
});
