/**
 * Shared visual theme — single source of truth for typography and color.
 *
 * Components style themselves inline; every font/size/weight/color they use
 * should come from here so the app reads as one system. The body rule in
 * index.css mirrors FONT.ui — change them together.
 *
 * Structure:
 *  • FONT / TYPE / WEIGHT / TRACK — the typographic scale.
 *  • INK / SURFACE / BORDER / DARK / ACCENT — neutrals + the one accent.
 *  • STATUS (+ STATUS_DARK) — pass/warn/fail/none, the ONLY status hues.
 *  • MAP_* / CATEGORICAL / DIAGRAM — map + dataviz palettes.
 *  • CODE_ACCENT / MEMBER_COLOR / BARS — engineering-domain conventions.
 *  • LABEL_STYLE / MONO_NUM — composed recipes spread into inline styles.
 */
import type { CSSProperties } from 'react';
import { NEAR_CAPACITY } from './utils/sco/resultStatus'; // 0.9 — the app-wide warn threshold

// ── Typography ────────────────────────────────────────────────────────────────
export const FONT = {
  /** UI text. Inter is bundled via @fontsource-variable/inter (main.tsx). */
  ui: "'Inter Variable', 'Segoe UI', system-ui, -apple-system, sans-serif",
  /** Numbers, DCRs, dimensions, code — a real mono stack, not bare `monospace`. */
  mono: "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', Menlo, monospace",
} as const;

/** The type scale (px). Everything on screen uses one of these six steps. */
export const TYPE = {
  micro: 10,   // uppercase micro-labels, chip captions — the floor
  label: 11,   // field labels, secondary/meta text, smallest table cell
  body: 12,    // workhorse: table cells, inputs, buttons, dropdowns
  bodyLg: 13,  // tabs, panel titles, primary row text (body default)
  heading: 16, // card/modal headings
  title: 20,   // page/project title, KPI numerals
} as const;

export const WEIGHT = { normal: 400, semibold: 600, bold: 700 } as const;
export const TRACK = { wide: '0.06em' } as const; // uppercase-label letter spacing

/** Icon sizes (px) paired to the type scale, plus the one stroke weight the
 *  whole set is drawn at. See components/common/Icon.tsx. */
export const ICON = {
  sm: 14,       // dense tables/rows, alongside TYPE.label
  md: 16,       // DEFAULT — tabs and buttons, alongside TYPE.bodyLg
  lg: 20,       // card/panel headings, alongside TYPE.heading
  xl: 24,       // page titles, alongside TYPE.title
  stroke: 1.5,  // every icon; never vary this per-icon
} as const;

// ── Neutrals (light surfaces) ─────────────────────────────────────────────────
export const INK = {
  strong: '#111827',    // headings, key values
  base: '#374151',      // primary body text
  secondary: '#6b7280', // labels, meta (4.8:1 on white)
  muted: '#9ca3af',     // hints/placeholders ONLY — never essential text
  inverse: '#f9fafb',   // text on dark/accent fills
} as const;

export const SURFACE = {
  app: '#f3f4f6',     // page background
  raised: '#ffffff',  // cards, panels, modals
  subtle: '#f9fafb',  // table headers, zebra rows, wells
} as const;

export const BORDER = {
  subtle: '#f3f4f6',
  default: '#e5e7eb',
  strong: '#d1d5db',
} as const;

/** Dark chrome — tooltips and other floating dark surfaces. */
export const DARK = {
  surface: '#1e293b',
  border: '#334155',
  ink: '#f1f5f9',
  inkSecondary: '#cbd5e1',
  inkMuted: '#94a3b8',
} as const;

// ── Accent (one blue) ─────────────────────────────────────────────────────────
export const ACCENT = {
  primary: '#2563eb',
  primaryHover: '#1d4ed8',
  softBg: '#eff6ff',
  softBorder: '#bfdbfe',
} as const;

// ── Status: the ONLY pass/warn/fail hues in the app ──────────────────────────
// The -700 weights: dark enough that status TEXT passes WCAG AA (≥4.5:1) on
// white and on its own tint, while white chip text on the solid fill also
// passes. (The lighter -600s read fine as fills but fail as small text.)
export const STATUS = {
  ok: '#15803d', okBg: '#f0fdf4', okBorder: '#bbf7d0',
  warn: '#b45309', warnBg: '#fffbeb', warnBorder: '#fde68a',
  fail: '#b91c1c', failBg: '#fef2f2', failBorder: '#fecaca',
  none: '#6b7280', noneBg: '#f3f4f6', noneBorder: '#e5e7eb',
} as const;

/** Status text on DARK.surface (light surfaces use STATUS). */
export const STATUS_DARK = {
  ok: '#4ade80', warn: '#fbbf24', fail: '#f87171', none: '#94a3b8',
} as const;

// ── Map + dataviz ─────────────────────────────────────────────────────────────
export interface DcrBand { max: number; color: string; label: string }

/** The four map DCR colors, in order (green → lime → amber → red). The lime
 *  "headroom" band is a map-only refinement; tables and chips stay three-tone
 *  via dcrColor(). */
export const MAP_DCR_COLORS = [STATUS.ok, '#84cc16', STATUS.warn, STATUS.fail] as const;

/** Build the four DCR bands from three ascending cut-points [t1, t2, t3]. The
 *  Map legend is user-editable, so the fills and legend both derive from this. */
export function dcrBandsFrom(t: readonly [number, number, number]): DcrBand[] {
  const f = (v: number) => v.toFixed(2);
  return [
    { max: t[0], color: MAP_DCR_COLORS[0], label: `< ${f(t[0])}` },
    { max: t[1], color: MAP_DCR_COLORS[1], label: `${f(t[0])}–${f(t[1])}` },
    { max: t[2], color: MAP_DCR_COLORS[2], label: `${f(t[1])}–${f(t[2])}` },
    { max: Infinity, color: MAP_DCR_COLORS[3], label: `≥ ${f(t[2])}` },
  ];
}

/** Default DCR cut-points and the bands built from them (the app-wide default). */
export const DEFAULT_DCR_THRESHOLDS: [number, number, number] = [0.7, 0.9, 1.0];
export const MAP_DCR_BANDS: DcrBand[] = dcrBandsFrom(DEFAULT_DCR_THRESHOLDS);

export const MAP_GRAY = {
  unlinked: '#d1d5db',   // frame with no designed member
  unassigned: '#9ca3af', // member in no group/bin (or no DCR)
  notRun: STATUS.none,   // no S-Concrete result yet
} as const;

/** Group/bin colors — deliberately NO status hues (green/amber/red are reserved
 *  for pass/warn/fail), so a colored group can never read as a result. */
export const CATEGORICAL = [
  '#2563eb', '#7c3aed', '#0d9488', '#db2777', '#4f46e5', '#0891b2', '#c026d3', '#0369a1',
] as const;

/** Force-diagram series (domain convention: violet moment, cyan shear). */
export const DIAGRAM = { moment: '#7c3aed', shear: '#0891b2' } as const;

// ── Engineering-domain conventions ────────────────────────────────────────────
export const CODE_ACCENT: Record<string, string> = {
  'ACI318-19': ACCENT.primary,
  'ACI318-14': ACCENT.primary,
  'EN1992-1-1': '#7c3aed',
};

export const CODE_BG: Record<string, string> = {
  'ACI318-19': ACCENT.softBg,
  'ACI318-14': ACCENT.softBg,
  'EN1992-1-1': '#f5f3ff',
};

export function codeAccent(code?: string): string {
  return CODE_ACCENT[code ?? ''] ?? ACCENT.primary;
}
export function codeBg(code?: string): string {
  return CODE_BG[code ?? ''] ?? ACCENT.softBg;
}

export const DCR = {
  pass: STATUS.ok, warn: STATUS.warn, fail: STATUS.fail,
  passBg: STATUS.okBg, warnBg: STATUS.warnBg, failBg: STATUS.failBg,
};

export function dcrColor(d: number): string {
  return d > 1 ? DCR.fail : d > NEAR_CAPACITY ? DCR.warn : DCR.pass;
}
export function dcrBg(d: number): string {
  return d > 1 ? DCR.failBg : d > NEAR_CAPACITY ? DCR.warnBg : DCR.passBg;
}

export const MEMBER_COLOR: Record<string, string> = {
  beam: '#2563eb',
};

export const BARS = {
  top: '#2e7d32',       // top / compression-face bars
  bot: '#1565c0',       // bottom / tension-face bars
  side: '#8d6e63',      // side / intermediate bars
  tie: '#e91e8c',       // stirrups, ties, spirals
  concrete: '#eceff1',
  concreteEdge: '#546e7a',
};

// ── Composed recipes ──────────────────────────────────────────────────────────
/** The uppercase section/field micro-label. Spread it, then override what
 *  differs: panel-level headers = { ...LABEL_STYLE, fontSize: TYPE.label,
 *  color: INK.base }. */
export const LABEL_STYLE: CSSProperties = {
  fontSize: TYPE.micro,
  fontWeight: WEIGHT.bold,
  textTransform: 'uppercase',
  letterSpacing: TRACK.wide,
  color: INK.secondary,
};

/** Numeric text (DCRs, forces, dimensions): mono with tabular digits so
 *  columns of numbers align. */
export const MONO_NUM: CSSProperties = {
  fontFamily: FONT.mono,
  fontVariantNumeric: 'tabular-nums',
};
