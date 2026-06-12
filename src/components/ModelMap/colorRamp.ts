/**
 * Continuous color ramp for hotspot map overlays (blue→green→yellow→red).
 * Used for flexural steel % and stirrup Av/ft overlays.
 */

interface RGBStop { r: number; g: number; b: number; pos: number }

const RAMP: RGBStop[] = [
  { r: 59,  g: 130, b: 246, pos: 0.00 }, // blue-500  (light demand)
  { r: 34,  g: 197, b: 94,  pos: 0.33 }, // green-500
  { r: 234, g: 179, b: 8,   pos: 0.66 }, // yellow-500
  { r: 239, g: 68,  b: 68,  pos: 1.00 }, // red-500   (heavy demand)
];

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

export function valueToRampColor(v: number, min: number, max: number): string {
  const range = max - min;
  const t = range > 0 ? Math.max(0, Math.min(1, (v - min) / range)) : 0;
  // Find surrounding stops
  let lo = RAMP[0], hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (t <= RAMP[i + 1].pos) { lo = RAMP[i]; hi = RAMP[i + 1]; break; }
  }
  const span = hi.pos - lo.pos;
  const tt = span > 0 ? (t - lo.pos) / span : 0;
  const r = lerp(lo.r, hi.r, tt);
  const g = lerp(lo.g, hi.g, tt);
  const b = lerp(lo.b, hi.b, tt);
  return `rgb(${r},${g},${b})`;
}

/** Five evenly-spaced stops for rendering a legend gradient. */
export function rampStops(min: number, max: number): { color: string; value: number }[] {
  return [0, 0.25, 0.5, 0.75, 1].map(t => ({
    color: valueToRampColor(min + t * (max - min), min, max),
    value: min + t * (max - min),
  }));
}
