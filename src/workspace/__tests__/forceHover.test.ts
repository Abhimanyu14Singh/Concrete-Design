/**
 * What the Force Diagram's crosshair reads.
 *
 * The failure this guards against is a quiet one: a readout that disagrees with the
 * polygon drawn directly above it. The envelope is drawn as straight segments between
 * stations, so anything other than linear interpolation — snapping to the nearest
 * station, or reading station[0] — puts a number on screen that the picture contradicts.
 */
import { describe, it, expect } from 'vitest';
import { envelopeAt } from '../panels/ForcePanel.jsx';

/** Two combos enveloped over a 30 ft span, the shape a real beam has: hogging at the
 *  supports, sagging mid-span, shear crossing zero, torsion reversing end to end. */
const STATIONS = [
  { x: 0,  Mlo: -200, Mhi: 0,   Vlo: 40, Vhi: 60, Tlo: -10, Thi: 4 },
  { x: 15, Mlo: 0,    Mhi: 180, Vlo: -5, Vhi: 5,  Tlo: 0,   Thi: 0 },
  { x: 30, Mlo: -240, Mhi: 0,   Vlo: -60, Vhi: -40, Tlo: -4, Thi: 10 },
];

describe('envelopeAt — the value under the crosshair', () => {
  it('returns the station exactly when the pointer is on one', () => {
    expect(envelopeAt(STATIONS, 15)).toMatchObject({ Mlo: 0, Mhi: 180, Vlo: -5, Vhi: 5 });
  });

  it('INTERPOLATES between stations rather than snapping to the nearest', () => {
    // Halfway from x=0 to x=15. Snapping would give one of the endpoints; the drawn
    // polygon is a straight line, so the midpoint is what the picture shows.
    const at = envelopeAt(STATIONS, 7.5);
    expect(at!.Mlo).toBeCloseTo(-100, 6);
    expect(at!.Mhi).toBeCloseTo(90, 6);
    expect(at!.Vhi).toBeCloseTo(32.5, 6);
    expect(at!.Tlo).toBeCloseTo(-5, 6);
  });

  it('interpolates in the right segment near the far end', () => {
    const at = envelopeAt(STATIONS, 22.5);
    expect(at!.Mlo).toBeCloseTo(-120, 6);   // between 0 and −240
    expect(at!.Vlo).toBeCloseTo(-32.5, 6);
    expect(at!.Thi).toBeCloseTo(5, 6);
  });

  it('catches the sign change a signed diagram exists to show', () => {
    // Shear crosses zero between the first two stations; the readout must cross with it.
    const left = envelopeAt(STATIONS, 1)!;
    const right = envelopeAt(STATIONS, 29)!;
    expect(left.Vhi).toBeGreaterThan(0);
    expect(right.Vhi).toBeLessThan(0);
  });

  it('clamps to the end stations instead of extrapolating off the beam', () => {
    // The pointer can sit in the axis padding, left of x=0 or right of the span.
    expect(envelopeAt(STATIONS, -3)).toMatchObject({ Mlo: -200, Vhi: 60 });
    expect(envelopeAt(STATIONS, 99)).toMatchObject({ Mlo: -240, Vhi: -40 });
  });

  it('treats a missing torsion column as zero, not undefined', () => {
    // Older imports have no T on the station record; the readout must print 0, and
    // `undefined` would render as "NaN".
    const noT = [{ x: 0, Mlo: 0, Mhi: 10, Vlo: 0, Vhi: 5 }, { x: 10, Mlo: 0, Mhi: 20, Vlo: 0, Vhi: 5 }];
    const at = envelopeAt(noT as never, 5)!;
    expect(at.Tlo).toBe(0);
    expect(at.Thi).toBe(0);
    expect(Number.isFinite(at.Mhi)).toBe(true);
  });

  it('survives duplicate stations at the same x without dividing by zero', () => {
    const dup = [
      { x: 0, Mlo: 0, Mhi: 0, Vlo: 0, Vhi: 0, Tlo: 0, Thi: 0 },
      { x: 5, Mlo: -1, Mhi: 1, Vlo: 0, Vhi: 0, Tlo: 0, Thi: 0 },
      { x: 5, Mlo: -2, Mhi: 2, Vlo: 0, Vhi: 0, Tlo: 0, Thi: 0 },
      { x: 10, Mlo: 0, Mhi: 0, Vlo: 0, Vhi: 0, Tlo: 0, Thi: 0 },
    ];
    for (const x of [2.5, 5, 7.5]) {
      const at = envelopeAt(dup, x)!;
      expect(Number.isFinite(at.Mlo)).toBe(true);
      expect(Number.isFinite(at.Mhi)).toBe(true);
    }
  });

  it('returns null with nothing to read', () => {
    expect(envelopeAt([], 3)).toBeNull();
    expect(envelopeAt(undefined as never, 3)).toBeNull();
  });

  it('handles a single-station member', () => {
    const one = [{ x: 0, Mlo: -5, Mhi: 5, Vlo: -1, Vhi: 1, Tlo: 0, Thi: 2 }];
    expect(envelopeAt(one, 4)).toMatchObject({ Mlo: -5, Mhi: 5, Thi: 2 });
  });
});
