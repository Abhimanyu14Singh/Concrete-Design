/**
 * The M / V overlay's data — envelope vs one combination.
 *
 * The bug this exists to prevent is invisible on screen. An envelope that keeps the
 * larger magnitude at each station draws a smooth, plausible curve whose points each
 * come from a different load case; it looks exactly like a bending moment diagram and
 * is not one. Nothing about the rendering can tell you that, so it has to be pinned
 * here: pick a combo and you get THAT combo's stations, sign and all.
 */
import { describe, it, expect } from 'vitest';
import { stationEnvelope, comboNames } from '../design.js';

/**
 * Two combos on a 3-station span where they DISAGREE IN SIGN at midspan — gravity sags,
 * uplift hogs. This is the case the envelope cannot represent.
 */
const FORCES = [
  { combo: '1.2D+1.6L', stations: [
    { x: 0,  M: -100, V: 50 },
    { x: 10, M: 80,   V: 0 },
    { x: 20, M: -120, V: -50 },
  ] },
  { combo: '0.9D+1.0W', stations: [
    { x: 0,  M: 40,  V: -20 },
    { x: 10, M: -60, V: 5 },
    { x: 20, M: 200, V: 18 },
  ] },
];

describe('stationEnvelope — one combination', () => {
  it('returns that combo’s own stations, unaltered', () => {
    expect(stationEnvelope(FORCES, 'M', '1.2D+1.6L'))
      .toEqual([{ x: 0, v: -100 }, { x: 10, v: 80 }, { x: 20, v: -120 }]);
  });

  it('keeps the OTHER combo separate rather than merging them', () => {
    expect(stationEnvelope(FORCES, 'M', '0.9D+1.0W'))
      .toEqual([{ x: 0, v: 40 }, { x: 10, v: -60 }, { x: 20, v: 200 }]);
  });

  it('draws the real sign at every station, including where the combos disagree', () => {
    // At midspan 1.2D+1.6L sags (+80) and 0.9D+1.0W hogs (−60). Each combo must keep
    // its own sign — this is the inflection information the envelope destroys.
    const grav = stationEnvelope(FORCES, 'M', '1.2D+1.6L');
    const wind = stationEnvelope(FORCES, 'M', '0.9D+1.0W');
    expect(grav[1].v).toBeGreaterThan(0);
    expect(wind[1].v).toBeLessThan(0);
  });

  it('reads shear off the same combo', () => {
    expect(stationEnvelope(FORCES, 'V', '0.9D+1.0W'))
      .toEqual([{ x: 0, v: -20 }, { x: 10, v: 5 }, { x: 20, v: 18 }]);
  });

  it('sorts by station even when the import did not', () => {
    const jumbled = [{ combo: 'C1', stations: [
      { x: 20, M: 3, V: 0 }, { x: 0, M: 1, V: 0 }, { x: 10, M: 2, V: 0 },
    ] }];
    expect(stationEnvelope(jumbled, 'M', 'C1').map(p => p.x)).toEqual([0, 10, 20]);
  });

  it('returns nothing for a combo this member does not have', () => {
    // Members imported from different patterns do not all carry every combo. Empty is
    // right; the caller falls back to the envelope rather than drawing a phantom.
    expect(stationEnvelope(FORCES, 'M', 'NOT_A_COMBO')).toEqual([]);
  });
});

describe('stationEnvelope — the envelope (no combo)', () => {
  it('is unchanged: worst magnitude at each station, carrying its sign', () => {
    expect(stationEnvelope(FORCES, 'M')).toEqual([
      { x: 0, v: -100 },   // gravity wins:  |−100| > |40|
      { x: 10, v: 80 },    // gravity wins:  |80|   > |−60|
      { x: 20, v: 200 },   // WIND wins:     |200|  > |−120|
    ]);
    // Three points, two different load cases. Joined up it is a curve no combination
    // produces — and it changes sign between stations 1 and 2 for no physical reason.
    
  });

  it('is NOT any single combo — which is the whole reason the picker exists', () => {
    const env = stationEnvelope(FORCES, 'M');
    for (const c of ['1.2D+1.6L', '0.9D+1.0W']) {
      expect(env).not.toEqual(stationEnvelope(FORCES, 'M', c));
    }
  });

  it('treats an empty combo string as "no combo" so the default is the envelope', () => {
    expect(stationEnvelope(FORCES, 'M', '')).toEqual(stationEnvelope(FORCES, 'M'));
  });
});

describe('comboNames', () => {
  it('unions across members and keeps the import order', () => {
    const members = [
      { stationForces: [{ combo: 'A', stations: [] }, { combo: 'B', stations: [] }] },
      { stationForces: [{ combo: 'B', stations: [] }, { combo: 'C', stations: [] }] },
    ];
    expect(comboNames(members)).toEqual(['A', 'B', 'C']);
  });

  it('does not miss a combo that only one member carries', () => {
    // Reading combos off members[0] would drop 'STORM' entirely, and the picker would
    // never offer the combination the engineer came looking for.
    const members = [
      { stationForces: [{ combo: 'GRAV', stations: [] }] },
      { stationForces: [{ combo: 'GRAV', stations: [] }, { combo: 'STORM', stations: [] }] },
    ];
    expect(comboNames(members)).toContain('STORM');
  });

  it('survives members with no imported forces', () => {
    expect(comboNames([{}, { stationForces: [] }, { stationForces: [{ combo: 'X', stations: [] }] }]))
      .toEqual(['X']);
    expect(comboNames([])).toEqual([]);
    expect(comboNames(undefined as never)).toEqual([]);
  });
});
