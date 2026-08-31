/**
 * The chunked Suggest sweep must be the SAME sweep.
 *
 * `suggestAllGroupsChunked` exists so the status bar can narrate the run and the user
 * can hold it at a group boundary. It must not become a second implementation: both
 * drivers share `createSweep`, and this pins that they agree — same cages, same note,
 * same per-group errors — because a "progress" variant that quietly sizes differently
 * is the worst outcome available here.
 */
import { describe, it, expect } from 'vitest';
import { suggestAllGroups, suggestAllGroupsChunked } from '../design.js';
import { defaultProject } from '../../utils/sampleData';
import type { Member } from '../../types';

/** A model big enough to have several groups, some of which are deliberately empty. */
function model(nGroups: number, perGroup: number, rows: number) {
  const base = defaultProject.members[0];
  const members: Member[] = [];
  const groups: { id: string; label: string; memberIds: string[] }[] = [];
  for (let g = 0; g < nGroups; g++) {
    const ids: string[] = [];
    // Every third group is left empty — the sweep skips those silently, and the
    // chunked driver must skip them at the same points.
    const n = g % 3 === 0 ? 0 : perGroup;
    for (let i = 0; i < n; i++) {
      const id = `m-${g}-${i}`;
      ids.push(id);
      members.push({
        ...base, id, label: id,
        loads: Array.from({ length: rows }, (_, r) => ({
          id: `lc${r}`, label: `LC${r}`,
          Mu_pos: 90 + r * 11 + g, Mu_neg: 40 + r * 5, Vu: 30 + r * 3, Tu: r % 4, Pu: 0, x: r,
        })),
      } as Member);
    }
    groups.push({ id: `g${g}`, label: `Group ${g}`, memberIds: ids });
  }
  return { members, groups };
}

const CODE = defaultProject.code;

describe('chunked == synchronous', () => {
  it('produces the same cages, the same note and the same errors', async () => {
    const { members, groups } = model(9, 4, 12);
    const sync = suggestAllGroups(groups, members, CODE, 'us', {}, undefined, {});
    const chunked = await suggestAllGroupsChunked(groups, members, CODE, 'us', {}, undefined, {}, {});

    expect(chunked.note).toBe(sync.note);
    expect([...chunked.rebarByGroup.keys()]).toEqual([...sync.rebarByGroup.keys()]);
    for (const [gid, rebar] of sync.rebarByGroup) {
      expect(chunked.rebarByGroup.get(gid)).toEqual(rebar);
    }
    expect([...chunked.errorByGroup.keys()]).toEqual([...sync.errorByGroup.keys()]);
  });

  it('holds for a model where every group is empty (the "nothing to size" note)', async () => {
    const groups = [{ id: 'g0', label: 'Empty', memberIds: [] }];
    const sync = suggestAllGroups(groups, [], CODE, 'us', {}, undefined, {});
    const chunked = await suggestAllGroupsChunked(groups, [], CODE, 'us', {}, undefined, {}, {});
    expect(chunked.note).toBe(sync.note);
    expect(sync.note).toMatch(/No groups with designed beams/);
  });
});

describe('the progress it reports', () => {
  it('counts every group, in order, and finishes on the total', async () => {
    const { members, groups } = model(6, 3, 8);
    const seen: Array<[number, number, string | null]> = [];
    await suggestAllGroupsChunked(groups, members, CODE, 'us', {}, undefined, {}, {
      onProgress: (done, total, label) => seen.push([done, total, label]),
    });
    // One call before each group, plus a final one at completion.
    expect(seen).toHaveLength(groups.length + 1);
    expect(seen.map(s => s[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seen.every(s => s[1] === groups.length)).toBe(true);
    expect(seen[0][2]).toBe('Group 0');
    expect(seen[seen.length - 1][2]).toBeNull();   // the "applying" step
  });

  it('awaits the gate between groups, so a pause can land there', async () => {
    const { members, groups } = model(5, 2, 6);
    let gates = 0;
    await suggestAllGroupsChunked(groups, members, CODE, 'us', {}, undefined, {}, {
      gate: async () => { gates++; },
    });
    expect(gates).toBe(groups.length);
  });

  it('runs without hooks at all — the sync callers pass none', async () => {
    const { members, groups } = model(3, 2, 4);
    const r = await suggestAllGroupsChunked(groups, members, CODE, 'us', {}, undefined, {});
    expect(r.note).toBeTruthy();
  });
});
