/**
 * A Suggest sweep must be readable as NUMBERS, not only as a sentence.
 *
 * The sweep's `note` is written for the status bar: it names the groups that failed, so
 * on a real model it spends its whole length listing them and the REASON falls off the
 * end. A 2026-08-27 session showed exactly that — "Suggested 2/12 groups · 10 unresolved
 * (LOWER ROOF · B18X60-5KSI, …" truncated mid-list, leaving no way to tell whether ten
 * groups hit the flexural ladder or the crack limit. Those are opposite problems.
 *
 * `stats` is the answer: the same sweep counted by `SuggestError['kind']`, carrying no
 * labels at all. This pins the two properties that make it worth having — the counts
 * reconcile with the sweep, and the reasons are machine-readable codes.
 */
import { describe, it, expect } from 'vitest';
import { suggestAllGroups, suggestAllGroupsChunked } from '../design.js';
import { defaultProject } from '../../utils/sampleData';
import type { Member } from '../../types';

const CODE = defaultProject.code;

/**
 * `scale` multiplies the demand. At 1 the sample beam is satisfiable; pushed far enough
 * it runs off the end of every ladder, which is how the failure branches are reached
 * without hand-building a section.
 */
function model(nGroups: number, perGroup: number, scale: number) {
  const base = defaultProject.members[0];
  const members: Member[] = [];
  const groups: { id: string; label: string; memberIds: string[] }[] = [];
  for (let g = 0; g < nGroups; g++) {
    const ids: string[] = [];
    for (let i = 0; i < perGroup; i++) {
      const id = `m-${g}-${i}`;
      ids.push(id);
      members.push({
        ...base, id, label: id,
        loads: [{
          id: 'lc0', label: 'LC0',
          Mu_pos: 90 * scale, Mu_neg: 40 * scale, Vu: 30 * scale, Tu: 0, Pu: 0, x: 0,
        }],
      } as Member);
    }
    groups.push({ id: `g${g}`, label: `Group ${g}`, memberIds: ids });
  }
  return { members, groups };
}

describe('sweep stats', () => {
  it('counts resolved and failed so they reconcile with what was applied', () => {
    const { members, groups } = model(4, 2, 1);
    const r = suggestAllGroups(groups, members, CODE, 'us', {}, undefined, {});
    expect(r.stats.attempted).toBe(r.stats.resolved + r.stats.failed);
    expect(r.stats.resolved).toBe(r.rebarByGroup.size);
    expect(r.stats.failed).toBe(r.errorByGroup.size);
  });

  it('reports every failure under a machine-readable reason code', () => {
    const { members, groups } = model(3, 2, 60);
    const r = suggestAllGroups(groups, members, CODE, 'us', {}, undefined, {});
    // The counts in `reasons` account for every failure, with none falling into the
    // `unclassified` bucket — that bucket existing at all is the tripwire for a
    // SuggestError return that was added without a `kind`. It holds whether the sweep
    // failed once or not at all, which is what makes it a tripwire rather than a
    // property of this particular fixture.
    const total = Object.values(r.stats.reasons).reduce((a, b) => a + b, 0);
    expect(total).toBe(r.stats.failed);
    expect(r.stats.reasons.unclassified).toBeUndefined();
    for (const code of Object.keys(r.stats.reasons)) {
      expect(code).toMatch(/^[a-z-]+$/);
    }
  });

  it('counts a cage that came back FLAGGED rather than losing it in `resolved`', () => {
    // A demand far past every ladder used to refuse outright. It now returns the best
    // cage the section can hold — which means `resolved` alone would report it as a
    // clean pass. These counters are what stop that: a sweep of hopeless groups must
    // still say, in numbers, that not one of them is a pass.
    const { members, groups } = model(3, 2, 60);
    const r = suggestAllGroups(groups, members, CODE, 'us', {}, undefined, {});
    expect(r.stats.attempted).toBe(r.stats.resolved + r.stats.failed);
    if (r.stats.resolved > 0) {
      // The two counters are mutually exclusive, so they sum to at most `resolved` —
      // if they could overlap, one problem group would be reported as two.
      const flagged = (r.stats.belowTarget ?? 0) + (r.stats.sectionLimited ?? 0);
      expect(flagged).toBeGreaterThan(0);
      expect(flagged).toBeLessThanOrEqual(r.stats.resolved);
    }
  });

  it('carries no group labels — the reason keys are codes, not names', () => {
    const { members, groups } = model(3, 2, 60);
    const r = suggestAllGroups(groups, members, CODE, 'us', {}, undefined, {});
    const asText = JSON.stringify(r.stats);
    for (const g of groups) expect(asText).not.toContain(g.label);
    // ...while `errorByGroup` still carries them, because the UI needs to say WHICH
    // group. The split between the two is the point.
    expect([...r.errorByGroup.values()].every(e => !!e.label)).toBe(true);
  });

  it('is identical between the synchronous and chunked drivers', async () => {
    const { members, groups } = model(4, 2, 1);
    const sync = suggestAllGroups(groups, members, CODE, 'us', {}, undefined, {});
    const chunked = await suggestAllGroupsChunked(groups, members, CODE, 'us', {}, undefined, {}, {});
    expect(chunked.stats).toEqual(sync.stats);
  });

  it('reports an all-empty sweep as nothing attempted rather than as failure', () => {
    const groups = [{ id: 'g0', label: 'Empty', memberIds: [] }];
    const r = suggestAllGroups(groups, [], CODE, 'us', {}, undefined, {});
    expect(r.stats).toMatchObject({ attempted: 0, resolved: 0, failed: 0, reasons: {} });
  });

  it('rounds the torsion figure instead of logging float noise', () => {
    const { members, groups } = model(2, 2, 1);
    const r = suggestAllGroups(groups, members, CODE, 'us', {}, undefined, {});
    const s = String(r.stats.worstTorsionAfter);
    expect(s).toMatch(/^\d+(\.\d{1,2})?$/);
  });
});
