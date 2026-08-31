/**
 * Does the .SCO export account for the per-L/3 longitudinal cages?
 *
 * The group card lets an engineer curtail three regions independently —
 * `midThirdTopBars`, `oppositeTopBars`, `endThirdBotBars`. A .SCO describes ONE
 * prismatic section, so honouring them means one file per distinct region section,
 * carrying that region's cage, that region's link spacing, and only the load rows
 * whose station falls in it.
 *
 * This file used to DOCUMENT THE GAP: the export split by link spacing alone and
 * carried the mark-end cage into every file, so a top cage curtailed to 2-#9 through
 * mid-span was still verified as 6-#9 there. It now pins the fix.
 */
import { describe, it, expect } from 'vitest';
import { buildGroupEnvelopeScoFiles, buildGroupScoFiles } from '../scoBatch';
import type { DesignGroup, Member, Project, RebarLayout } from '../../../types';

const rebar: RebarLayout = {
  topBars: [{ numBars: 6, barSize: 9 }],
  botBars: [{ numBars: 8, barSize: 9 }],
  ties: { barSize: 4, spacing: 4, legs: 2 },
  // 4" / 8" / 4" — two DISTINCT spacings across three zones.
  tieZones: [{ spacing: 4 }, { spacing: 8 }, { spacing: 4 }],
};

const member: Member = {
  id: 'B1', label: 'B1', memberType: 'beam', span: 30,
  material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 },
  section: { type: 'rectangular_beam', b: 20, h: 32, coverClear: 1.5, stirrupDia: 4 },
  rebar,
  // One row in each third, so the region split has something to bucket on.
  loads: [
    { id: 'r0', label: 'end',  x: 2,  Mu_pos: 40,  Mu_neg: 260, Vu: 90, Tu: 0, Pu: 0 },
    { id: 'r1', label: 'mid',  x: 15, Mu_pos: 300, Mu_neg: 30,  Vu: 20, Tu: 0, Pu: 0 },
    { id: 'r2', label: 'end2', x: 28, Mu_pos: 40,  Mu_neg: 240, Vu: 85, Tu: 0, Pu: 0 },
  ],
};

const project = { id: 'p', name: 'P', code: 'ACI318-19', date: '2026-01-01', members: [member] } as unknown as Project;

const plainGroup: DesignGroup = { id: 'g1', label: 'G1', memberIds: ['B1'], rebar };
const curtailedGroup: DesignGroup = {
  ...plainGroup,
  midThirdTopBars: [{ numBars: 2, barSize: 9 }],   // top curtailed through mid-span
  oppositeTopBars: [{ numBars: 3, barSize: 9 }],   // lighter cage at the far end
  endThirdBotBars: [{ numBars: 3, barSize: 9 }],   // bottom curtailed toward supports
};

/** Read a `Key\t value` field — the key must START a field. */
function param(sco: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sco.match(new RegExp(`(?:^|\\t)${esc}\\t ?([^\\t\\r\\n]*)`, 'm'))?.[1].trim() ?? null;
}
/** Total bars on a face — summed over the stacked layers, because a wide face is
 *  split across NT/NB(1,1..5) (8 #9s in a 20" web go out as 7 + 1). */
function faceBars(sco: string, face: 'NT' | 'NB'): number {
  let n = 0;
  for (let j = 1; j <= 5; j++) n += Number(param(sco, `Bm ${face}(1,${j})`) ?? 0);
  return n;
}
/** The Vfz of every Sectional Loads row, to see WHICH rows a file carries. */
function shears(sco: string): number[] {
  const start = sco.indexOf('@Table@16@');
  return sco.slice(start, sco.indexOf('@EndTable@', start)).split(/\r?\n/)
    .filter(l => /^\s*\d+\t/.test(l))
    .map(l => +l.split('\t')[3].trim());
}

describe('.SCO export honours the per-L/3 longitudinal cages', () => {
  it('three distinct region sections → THREE files, one per region', () => {
    const files = buildGroupEnvelopeScoFiles([curtailedGroup], [member], 'ACI318-19', project);
    expect(files.map(f => f.fileName)).toEqual(['G1_mark.SCO', 'G1_mid.SCO', 'G1_opp.SCO']);
    expect(files.map(f => f.regions)).toEqual([['mark'], ['mid'], ['opp']]);
  });

  it('each file carries ITS OWN cage, not the mark-end one', () => {
    const by = Object.fromEntries(
      buildGroupEnvelopeScoFiles([curtailedGroup], [member], 'ACI318-19', project)
        .map(f => [f.fileName, f.text]));
    // #9 is bar-table index 8 on both faces; the COUNTS are what curtails.
    expect(faceBars(by['G1_mark.SCO'], 'NT')).toBe(6);   // full top at the mark end
    expect(faceBars(by['G1_mark.SCO'], 'NB')).toBe(3);   // bottom curtailed at supports
    expect(faceBars(by['G1_mid.SCO'], 'NT')).toBe(2);    // top curtailed through mid-span
    expect(faceBars(by['G1_mid.SCO'], 'NB')).toBe(8);    // full bottom at mid-span
    expect(faceBars(by['G1_opp.SCO'], 'NT')).toBe(3);    // lighter far-end top
    expect(faceBars(by['G1_opp.SCO'], 'NB')).toBe(3);
    // …and the bar SIZE is #9 (index 8) throughout — only the counts change.
    for (const t of Object.values(by)) expect(param(t, 'Bm DT(1,1)')).toBe('8');
  });

  it('each file carries its own LINK spacing and only its own load rows', () => {
    const by = Object.fromEntries(
      buildGroupEnvelopeScoFiles([curtailedGroup], [member], 'ACI318-19', project)
        .map(f => [f.fileName, f.text]));
    expect(param(by['G1_mark.SCO'], 'Bm Sstir')).toBe('4');
    expect(param(by['G1_mid.SCO'], 'Bm Sstir')).toBe('8');
    expect(param(by['G1_opp.SCO'], 'Bm Sstir')).toBe('4');
    // x=2 → mark, x=15 → mid, x=28 → opp. Each row appears in exactly one file
    // (twice, as the sagging + hogging pair).
    expect(shears(by['G1_mark.SCO'])).toEqual([90, 90]);
    expect(shears(by['G1_mid.SCO'])).toEqual([20, 20]);
    expect(shears(by['G1_opp.SCO'])).toEqual([85, 85]);
  });

  it('the region cages genuinely CHANGE the output (they used to be inert)', () => {
    const without = buildGroupEnvelopeScoFiles([plainGroup], [member], 'ACI318-19', project);
    const withCages = buildGroupEnvelopeScoFiles([curtailedGroup], [member], 'ACI318-19', project);
    expect(without.length).toBe(2);      // uniform cage → the two ends merge
    expect(withCages.length).toBe(3);
    expect(withCages.map(f => f.text)).not.toEqual(without.map(f => f.text));
  });
});

describe('regions that come out the same are MERGED, not duplicated', () => {
  it('uniform cage + 4/8/4 links → two files: both ends, and mid', () => {
    const files = buildGroupEnvelopeScoFiles([plainGroup], [member], 'ACI318-19', project);
    expect(files.map(f => f.fileName)).toEqual(['G1_ends.SCO', 'G1_mid.SCO']);
    expect(files[0].regions).toEqual(['mark', 'opp']);
    expect(shears(files[0].text)).toEqual([90, 90, 85, 85]);   // both end thirds pooled
    expect(shears(files[1].text)).toEqual([20, 20]);
  });

  it('ONE cage and ONE spacing for the whole beam → ONE file, no suffix', () => {
    // The plain case an engineer starts from: nothing varies along the span, so
    // splitting it would just be three copies of the same check.
    const flat: RebarLayout = {
      topBars: [{ numBars: 6, barSize: 9 }], botBars: [{ numBars: 8, barSize: 9 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    };
    const g: DesignGroup = { id: 'g1', label: 'G1', memberIds: ['B1'], rebar: flat };
    const files = buildGroupEnvelopeScoFiles([g], [{ ...member, rebar: flat }], 'ACI318-19', project);
    expect(files.map(f => f.fileName)).toEqual(['G1.SCO']);
    expect(files[0].regions).toBeUndefined();
    expect(param(files[0].text, 'Bm Sstir')).toBe('6');
    expect(shears(files[0].text)).toEqual([90, 90, 20, 20, 85, 85]);   // every row, one file
  });

  it('a curtailed top with NO opposite-end cage merges the ends again', () => {
    // Only the middle differs, so there are two sections, not three.
    const g: DesignGroup = { ...plainGroup, midThirdTopBars: [{ numBars: 2, barSize: 9 }] };
    const files = buildGroupEnvelopeScoFiles([g], [member], 'ACI318-19', project);
    expect(files.map(f => f.fileName)).toEqual(['G1_ends.SCO', 'G1_mid.SCO']);
  });
});

describe('the per-member path has no group, so no region cages', () => {
  it('still splits by link spacing, merging the two ends', () => {
    const files = buildGroupScoFiles([member], 'ACI318-19', project);
    expect(files.map(f => f.fileName)).toEqual(['B1_ends.SCO', 'B1_mid.SCO']);
    expect(files.every(f => f.memberId === 'B1')).toBe(true);
  });
});
