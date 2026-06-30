/**
 * Locks the shared frame-coloring logic used by BOTH the 2D plan canvas and the
 * 3D orbit canvas. Each mode is asserted against the underlying color primitive
 * so the two views can never drift apart.
 */
import { describe, it, expect } from 'vitest';
import { frameColorFor, buildGroupColorMap, buildAutoGroupColorMap, type FrameColorContext } from '../frameColor';
import { dcrToColor } from '../../EtabsImport/dcrColors';
import { valueToRampColor } from '../colorRamp';
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
    expect(frameColorFor(frame(undefined), baseCtx())).toBe('#d1d5db');
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
    expect(frameColorFor(frame('orphan'), ctx)).toBe('#9ca3af');
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
  it('falls back to grey without a value or range', () => {
    const ctx = baseCtx({ colorMode: 'stirrups', metricById: {}, metricRange: { min: 1, max: 4 } });
    expect(frameColorFor(frame('m1'), ctx)).toBe('#d1d5db');
  });
});

describe('frameColorFor — auto-group overlay', () => {
  const bins: AutoGroupBin[] = [
    { binKey: 'b1', label: 'Fam 1', color: '#abcdef', memberIds: ['m1'] } as AutoGroupBin,
  ];
  const ctx = baseCtx({ colorMode: 'autoGroup', autoGroupColorMap: buildAutoGroupColorMap(bins) });
  it('colors a binned member and greys the rest', () => {
    expect(frameColorFor(frame('m1'), ctx)).toBe('#abcdef');
    expect(frameColorFor(frame('m9'), ctx)).toBe('#9ca3af');
  });
});
