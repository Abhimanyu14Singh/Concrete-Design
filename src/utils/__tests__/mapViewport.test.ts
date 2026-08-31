import { describe, it, expect } from 'vitest';
import {
  fitTransform, zoomViewBox, project3, fitProjected, clampPitch,
  boundingSphere, stableProjection, screenBounds, viewBoxForBounds,
  normalizeWheelDelta, wheelZoomFactor, dampCamera, shortestAngle, VIEW_PRESETS,
  DEFAULT_CAMERA, type ViewBox, type Camera, type Point3,
} from '../mapViewport';

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

describe('fitTransform', () => {
  // The demo model's plan extent (mock.ts GRID_X / GRID_Y), in ft.
  const demo = { minX: 0, maxX: 72, minY: 0, maxY: 56 };

  /** Screen margins left of / right of / above / below the fitted plan. */
  const margins = (b: typeof demo, w: number, h: number) => {
    const { tx, ty } = fitTransform(b, w, h);
    return {
      left: tx(b.minX),
      right: w - tx(b.maxX),
      top: ty(b.maxY),          // ty flips Y — maxY is the TOP edge on screen
      bottom: h - ty(b.minY),
    };
  };

  it('centers horizontally when the canvas is wider than the model (slack on X)', () => {
    // 1150×700 canvas vs a 72×56 plan: Y governs the scale, X has ~313px of slack.
    // That slack used to land entirely on the right, pinning the plan to the left.
    const m = margins(demo, 1150, 700);
    expect(m.left).toBeCloseTo(m.right, 6);
    expect(m.left).toBeGreaterThan(40); // genuinely slack, not just the pad
  });

  it('centers vertically when the canvas is taller than the model (slack on Y)', () => {
    // 700×900: X governs, so the vertical slack used to pile up above the plan.
    const m = margins(demo, 700, 900);
    expect(m.top).toBeCloseTo(m.bottom, 6);
    expect(m.top).toBeGreaterThan(40);
  });

  it('keeps every margin at exactly `pad` when the aspect ratios match', () => {
    // 72:56 plan in a 720+80 × 560+80 canvas — both axes fit at the same scale.
    const m = margins(demo, 800, 640);
    for (const v of [m.left, m.right, m.top, m.bottom]) expect(v).toBeCloseTo(40, 6);
  });

  it('never overflows the canvas — the fitted plan stays inside the padded box', () => {
    for (const [w, h] of [[1150, 700], [700, 900], [800, 640], [300, 1200], [2000, 220]]) {
      const { tx, ty } = fitTransform(demo, w, h);
      expect(tx(demo.minX)).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(tx(demo.maxX)).toBeLessThanOrEqual(w - 40 + 1e-9);
      expect(ty(demo.maxY)).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(ty(demo.minY)).toBeLessThanOrEqual(h - 40 + 1e-9);
    }
  });

  it('flips Y so plan north draws upward', () => {
    const { ty } = fitTransform(demo, 1150, 700);
    expect(ty(demo.maxY)).toBeLessThan(ty(demo.minY));
  });

  it('offsets the plan origin, not just the span (non-zero minX/minY)', () => {
    // An ETABS model parked far from the origin must center the same way.
    const shifted = { minX: 1000, maxX: 1072, minY: -500, maxY: -444 };
    const m = margins(shifted, 1150, 700);
    expect(m.left).toBeCloseTo(m.right, 6);
    expect(m.top).toBeCloseTo(m.bottom, 6);
  });

  it('stays finite on a degenerate canvas smaller than the padding', () => {
    const { scale, tx, ty } = fitTransform(demo, 60, 40);
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBeGreaterThan(0);
    expect(Number.isFinite(tx(demo.maxX))).toBe(true);
    expect(Number.isFinite(ty(demo.maxY))).toBe(true);
  });
});


describe('project3 — axonometric projection', () => {
  const cam: Camera = DEFAULT_CAMERA;

  it('sends +z upward on screen (smaller v)', () => {
    const ground = project3({ x: 0, y: 0, z: 0 }, cam);
    const up     = project3({ x: 0, y: 0, z: 12 }, cam);
    expect(up.v).toBeLessThan(ground.v);
  });

  it('is parallel, not perspective — equal spans project to equal lengths', () => {
    // Two identical 20-ft beams at different depths must draw the same length,
    // otherwise you cannot read member sizes off the view.
    const near = [project3({ x: 0, y: 0, z: 0 }, cam), project3({ x: 20, y: 0, z: 0 }, cam)];
    const far  = [project3({ x: 0, y: 90, z: 0 }, cam), project3({ x: 20, y: 90, z: 0 }, cam)];
    const len = (p: { u: number; v: number }[]) => Math.hypot(p[1].u - p[0].u, p[1].v - p[0].v);
    expect(len(near)).toBeCloseTo(len(far), 9);
  });

  it('separates points that coincide in plan but differ in height', () => {
    // The whole point of 3D: two stories of the same grid must not overlap.
    const lvl2 = project3({ x: 30, y: 30, z: 0 }, cam);
    const lvl3 = project3({ x: 30, y: 30, z: 12 }, cam);
    expect(Math.abs(lvl3.v - lvl2.v)).toBeGreaterThan(1);
  });

  it('collapses to the plan view at pitch = 90°', () => {
    const flat: Camera = { yaw: 0, pitch: Math.PI / 2 };
    const a = project3({ x: 10, y: 4, z: 0 }, flat);
    const b = project3({ x: 10, y: 4, z: 99 }, flat);
    expect(a.v).toBeCloseTo(b.v, 6); // height no longer contributes
  });

  it('clampPitch keeps the camera out of both degenerate poles', () => {
    expect(clampPitch(-5)).toBeGreaterThan(0);
    expect(clampPitch(99)).toBeLessThan(Math.PI / 2);
    expect(clampPitch(0.6)).toBeCloseTo(0.6, 9);
  });
});

describe('fitProjected', () => {
  const pts = [
    { u: 0, v: 0 }, { u: 100, v: 0 }, { u: 100, v: 50 }, { u: 0, v: 50 },
  ];

  it('centers the projected model with even margins', () => {
    const map = fitProjected(pts, 800, 600);
    const xs = pts.map(p => map(p).sx), ys = pts.map(p => map(p).sy);
    expect(Math.min(...xs)).toBeCloseTo(800 - Math.max(...xs), 6);
    expect(Math.min(...ys)).toBeCloseTo(600 - Math.max(...ys), 6);
  });

  it('does NOT flip v — project3 already put +z up', () => {
    const map = fitProjected(pts, 800, 600);
    expect(map({ u: 0, v: 0 }).sy).toBeLessThan(map({ u: 0, v: 50 }).sy);
  });

  it('stays finite with no points and on a degenerate canvas', () => {
    expect(Number.isFinite(fitProjected([], 800, 600)({ u: 0, v: 0 }).sx)).toBe(true);
    expect(Number.isFinite(fitProjected(pts, 30, 20)({ u: 100, v: 50 }).sy)).toBe(true);
  });
});

// ── Rotation-stable 3D framing ───────────────────────────────────────────────

describe('boundingSphere', () => {
  it('centres on the centroid and reaches the furthest point', () => {
    const s = boundingSphere([
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 },
    ]);
    expect(s.cx).toBeCloseTo(5, 6);
    expect(s.cy).toBeCloseTo(5, 6);
    expect(s.r).toBeCloseTo(Math.hypot(5, 5), 6);
  });

  it('accounts for height, not just plan extent', () => {
    const flat = boundingSphere([{ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }]);
    const tall = boundingSphere([{ x: -5, y: 0, z: -20 }, { x: 5, y: 0, z: 20 }]);
    expect(tall.r).toBeGreaterThan(flat.r);
  });

  it('never returns a zero radius — a single point would divide by zero downstream', () => {
    expect(boundingSphere([{ x: 3, y: 3, z: 3 }]).r).toBeGreaterThan(0);
    expect(boundingSphere([]).r).toBeGreaterThan(0);
  });
});

describe('stableProjection — the fix for the jarring orbit', () => {
  // A deliberately lopsided model: a wide, shallow floor plate with columns.
  const model: Point3[] = [
    { x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }, { x: 200, y: 90, z: 0 }, { x: 0, y: 90, z: 0 },
    { x: 0, y: 0, z: 40 }, { x: 200, y: 0, z: 40 }, { x: 200, y: 90, z: 40 }, { x: 0, y: 90, z: 40 },
  ];
  const sphere = boundingSphere(model);
  const map = stableProjection(sphere, 800, 600);
  const cams: Camera[] = [
    { yaw: 0, pitch: 0.4 }, { yaw: 0.8, pitch: 0.4 }, { yaw: 2.1, pitch: 0.9 },
    { yaw: -1.3, pitch: 0.2 }, { yaw: 4.7, pitch: 1.4 },
  ];

  it('THE regression: the scale is identical at every camera angle', () => {
    // The old fitProjected refitted the projected bounding BOX every render, so
    // each of these cameras produced a different scale — the model pumped in and
    // out while the user dragged. Two points that stay in the projection plane
    // (same z, rotated only in yaw) must keep an identical separation whenever
    // the pitch matches, whatever the yaw.
    const scaleAt = (cam: Camera) => {
      // A pure-z pair foreshortens by cos(pitch) alone, isolating the scale.
      const a = map({ x: 0, y: 0, z: 0 }, cam);
      const b = map({ x: 0, y: 0, z: 100 }, cam);
      return Math.hypot(b.sx - a.sx, b.sy - a.sy) / Math.cos(cam.pitch);
    };
    const ref = scaleAt(cams[0]);
    for (const c of cams) expect(scaleAt(c)).toBeCloseTo(ref, 9);
  });

  it('never lets the model overflow the canvas, at any angle', () => {
    const cap = Math.min(800 - 80, 600 - 80);   // the padded usable square
    for (const cam of cams) {
      const p = model.map(q => map(q, cam));
      const w = Math.max(...p.map(q => q.sx)) - Math.min(...p.map(q => q.sx));
      const h = Math.max(...p.map(q => q.sy)) - Math.min(...p.map(q => q.sy));
      expect(w).toBeLessThanOrEqual(cap + 1e-6);
      expect(h).toBeLessThanOrEqual(cap + 1e-6);
    }
  });

  it('pins the model centre to the canvas centre — it cannot drift mid-orbit', () => {
    for (const cam of cams) {
      const c = map({ x: sphere.cx, y: sphere.cy, z: sphere.cz }, cam);
      expect(c.sx).toBeCloseTo(400, 6);
      expect(c.sy).toBeCloseTo(300, 6);
    }
  });

  it('stays finite on a degenerate canvas', () => {
    const q = stableProjection(sphere, 20, 10)(model[2], DEFAULT_CAMERA);
    expect(Number.isFinite(q.sx) && Number.isFinite(q.sy)).toBe(true);
  });
});

describe('screenBounds / viewBoxForBounds', () => {
  it('bounds a point set and ignores non-finite strays', () => {
    expect(screenBounds([{ sx: 10, sy: 20 }, { sx: 50, sy: 5 }, { sx: NaN, sy: 0 }]))
      .toEqual({ minX: 10, maxX: 50, minY: 5, maxY: 20 });
    expect(screenBounds([])).toBeNull();
  });

  it('frames the bounds at the canvas aspect ratio, centred', () => {
    const vb = viewBoxForBounds({ minX: 100, maxX: 300, minY: 100, maxY: 200 }, 800, 400, 0);
    expect(vb.w / vb.h).toBeCloseTo(2, 6);            // canvas is 2:1
    expect(vb.x + vb.w / 2).toBeCloseTo(200, 6);      // centred on the bounds
    expect(vb.y + vb.h / 2).toBeCloseTo(150, 6);
  });

  it('never crops — the bounds always fit inside the viewBox', () => {
    const b = { minX: 0, maxX: 500, minY: 0, maxY: 40 };
    const vb = viewBoxForBounds(b, 600, 600);
    expect(vb.x).toBeLessThanOrEqual(b.minX);
    expect(vb.y).toBeLessThanOrEqual(b.minY);
    expect(vb.x + vb.w).toBeGreaterThanOrEqual(b.maxX);
    expect(vb.y + vb.h).toBeGreaterThanOrEqual(b.maxY);
  });
});

describe('wheel input', () => {
  it('normalises line and page deltas to pixels', () => {
    expect(normalizeWheelDelta(3, 0)).toBe(3);
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(1, 2)).toBe(320);   // clamped
  });

  it('clamps a violent flick so the view cannot teleport', () => {
    expect(normalizeWheelDelta(100000, 0)).toBe(320);
    expect(normalizeWheelDelta(-100000, 0)).toBe(-320);
    expect(normalizeWheelDelta(NaN, 0)).toBe(0);
  });

  it('zoom is proportional to how far the wheel actually moved', () => {
    // The old fixed 1.15/0.87 step ignored magnitude: a feather-light trackpad
    // glide jumped exactly as far as a full mouse notch, which is what made
    // zooming feel steppy and overshoot on a laptop.
    const small = wheelZoomFactor(normalizeWheelDelta(4, 0));
    const big = wheelZoomFactor(normalizeWheelDelta(120, 0));
    expect(big).toBeGreaterThan(small);
    expect(small).toBeLessThan(1.02);   // barely moves
  });

  it('round-trips exactly — zoom out then back in lands where it started', () => {
    const d = normalizeWheelDelta(120, 0);
    expect(wheelZoomFactor(d) * wheelZoomFactor(-d)).toBeCloseTo(1, 12);
  });

  it('is scale-invariant: twice the delta squares the ratio', () => {
    const f = wheelZoomFactor(normalizeWheelDelta(100, 0));
    expect(wheelZoomFactor(normalizeWheelDelta(200, 0))).toBeCloseTo(f * f, 12);
  });
});

describe('camera damping', () => {
  it('shortestAngle takes the short way around the circle', () => {
    expect(shortestAngle(0.1, 6.2)).toBeCloseTo(6.2 - 0.1 - 2 * Math.PI, 9);
    expect(shortestAngle(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('a yaw that wraps past 2π eases backwards, not all the way round', () => {
    const stepped = dampCamera({ yaw: 0.05, pitch: 0.5 }, { yaw: 6.25, pitch: 0.5 }, 0.5);
    expect(stepped.yaw).toBeLessThan(0.05);
  });

  it('converges and then returns the target itself, so the loop can stop', () => {
    const target: Camera = { yaw: 1.2, pitch: 0.7 };
    let c: Camera = { yaw: 0, pitch: 0.2 };
    for (let i = 0; i < 60; i++) c = dampCamera(c, target, 0.32);
    expect(c).toBe(target);   // same reference ⇒ React bails out of re-rendering
  });

  it('moves a fraction of the way per call — that is what smooths a drag', () => {
    expect(dampCamera({ yaw: 0, pitch: 0.5 }, { yaw: 1, pitch: 0.5 }, 0.25).yaw)
      .toBeCloseTo(0.25, 9);
  });
});

describe('VIEW_PRESETS', () => {
  it('every preset is a legal (non-degenerate) camera', () => {
    for (const [name, cam] of Object.entries(VIEW_PRESETS)) {
      expect(clampPitch(cam.pitch), name).toBeCloseTo(cam.pitch, 9);
    }
  });

  it('top looks down and front looks along the horizon', () => {
    const up: Point3 = { x: 0, y: 0, z: 10 };
    // Looking down, height barely registers; from the front it is the whole story.
    expect(Math.abs(project3(up, VIEW_PRESETS.top).v))
      .toBeLessThan(Math.abs(project3(up, VIEW_PRESETS.front).v));
  });

  it('right is a quarter turn from front', () => {
    expect(VIEW_PRESETS.right.yaw - VIEW_PRESETS.front.yaw).toBeCloseTo(Math.PI / 2, 9);
  });
});
