/**
 * Plan-viewport math for the model map. Kept pure (no React) so the zoom clamp —
 * the guard that stops "playing around" with the wheel from crashing the renderer
 * — is unit-testable in isolation.
 */
export interface ViewBox { x: number; y: number; w: number; h: number }

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
