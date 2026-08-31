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

// ── Rotation-stable 3D framing ───────────────────────────────────────────────

export interface Sphere { cx: number; cy: number; cz: number; r: number }

/**
 * Bounding sphere of a point cloud (centroid + max radius).
 *
 * This is what makes orbiting stable. An ORTHOGRAPHIC projection of a sphere is
 * a circle of the same radius at every camera angle, so a fit built on it never
 * changes scale or centre as the camera turns. Fitting the projected BOUNDING
 * BOX instead — which is what fitProjected does — recomputes both on every
 * frame, and the model visibly pumps and drifts while the user drags. That was
 * the single biggest source of the jarring feel.
 */
export function boundingSphere(pts: Point3[]): Sphere {
  if (!pts.length) return { cx: 0, cy: 0, cz: 0, r: 1 };
  let sx = 0, sy = 0, sz = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sz += p.z; }
  const n = pts.length;
  const cx = sx / n, cy = sy / n, cz = sz / n;
  let r2 = 0;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { cx, cy, cz, r: Math.max(Math.sqrt(r2), 1e-6) };
}

/**
 * Camera-independent model → SVG mapping, built once per model/canvas and reused
 * for every camera angle. Points are projected RELATIVE to the sphere centre and
 * laid down about the canvas centre, so rotation only reorients the model — it
 * never rescales or recentres it.
 *
 * The sphere fit is deliberately looser than a tight box fit; the caller tightens
 * on demand via a fit-to-view that reframes the viewBox (see projectedBounds).
 */
export function stableProjection(
  sphere: Sphere, width: number, height: number, pad = 40,
): (p: Point3, cam: Camera) => { sx: number; sy: number } {
  const usable = Math.max(Math.min(width - 2 * pad, height - 2 * pad), 1);
  const scale = usable / (2 * sphere.r);
  const cxPx = width / 2, cyPx = height / 2;
  return (p, cam) => {
    const q = project3({ x: p.x - sphere.cx, y: p.y - sphere.cy, z: p.z - sphere.cz }, cam);
    return { sx: cxPx + q.u * scale, sy: cyPx + q.v * scale };
  };
}

/** Screen-space bounds of a set of already-mapped points — drives fit-to-view. */
export function screenBounds(
  pts: { sx: number; sy: number }[],
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (!pts.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.sx) || !Number.isFinite(p.sy)) continue;
    if (p.sx < minX) minX = p.sx;
    if (p.sx > maxX) maxX = p.sx;
    if (p.sy < minY) minY = p.sy;
    if (p.sy > maxY) maxY = p.sy;
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

/**
 * viewBox that frames `b` inside a `width` × `height` canvas at the canvas
 * aspect ratio, with `pad` px of breathing room. Used by fit-to-view so the 3D
 * model fills the frame on demand without the projection itself ever moving.
 */
export function viewBoxForBounds(
  b: { minX: number; maxX: number; minY: number; maxY: number },
  width: number, height: number, pad = 24,
): ViewBox {
  const bw = Math.max(b.maxX - b.minX, 1);
  const bh = Math.max(b.maxY - b.minY, 1);
  const aspect = width / Math.max(height, 1);
  // Grow the tighter axis so the viewBox matches the canvas aspect — otherwise
  // the SVG's own preserveAspectRatio would re-centre and undo the framing.
  let w = bw, h = bh;
  if (bw / bh < aspect) w = bh * aspect; else h = bw / aspect;
  const padScale = 1 + (2 * pad) / Math.max(width, 1);
  w *= padScale; h *= padScale;
  return { x: (b.minX + b.maxX) / 2 - w / 2, y: (b.minY + b.maxY) / 2 - h / 2, w, h };
}

// ── Camera presets and damping ───────────────────────────────────────────────

/** Standard views, matching what CAD/BIM tools bind to their view shortcuts. */
export const VIEW_PRESETS = {
  /** Looking straight down — reads as the plan. */
  top:   { yaw: 0,           pitch: Math.PI / 2 - 0.05 },
  front: { yaw: 0,           pitch: 0.05 },
  right: { yaw: Math.PI / 2, pitch: 0.05 },
  /** The default three-quarter view. */
  iso:   DEFAULT_CAMERA,
} as const satisfies Record<string, Camera>;

/** Name of a canned camera position ('top', 'front', 'right', 'iso'). */
export type ViewPreset = keyof typeof VIEW_PRESETS;

/** Wrap an angle difference into (−π, π] so damping always takes the short way. */
export function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Ease `current` toward `target` by fraction `t`. Critically damped enough to
 * take the jitter out of a mouse drag without feeling floaty — this is what
 * makes an orbit read as smooth rather than stepped.
 *
 * Returns `target` (exactly) once within `eps`, so the animation loop can stop
 * instead of chasing an asymptote forever.
 */
export function dampCamera(current: Camera, target: Camera, t: number, eps = 1e-4): Camera {
  const dYaw = shortestAngle(current.yaw, target.yaw);
  const dPitch = target.pitch - current.pitch;
  if (Math.abs(dYaw) < eps && Math.abs(dPitch) < eps) return target;
  return { yaw: current.yaw + dYaw * t, pitch: current.pitch + dPitch * t };
}

// ── Wheel input ──────────────────────────────────────────────────────────────

/**
 * Wheel delta normalised to pixels across `deltaMode` and browser.
 *
 * A fixed per-tick zoom step (the old `deltaY > 0 ? 1.15 : 0.87`) ignores HOW
 * FAR the wheel or trackpad moved: a mouse notch and a feather-light two-finger
 * glide both jumped a full 15%, which is why zooming felt steppy and overshot
 * constantly on a laptop.
 */
export function normalizeWheelDelta(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY)) return 0;
  const perLine = 16, perPage = 400;
  const px = deltaMode === 1 ? deltaY * perLine : deltaMode === 2 ? deltaY * perPage : deltaY;
  // A single mouse notch is ~100px in most browsers; clamp so a violent flick or
  // a synthetic jumbo delta can't teleport the view.
  return Math.max(-320, Math.min(320, px));
}

/**
 * Continuous zoom factor for a normalised wheel delta. Exponential, so zooming
 * feels the same at every scale and out-then-back-in lands exactly where it
 * started (exp(d)·exp(−d) = 1) — a fixed 1.15/0.87 pair does not round-trip.
 */
export function wheelZoomFactor(delta: number, strength = 0.0022): number {
  return Math.exp(delta * strength);
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
