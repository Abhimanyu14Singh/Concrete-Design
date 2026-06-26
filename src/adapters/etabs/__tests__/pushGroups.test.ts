import { describe, it, expect } from 'vitest';
import { buildGroupPushPayload, summarizePushResults } from '../pushGroups';

describe('buildGroupPushPayload', () => {
  const frames = new Map([['m1', 'F1'], ['m2', 'F2'], ['m3', 'F3']]);

  it('maps member ids to ETABS frame names', () => {
    const out = buildGroupPushPayload([{ label: 'G1', memberIds: ['m1', 'm2'] }], frames);
    expect(out).toEqual([{ name: 'G1', frameNames: ['F1', 'F2'] }]);
  });

  it('de-duplicates frame names and drops unmapped members', () => {
    const out = buildGroupPushPayload([{ label: 'G1', memberIds: ['m1', 'm1', 'mX'] }], frames);
    expect(out).toEqual([{ name: 'G1', frameNames: ['F1'] }]);
  });

  it('skips groups with no mappable frames', () => {
    expect(buildGroupPushPayload([{ label: 'Empty', memberIds: ['mX'] }], frames)).toEqual([]);
  });

  it('also accepts a plain record map', () => {
    const out = buildGroupPushPayload([{ label: 'G', memberIds: ['m1'] }], { m1: 'F1' });
    expect(out).toEqual([{ name: 'G', frameNames: ['F1'] }]);
  });
});

describe('summarizePushResults', () => {
  it('totals assigned/requested frames and notes failures', () => {
    const s = summarizePushResults([
      { groupName: 'G1', assigned: 3, total: 3 },
      { groupName: 'G2', assigned: 1, total: 2, failures: ['F9: model locked'] },
    ]);
    expect(s).toContain('2 group(s)');
    expect(s).toContain('4/5 frames assigned');
    expect(s).toContain('1 failed');
  });
});
