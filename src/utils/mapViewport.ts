/**
 * Plan-viewport math for the model map. Kept pure (no React) so the zoom clamp —
 * the guard that stops "playing around" with the wheel from crashing the renderer
 * — and the fit transform are unit-testable in isolation.
 */
export interface ViewBox { x: number; y: number; w: number; h: number }

/** Plan-coordinate bounding box of everything the canvas draws. */
export interface PlanBounds { minX: number; maxX: number; minY: number; maxY: number }

/** Plan → screen mapping for the fitted view. `ty` flips Y (plan north = screen up). */
export interface FitTransform {
  scale: number;
  tx: (x: number) => number;
  ty: (y: number) => number;
}

/**
 * Build the plan → screen transform that fits `bounds` inside a `width` × `height`
 * canvas with at least `pad` px of margin, CENTERED on both axes.
 *
 * The scale is the tighter of the two axis fits, so the non-governing axis always
 * has leftover space. Splitting that slack evenly is what keeps the model in the
 * middle of the view — assigning it all to one side (the old `tx = pad + …`,
 * `ty = height - pad - …`) pinned the plan against an edge, so any model whose
 * aspect ratio differed from the canvas drifted into a corner and left a wide
 * empty band opposite it.
 */
export function fitTransform(bounds: PlanBounds, width: number, height: number, pad = 40): FitTransform {
  const { minX, maxX, minY, maxY } = bounds;
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  // Guard degenerate canvas sizes (pre-measure render, collapsed panel): a
  // negative usable extent would flip the plan inside out.
  const usableW = Math.max(width - 2 * pad, 1);
  const usableH = Math.max(height - 2 * pad, 1);
  const scale = Math.min(usableW / spanX, usableH / spanY);
  // Even margins on each axis; equals `pad` on whichever axis governs the scale.
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  return {
    scale,
    tx: (x: number) => offX + (x - minX) * scale,
    ty: (y: number) => height - offY - (y - minY) * scale,
  };
}

// ── 3D (axonometric) projection ───────────────────────────────────────────────

/** A model point. The 2D plan view ignores z; the 3D view is the reason it exists. */
export interface Point3 { x: number; y: number; z: number }

/** Camera angles, radians. yaw spins about the vertical (z) axis; pitch tips the
 *  horizon — 0 = looking along the ground (pure elevation), π/2 = straight down
 *  (which degenerates to the plan view). */
export interface Camera { yaw: number; pitch: number }

/** A sensible opening view: rotated 35° off the X axis, tipped ~30° above horizon.
 *  Close to a standard architectural axonometric, so plans still read as plans. */
export const DEFAULT_CAMERA: Camera = { yaw: 0.61, pitch: 0.52 };

/** Keep pitch inside (0, π/2) — at 0 the model collapses to a line, at π/2 the
 *  z axis vanishes and the view silently becomes the plan. */
export const clampPitch = (p: number): number => Math.min(Math.PI / 2 - 0.05, Math.max(0.05, p));

/**
 * Project a model point to 2D "paper" coordinates for the given camera.
 *
 * Parallel (not perspective) projection: engineers read lengths off this view, and
 * a perspective divide would make equal members at different depths draw at
 * different lengths. Returned `v` grows DOWNWARD (screen convention), so +z (up in
 * the model) yields a smaller v — the fit transform then maps it straight to SVG.
 */
export function project3(p: Point3, cam: Camera): { u: number; v: number } {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  // Rotate about the vertical axis first.
  const rx = p.x * cy - p.y * sy;
  const ry = p.x * sy + p.y * cy;
  // Then tip: the ground plane foreshortens by sin(pitch), height by cos(pitch).
  return { u: rx, v: ry * Math.sin(cam.pitch) - p.z * Math.cos(cam.pitch) };
}

/**
 * Fit already-projected points into the canvas, centered — the 3D sibling of
 * fitTransform. Returns a mapper from projected (u, v) to SVG coordinates.
 *
 * Unlike the plan fit, v is NOT flipped: project3 has already put +z upward by
 * emitting a smaller v, so flipping again would render the model upside down.
 */
export function fitProjected(
  pts: { u: number; v: number }[], width: number, height: number, pad = 40,
): (q: { u: number; v: number }) => { sx: number; sy: number } {
  const us = pts.map(p => p.u), vs = pts.map(p => p.v);
  const minU = us.length ? Math.min(...us) : 0;
  const maxU = us.length ? Math.max(...us) : 1;
  const minV = vs.length ? Math.min(...vs) : 0;
  const maxV = vs.length ? Math.max(...vs) : 1;
  const spanU = Math.max(maxU - minU, 1);
  const spanV = Math.max(maxV - minV, 1);
  const usableW = Math.max(width - 2 * pad, 1);
  const usableH = Math.max(height - 2 * pad, 1);
  const scale = Math.min(usableW / spanU, usableH / spanV);
  const offU = (width - spanU * scale) / 2;
  const offV = (height - spanV * scale) / 2;
  return (q) => ({ sx: offU + (q.u - minU) * scale, sy: offV + (q.v - minV) * scale });
}

/**
 * Zoom `vb` by `factor` about the anchor (ax, ay) — both in viewBox coordinates —
 * clamping the resulting width to [minW, maxW].
 *
 * Why the clamp matters: with no floor, repeated zoom-in drives the viewBox width
 * toward zero, so the SVG scale (screen ÷ viewBox width) explodes and every stroke
 * rasterizes at tens of thousands of pixels. On a large model that exhausts GPU /
 * RAM and the renderer dies (blank "reload" screen). The floor keeps the scale
 * bounded; the ceiling stops runaway zoom-out.
 *
 * Returns the SAME object reference when the zoom is already at a limit (effective
 * factor ≈ 1), so callers using it as React state get a no-op and skip re-render.
 */
export function zoomViewBox(vb: ViewBox, factor: number, ax: number, ay: number, minW: number, maxW: number): ViewBox {
  if (!Number.isFinite(factor) || factor <= 0) return vb; // degenerate input → ignore
  let f = factor;
  const targetW = vb.w * f;
  if (targetW < minW) f = minW / vb.w;        // clamp zoom-in (the crash guard)
  else if (targetW > maxW) f = maxW / vb.w;   // clamp zoom-out
  if (!Number.isFinite(f) || f <= 0 || Math.abs(f - 1) < 1e-9) return vb; // no-op / at a limit
  return {
    x: ax - (ax - vb.x) * f,
    y: ay - (ay - vb.y) * f,
    w: vb.w * f,
    h: vb.h * f,
  };
}
