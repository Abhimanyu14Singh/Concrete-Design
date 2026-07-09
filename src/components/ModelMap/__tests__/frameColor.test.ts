/**
 * Locks the shared frame-coloring logic for the 2D plan canvas. Each mode is
 * asserted against the underlying color primitive so colors stay stable.
 */
import { describe, it, expect } from 'vitest';
import {
  frameColorFor, buildGroupColorMap, buildAutoGroupColorMap, buildGroupIndexMap,
  concGradeLabel, steelGradeLabel, type FrameColorContext,
} from '../frameColor';
import { dcrToColor } from '../../EtabsImport/dcrColors';
import { valueToRampColor } from '../colorRamp';
import { MAP_GRAY, STATUS } from '../../../theme';
import type { DesignGroup, AutoGroupBin } from '../../../types';

const baseCtx = (over: Partial<FrameColorContext> = {}): FrameColorContext => ({
  colorMode: 'dcr',
  dcrById: {},
  groupColorMap: new Map(),
  autoGroupColorMap: new Map(),
  metricById: {},
  metricRange: undefined,
  ...over,
});
const frame = (memberId?: string, sectionName = 'C24X24') => ({ memberId, sectionName });

describe('frameColorFor — DCR mode', () => {
  it('matches dcrToColor for a linked member', () => {
    const ctx = baseCtx({ colorMode: 'dcr', dcrById: { m1: 0.55, m2: 1.2 } });
    expect(frameColorFor(frame('m1'), ctx)).toBe(dcrToColor(0.55));
    expect(frameColorFor(frame('m2'), ctx)).toBe(dcrToColor(1.2));
    expect(frameColorFor(frame('m1'), ctx)).not.toBe(frameColorFor(frame('m2'), ctx));
  });
  it('treats a member with no DCR as 0', () => {
    expect(frameColorFor(frame('mX'), baseCtx())).toBe(dcrToColor(0));
  });
  it('greys an unlinked frame', () => {
    expect(frameColorFor(frame(undefined), baseCtx())).toBe(MAP_GRAY.unlinked);
  });
});

describe('frameColorFor — group mode', () => {
  const groups: DesignGroup[] = [
    { id: 'g1', label: 'A', memberIds: ['m1', 'm2'], color: '#123456' },
    { id: 'g2', label: 'B', memberIds: ['m3'] },
  ];
  const ctx = baseCtx({ colorMode: 'group', groupColorMap: buildGroupColorMap(groups) });
  it('colors a grouped member by its group color', () => {
    expect(frameColorFor(frame('m1'), ctx)).toBe('#123456');
    expect(frameColorFor(frame('m2'), ctx)).toBe('#123456');     // same group → same color
    expect(frameColorFor(frame('m3'), ctx)).not.toBe('#123456'); // different group
  });
  it('greys an ungrouped member', () => {
    expect(frameColorFor(frame('orphan'), ctx)).toBe(MAP_GRAY.unassigned);
  });
});

describe('frameColorFor — section mode', () => {
  const ctx = baseCtx({ colorMode: 'section' });
  it('is deterministic per section name and starts with hsl', () => {
    const a = frameColorFor(frame('m', 'W24X24'), ctx);
    expect(a).toMatch(/^hsl\(/);
    expect(frameColorFor(frame('m2', 'W24X24'), ctx)).toBe(a); // same section → same color
  });
  it('distinguishes different sections', () => {
    expect(frameColorFor(frame('m', 'C20X20'), ctx)).not.toBe(frameColorFor(frame('m', 'C40X40'), ctx));
  });
});

describe('frameColorFor — metric mode', () => {
  it('maps the value through the ramp when a range is present', () => {
    const ctx = baseCtx({ colorMode: 'flexSteel', metricById: { m1: 2.5 }, metricRange: { min: 1, max: 4 } });
    expect(frameColorFor(frame('m1'), ctx)).toBe(valueToRampColor(2.5, 1, 4));
  });
  it('ramps height and width the same way', () => {
    for (const mode of ['height', 'width'] as const) {
      const ctx = baseCtx({ colorMode: mode, metricById: { m1: 12 }, metricRange: { min: 10, max: 30 } });
      expect(frameColorFor(frame('m1'), ctx)).toBe(valueToRampColor(12, 10, 30));
    }
  });
  it('falls back to grey without a value or range', () => {
    const ctx = baseCtx({ colorMode: 'stirrups', metricById: {}, metricRange: { min: 1, max: 4 } });
    expect(frameColorFor(frame('m1'), ctx)).toBe(MAP_GRAY.unlinked);
  });
});

describe('frameColorFor — S-Concrete pass/fail', () => {
  const ctx = baseCtx({ colorMode: 'sconcrete', scoStatusById: { m1: 'OK', m2: 'NG' } });
  it('greens a passing member, reds a failing one, greys an un-run member', () => {
    expect(frameColorFor(frame('m1'), ctx)).toBe(STATUS.ok);
    expect(frameColorFor(frame('m2'), ctx)).toBe(STATUS.fail);
    expect(frameColorFor(frame('m3'), ctx)).toBe(MAP_GRAY.notRun);   // no result
    expect(frameColorFor(frame(undefined), ctx)).toBe(MAP_GRAY.notRun);
  });
});

describe('frameColorFor — auto-group overlay', () => {
  const bins: AutoGroupBin[] = [
    { binKey: 'b1', label: 'Fam 1', color: '#abcdef', memberIds: ['m1'] } as AutoGroupBin,
  ];
  const ctx = baseCtx({ colorMode: 'autoGroup', autoGroupColorMap: buildAutoGroupColorMap(bins) });
  it('colors a binned member and greys the rest', () => {
    expect(frameColorFor(frame('m1'), ctx)).toBe('#abcdef');
    expect(frameColorFor(frame('m9'), ctx)).toBe(MAP_GRAY.unassigned);
  });
});

describe('frameColorFor — concrete/steel grade', () => {
  const gradeColorMap = new Map([['m1', '#aa0000'], ['m2', '#aa0000'], ['m3', '#00aa00']]);
  it('colors by the grade map for both grade modes and greys the rest', () => {
    for (const mode of ['concGrade', 'steelGrade'] as const) {
      const ctx = baseCtx({ colorMode: mode, gradeColorMap });
      expect(frameColorFor(frame('m1'), ctx)).toBe('#aa0000');
      expect(frameColorFor(frame('m2'), ctx)).toBe('#aa0000');     // same grade → same color
      expect(frameColorFor(frame('m3'), ctx)).toBe('#00aa00');
      expect(frameColorFor(frame('mX'), ctx)).toBe(MAP_GRAY.unassigned);
    }
  });
});

describe('frameColorFor — groupTags mode', () => {
  const groups: DesignGroup[] = [
    { id: 'g1', label: 'A', memberIds: ['m1'], color: '#123456' },
    { id: 'g2', label: 'B', memberIds: ['m3'] },
  ];
  it('colors identically to group mode', () => {
    const ctx = baseCtx({ colorMode: 'groupTags', groupColorMap: buildGroupColorMap(groups) });
    expect(frameColorFor(frame('m1'), ctx)).toBe('#123456');
    expect(frameColorFor(frame('orphan'), ctx)).toBe(MAP_GRAY.unassigned);
  });
});

describe('buildGroupIndexMap', () => {
  it('maps each member to its group index in array order', () => {
    const groups: DesignGroup[] = [
      { id: 'g1', label: 'A', memberIds: ['m1', 'm2'] },
      { id: 'g2', label: 'B', memberIds: ['m3'] },
    ];
    const idx = buildGroupIndexMap(groups);
    expect(idx.get('m1')).toBe(0);
    expect(idx.get('m2')).toBe(0);
    expect(idx.get('m3')).toBe(1);
    expect(idx.has('mX')).toBe(false);
  });
});

describe('grade labels', () => {
  it('formats concrete/steel grades in SI and imperial', () => {
    expect(concGradeLabel(30 * 145.0377, true)).toBe('C30');
    expect(steelGradeLabel(500 * 145.0377, true)).toBe('B500');
    expect(concGradeLabel(4000, false)).toBe('4 ksi');
    expect(steelGradeLabel(60000, false)).toBe('Gr 60');
  });
});
