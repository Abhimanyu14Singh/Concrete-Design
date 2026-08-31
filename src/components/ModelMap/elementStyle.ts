/**
 * How the model's four element kinds are drawn — the user's own preference.
 *
 * Beams, columns, floors and walls each had their colour, opacity and fill hard-coded at
 * the point they were drawn, chosen to read well on a light background over a grid. Those
 * choices are still the DEFAULTS here; what changes is that they are now data, so the
 * Preferences dialog can offer them and the map can honour whatever the engineer picks.
 *
 * WHY OPACITY IS SEPARATE FROM COLOUR. The map is layered — slabs sit behind walls, which
 * sit behind the framing — and the whole arrangement only reads because the layers behind
 * are washed out rather than merely a paler colour. Baking that into a colour would make
 * "make the floors a bit stronger" a matter of guessing a lighter hex; as its own control
 * it is one slider, and the colour stays the colour.
 *
 * WHY FILL IS ONLY ON THE AREA KINDS. Beams and columns are strokes — there is nothing to
 * fill — so offering the control on them would be a dead input. Floors and walls are
 * polygons, and the drafting convention the map follows (hatch = cut material, so a wall
 * is poché'd and a slab is a light wash) is exactly the thing someone may want to
 * override for their own drawing standard.
 */

/** How an area element is filled. `outline` draws the edge only. */
export type FillStyle = 'solid' | 'hatch' | 'outline';

export interface ElementStyle {
  /** CSS hex colour, `#rrggbb`. */
  color: string;
  /** 0–1. Applied to the whole element, edge included. */
  opacity: number;
  /** Area elements only; ignored on beams and columns. */
  fill?: FillStyle;
}

export interface ElementStyles {
  beam: ElementStyle;
  column: ElementStyle;
  floor: ElementStyle;
  wall: ElementStyle;
}

/** The map's own drawing, as it has always looked — see the note above. */
export const DEFAULT_ELEMENT_STYLES: ElementStyles = {
  // The plain beam colour, used when the plan is not colouring by a result. Slate rather
  // than black: the framing is the subject, but a page of pure black lines over a grid
  // reads as a wireframe rather than a drawing.
  beam: { color: '#475569', opacity: 1 },
  // Context only, never designed — drawn back so it cannot be mistaken for framing.
  column: { color: '#94a3b8', opacity: 0.65 },
  // A light wash you read ACROSS: the slab is the ground the plan sits on.
  floor: { color: '#94a3b8', opacity: 0.16, fill: 'solid' },
  // Poché'd, because hatch means cut material.
  wall: { color: '#94a3b8', opacity: 1, fill: 'hatch' },
};

const KINDS = ['beam', 'column', 'floor', 'wall'] as const;
const FILLS: FillStyle[] = ['solid', 'hatch', 'outline'];
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isFrac = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Shape check for a persisted value — untrusted input out of localStorage. */
export function isElementStyles(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return KINDS.every(k => {
    const s = o[k] as Record<string, unknown> | undefined;
    return !!s && isHex(s.color) && isFrac(s.opacity)
      && (s.fill === undefined || FILLS.includes(s.fill as FillStyle));
  });
}

/**
 * Merge a saved value over the defaults, FIELD BY FIELD.
 *
 * A whole-object fallback would throw away three good preferences because a fourth was
 * malformed — and worse, a preference set added later would make every previously saved
 * value invalid at once. Each field is taken only if it is itself valid.
 */
export function mergeElementStyles(saved: unknown): ElementStyles {
  const out = { ...DEFAULT_ELEMENT_STYLES };
  if (!saved || typeof saved !== 'object') return out;
  const o = saved as Record<string, unknown>;
  for (const k of KINDS) {
    const s = o[k] as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object') continue;
    const base = DEFAULT_ELEMENT_STYLES[k];
    out[k] = {
      color: isHex(s.color) ? s.color : base.color,
      opacity: isFrac(s.opacity) ? s.opacity : base.opacity,
      ...(base.fill !== undefined
        ? { fill: FILLS.includes(s.fill as FillStyle) ? s.fill as FillStyle : base.fill }
        : {}),
    };
  }
  return out;
}

/** `#rrggbb` + alpha → `rgba(...)`, for the fills that need the opacity baked in. */
export function withAlpha(hex: string, alpha: number): string {
  const h = isHex(hex) ? hex : '#94a3b8';
  const n = parseInt(h.slice(1), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
