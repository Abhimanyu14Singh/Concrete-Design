/**
 * Element appearance preferences — the model behind Preferences → Model appearance.
 *
 * The drawing itself is a handful of SVG attributes; what is worth pinning is the
 * PERSISTENCE, because every way it can go wrong is quiet: a saved preference that fails
 * validation and silently reverts, or one added later that invalidates every value saved
 * before it.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ELEMENT_STYLES, isElementStyles, mergeElementStyles, withAlpha,
} from '../elementStyle';
import { frameColorFor } from '../frameColor';

describe('the defaults are the map as it has always looked', () => {
  it('covers the four element kinds', () => {
    expect(Object.keys(DEFAULT_ELEMENT_STYLES).sort()).toEqual(['beam', 'column', 'floor', 'wall']);
  });

  it('only the AREA kinds carry a fill — a stroke has nothing to fill', () => {
    expect(DEFAULT_ELEMENT_STYLES.beam.fill).toBeUndefined();
    expect(DEFAULT_ELEMENT_STYLES.column.fill).toBeUndefined();
    expect(DEFAULT_ELEMENT_STYLES.floor.fill).toBe('solid');
    expect(DEFAULT_ELEMENT_STYLES.wall.fill).toBe('hatch');   // hatch = cut material
  });

  it('validates its own defaults', () => {
    expect(isElementStyles(DEFAULT_ELEMENT_STYLES)).toBe(true);
  });
});

describe('a saved preference is merged FIELD BY FIELD', () => {
  it('keeps a good value', () => {
    const m = mergeElementStyles({ wall: { color: '#c026d3', opacity: 0.5, fill: 'outline' } });
    expect(m.wall).toEqual({ color: '#c026d3', opacity: 0.5, fill: 'outline' });
  });

  it('one bad field does not discard the good ones beside it', () => {
    // The failure this prevents: a whole-object fallback throwing away a colour the user
    // set because the opacity next to it was malformed.
    const m = mergeElementStyles({ wall: { color: '#c026d3', opacity: 99, fill: 'nope' } });
    expect(m.wall.color).toBe('#c026d3');                          // kept
    expect(m.wall.opacity).toBe(DEFAULT_ELEMENT_STYLES.wall.opacity); // reverted
    expect(m.wall.fill).toBe(DEFAULT_ELEMENT_STYLES.wall.fill);      // reverted
  });

  it('one bad KIND does not discard the other three', () => {
    const m = mergeElementStyles({ beam: 'rubbish', wall: { color: '#111111', opacity: 1 } });
    expect(m.beam).toEqual(DEFAULT_ELEMENT_STYLES.beam);
    expect(m.wall.color).toBe('#111111');
  });

  it('a value saved before a kind existed still loads', () => {
    // i.e. adding a fifth element kind later must not invalidate everyone's settings.
    const m = mergeElementStyles({ beam: { color: '#000000', opacity: 1 } });
    expect(m.beam.color).toBe('#000000');
    expect(m.column).toEqual(DEFAULT_ELEMENT_STYLES.column);
  });

  it('junk falls back whole', () => {
    expect(mergeElementStyles(null)).toEqual(DEFAULT_ELEMENT_STYLES);
    expect(mergeElementStyles('nope')).toEqual(DEFAULT_ELEMENT_STYLES);
    expect(isElementStyles({ beam: { color: 'red', opacity: 1 } })).toBe(false);  // not #rrggbb
  });
});

describe('withAlpha', () => {
  it('converts hex + alpha to rgba', () => {
    expect(withAlpha('#94a3b8', 0.16)).toBe('rgba(148, 163, 184, 0.16)');
  });
  it('clamps and falls back rather than emitting broken CSS', () => {
    expect(withAlpha('#94a3b8', 5)).toBe('rgba(148, 163, 184, 1)');
    expect(withAlpha('nonsense', 1)).toBe('rgba(148, 163, 184, 1)');
  });
});

describe("the 'none' colour mode", () => {
  const ctx = {
    colorMode: 'none' as const,
    dcrById: {}, groupColorMap: new Map(), autoGroupColorMap: new Map(), metricById: {},
  };
  const frame = { memberId: 'B1', sectionName: 'B14X28' };

  it('paints every beam the standard colour from Preferences', () => {
    expect(frameColorFor(frame, { ...ctx, beamColor: '#c026d3' })).toBe('#c026d3');
    expect(frameColorFor({ memberId: undefined, sectionName: 'X' }, { ...ctx, beamColor: '#c026d3' })).toBe('#c026d3');
  });

  it('falls back to the default beam colour when none is supplied', () => {
    expect(frameColorFor(frame, ctx)).toBe(DEFAULT_ELEMENT_STYLES.beam.color);
  });

  it('needs none of the result maps, so it is correct on an undesigned model', () => {
    // This is why it is safe as the DEFAULT: a DCR map on a model with no results
    // colours the whole floor from missing data, which reads as a verdict.
    expect(() => frameColorFor(frame, { colorMode: 'none', dcrById: {}, groupColorMap: new Map(), autoGroupColorMap: new Map(), metricById: {} })).not.toThrow();
  });
});
