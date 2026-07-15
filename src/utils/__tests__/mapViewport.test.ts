import { describe, it, expect } from 'vitest';
import { zoomViewBox, type ViewBox } from '../mapViewport';

const base: ViewBox = { x: 0, y: 0, w: 1000, h: 800 };
const MIN = 20, MAX = 8000;

describe('zoomViewBox', () => {
  it('zooms in/out by the factor when within bounds', () => {
    expect(zoomViewBox(base, 0.5, 500, 400, MIN, MAX).w).toBeCloseTo(500, 6);
    expect(zoomViewBox(base, 1.5, 500, 400, MIN, MAX).w).toBeCloseTo(1500, 6);
  });

  it('keeps the anchor point fixed under the cursor', () => {
    const out = zoomViewBox(base, 0.5, 500, 400, MIN, MAX);
    // The world point at (500,400) must map to the same fraction of the new box.
    expect((500 - out.x) / out.w).toBeCloseTo((500 - base.x) / base.w, 9);
    expect((400 - out.y) / out.h).toBeCloseTo((400 - base.y) / base.h, 9);
  });

  it('clamps zoom-IN at minW (the crash guard) — never approaches zero width', () => {
    // Aggressive zoom-in that would otherwise drop far below the floor.
    const out = zoomViewBox({ ...base, w: 30, h: 24 }, 0.1, 15, 12, MIN, MAX);
    expect(out.w).toBeCloseTo(MIN, 6);           // clamped to the floor
    expect(out.w).toBeGreaterThan(0);
  });

  it('clamps zoom-OUT at maxW', () => {
    const out = zoomViewBox({ ...base, w: 5000, h: 4000 }, 4, 2500, 2000, MIN, MAX);
    expect(out.w).toBeCloseTo(MAX, 6);
  });

  it('returns the same reference (no-op) once already at a limit', () => {
    const atFloor: ViewBox = { x: 0, y: 0, w: MIN, h: 16 };
    expect(zoomViewBox(atFloor, 0.5, 10, 8, MIN, MAX)).toBe(atFloor);
    const atCeil: ViewBox = { x: 0, y: 0, w: MAX, h: 6400 };
    expect(zoomViewBox(atCeil, 2, 4000, 3200, MIN, MAX)).toBe(atCeil);
  });

  it('is a no-op for a non-finite or non-positive factor', () => {
    expect(zoomViewBox(base, NaN, 500, 400, MIN, MAX)).toBe(base);
    expect(zoomViewBox(base, 0, 500, 400, MIN, MAX)).toBe(base);
  });

  it('never yields a width below the floor across a long zoom-in sweep', () => {
    let vb: ViewBox = { ...base };
    for (let i = 0; i < 200; i++) vb = zoomViewBox(vb, 0.87, vb.x + vb.w / 2, vb.y + vb.h / 2, MIN, MAX);
    expect(vb.w).toBeGreaterThanOrEqual(MIN - 1e-9);
    expect(vb.w).toBeCloseTo(MIN, 6);
  });
});
