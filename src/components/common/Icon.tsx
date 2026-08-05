/**
 * The app's icon set — "refined line": one 24×24 grid, one 1.5px stroke,
 * round caps and joins, no fills except deliberate rebar/marker dots.
 *
 * Every glyph paints with `currentColor`, which is the whole point of the set.
 * The old emoji could not: on the active header tab the label turns white while
 * `🗺` stayed multicolour on the blue fill, because emoji are drawn by the OS
 * font and ignore `color`. These inherit whatever colour their heading has, so
 * no caller needs per-state icon colour logic.
 *
 * Sizes and stroke weight come from ICON in theme.ts. Icons are decorative by
 * default (`aria-hidden`) — always keep the text label. Pass `title` only for
 * the rare icon-only control that has no adjacent text.
 */
import type { CSSProperties, ReactNode } from 'react';
import { ICON } from '../../theme';

export type IconName =
  // primary nav
  | 'viewer' | 'dashboard' | 'member' | 'help'
  // map workflow tabs
  | 'design' | 'groupDashboard' | 'verify'
  // help sub-tabs
  | 'docs' | 'quickstart' | 'keyboard' | 'faq'
  // header chrome
  | 'members' | 'etabsImport' | 'undo' | 'redo' | 'export' | 'settings' | 'saved' | 'unsaved'
  // design checks
  | 'flexure' | 'shear' | 'torsion' | 'axial' | 'pmInteraction' | 'crackWidth' | 'steelLimits'
  // editor panels
  | 'materials' | 'sectionDims' | 'reinforcement' | 'loadCases'
  // map panels
  | 'takeoff' | 'savings' | 'autoGroup' | 'groupSelection'
  // map toolbar
  | 'visibility' | 'filter' | 'colourBy' | 'lineWeight'
  // actions & status
  | 'suggest' | 'warning' | 'reviewed' | 'delete' | 'duplicate' | 'inspect' | 'resync';

/** Filled marker (rebar dot, bullet, status dot) — the only fills in the set. */
const dot = (cx: number, cy: number, r: number) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

const GLYPHS: Record<IconName, ReactNode> = {
  // ── Primary nav ─────────────────────────────────────────────────────────────
  /** Four-bay structural plan with a column at the intersection. A 3×3 grid was
   *  tried first and read as a generic app launcher. */
  viewer: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M12 4v16M3 12h18" />
      {dot(12, 12, 1.5)}
    </>
  ),
  dashboard: (
    <>
      <rect x="3" y="3.5" width="7.5" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7.5" height="5" rx="1.5" />
      <rect x="3" y="15.5" width="7.5" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7.5" height="9" rx="1.5" />
    </>
  ),
  /** Beam cross-section, four corner bars. The stirrup is deliberately omitted:
   *  at 16px it and the bars collapsed into an unreadable double-square. */
  member: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
      {dot(8, 8.6, 1.45)}{dot(16, 8.6, 1.45)}{dot(8, 15.4, 1.45)}{dot(16, 15.4, 1.45)}
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M9.4 9.4a2.7 2.7 0 1 1 3.7 2.5c-.8.3-1.1 1-1.1 1.8v.3" />
      {dot(12, 17, 1)}
    </>
  ),

  // ── Map workflow tabs ───────────────────────────────────────────────────────
  /** Stirrup with its 135° hook plus longitudinal bars — what the Design pane edits. */
  design: (
    <>
      <rect x="4.5" y="6" width="15" height="13" rx="2" />
      <path d="M16.5 6l3.2-3.2" />
      {dot(7.8, 9, 1.05)}{dot(16.2, 9, 1.05)}
      {dot(7.8, 16, 1.05)}{dot(12, 16, 1.05)}{dot(16.2, 16, 1.05)}
    </>
  ),
  groupDashboard: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M7 16.5v-4M12 16.5v-6M17 16.5v-2.5" />
    </>
  ),
  /** Shield + check: "independently checked and signed off", not "research". */
  verify: (
    <>
      <path d="M12 2.8l7.6 3.1v5.6c0 4.6-3.1 8.6-7.6 9.7-4.5-1.1-7.6-5.1-7.6-9.7V5.9z" />
      <path d="M8.8 11.9l2.4 2.4 4.4-4.7" />
    </>
  ),

  // ── Help sub-tabs ───────────────────────────────────────────────────────────
  docs: (
    <>
      <path d="M12 6.4C10.4 4.9 8.3 4.3 4 4.3v13.4c4.3 0 6.4.6 8 2.1 1.6-1.5 3.7-2.1 8-2.1V4.3c-4.3 0-6.4.6-8 2.1z" />
      <path d="M12 6.4v13.4" />
    </>
  ),
  /** Play, not a rocket — a rocket turns to mush below 20px. */
  quickstart: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M10.2 8.4l6 3.6-6 3.6z" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.3 9.6h.01M9.8 9.6h.01M13.3 9.6h.01M16.8 9.6h.01M6.3 12.8h.01M9.8 12.8h.01M13.3 12.8h.01M16.8 12.8h.01M8.5 15.6h7" />
    </>
  ),
  faq: (
    <>
      <path d="M20.6 11.6a8.4 8.4 0 0 1-11.9 7.7L3.6 20.7l1.4-4.7A8.4 8.4 0 1 1 20.6 11.6z" />
      <path d="M10 9.3a2.1 2.1 0 1 1 2.9 2c-.5.2-.8.7-.8 1.3v.3" />
      {dot(12.1, 15.5, 0.85)}
    </>
  ),

  // ── Header chrome ───────────────────────────────────────────────────────────
  /** The list of *structural* members — deliberately not a people icon. */
  members: (
    <>
      {dot(4.6, 7, 1.3)}{dot(4.6, 12, 1.3)}{dot(4.6, 17, 1.3)}
      <path d="M8.6 7h11.4M8.6 12h11.4M8.6 17h7.6" />
    </>
  ),
  /** Arrow descending into a tray — data coming *in*. Exact inverse of `export`. */
  etabsImport: (
    <>
      <path d="M12 3v10.5" />
      <path d="M8.2 10l3.8 3.8 3.8-3.8" />
      <path d="M4 15.5v3a2.2 2.2 0 0 0 2.2 2.2h11.6a2.2 2.2 0 0 0 2.2-2.2v-3" />
    </>
  ),
  undo: (
    <>
      <path d="M4.5 8.5h9.8a5.8 5.8 0 1 1 0 11.6H7.6" />
      <path d="M8.3 4.7L4.5 8.5l3.8 3.8" />
    </>
  ),
  redo: (
    <>
      <path d="M19.5 8.5H9.7a5.8 5.8 0 1 0 0 11.6h6.7" />
      <path d="M15.7 4.7l3.8 3.8-3.8 3.8" />
    </>
  ),
  export: (
    <>
      <path d="M12 15V3.5" />
      <path d="M8.2 7.3L12 3.5l3.8 3.8" />
      <path d="M4 15.5v3a2.2 2.2 0 0 0 2.2 2.2h11.6a2.2 2.2 0 0 0 2.2-2.2v-3" />
    </>
  ),
  /** Sliders, not a cog. A toothed gear turns to mud at 16px, and the 8-spoke
   *  radial version that replaced it read as a sun/brightness control. */
  settings: (
    <>
      <path d="M3.4 7.2h9.2M17.6 7.2h3M3.4 12h3.4M11.8 12h8.8M3.4 16.8h9.2M17.6 16.8h3" />
      <circle cx="15.1" cy="7.2" r="2.5" />
      <circle cx="9.3" cy="12" r="2.5" />
      <circle cx="15.1" cy="16.8" r="2.5" />
    </>
  ),
  saved: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M8.1 12.3l2.7 2.7 5.1-5.6" />
    </>
  ),
  /** Same outer ring as `saved` so the chip never reflows on state change. */
  unsaved: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      {dot(12, 12, 3.2)}
    </>
  ),

  // ── Design checks ───────────────────────────────────────────────────────────
  /** Beam line with its moment parabola detached below — they must not touch,
   *  or the pair fuses into a meaningless bowl. */
  flexure: (
    <>
      <path d="M2.5 5.4h19" />
      <path d="M5.4 9.8c2.2 7.4 11 7.4 13.2 0" />
    </>
  ),
  shear: (
    <>
      <path d="M3 9h12.4" />
      <path d="M12.6 6.2L15.4 9l-2.8 2.8" />
      <path d="M21 15H8.6" />
      <path d="M11.4 12.2L8.6 15l2.8 2.8" />
    </>
  ),
  torsion: (
    <>
      <path d="M2.8 12h18.4" />
      <path d="M6.2 8.4c3.2 0 3.2 7.2 6.4 7.2s3.2-7.2 6.4-7.2" />
      <path d="M16.9 6.3l2.4 2.1-2.4 2.1" />
    </>
  ),
  axial: (
    <>
      <rect x="8.6" y="7.2" width="6.8" height="9.6" rx="1" />
      <path d="M12 2.4v3.6M12 18v3.6" />
      <path d="M9.6 4.8L12 2.4l2.4 2.4M9.6 19.2L12 21.6l2.4-2.4" />
    </>
  ),
  pmInteraction: (
    <>
      <path d="M5 3v16.4h16" />
      <path d="M5.4 5.4c6.6.9 10.2 5 10.8 14" />
    </>
  ),
  /** The measurement is the point, not the crack. */
  crackWidth: (
    <>
      <path d="M12.6 2.8l-2.4 4.8 3.2 2.4-2.8 4.4 2.8 2-1.8 4.8" />
      <path d="M4.4 12h3.2M16.4 12h3.2" />
      <path d="M6.6 10.4L4.4 12l2.2 1.6M17.4 10.4L19.6 12l-2.2 1.6" />
    </>
  ),
  steelLimits: (
    <>
      <path d="M3.4 4.4h17.2M3.4 19.6h17.2" />
      <rect x="9" y="8" width="6" height="8" rx="1" />
      <path d="M12 4.4V8M12 16v3.6" />
    </>
  ),

  // ── Editor panels ───────────────────────────────────────────────────────────
  materials: (
    <>
      <path d="M12 2.8l9 4.4-9 4.4-9-4.4z" />
      <path d="M3 12l9 4.4 9-4.4" />
      <path d="M3 16.6L12 21l9-4.4" />
    </>
  ),
  sectionDims: (
    <>
      <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="1" />
      <path d="M6.4 3.4h11.2M6.4 2.6v1.6M17.6 2.6v1.6" />
      <path d="M21 6.4v11.2M20.2 6.4h1.6M20.2 17.6h1.6" />
    </>
  ),
  reinforcement: (
    <>
      <rect x="3.4" y="5.4" width="17.2" height="13.2" rx="1.5" />
      {dot(7.4, 8.8, 1.15)}{dot(12, 8.8, 1.15)}{dot(16.6, 8.8, 1.15)}
      {dot(7.4, 15.2, 1.15)}{dot(12, 15.2, 1.15)}{dot(16.6, 15.2, 1.15)}
    </>
  ),
  /** A distributed load bearing down on a member. */
  loadCases: (
    <>
      <path d="M2.8 17.4h18.4" />
      <path d="M7 5.4v8M12 5.4v8M17 5.4v8" />
      <path d="M5.4 11.6L7 13.4l1.6-1.8M10.4 11.6L12 13.4l1.6-1.8M15.4 11.6L17 13.4l1.6-1.8" />
    </>
  ),

  // ── Map panels ──────────────────────────────────────────────────────────────
  takeoff: (
    <>
      <path d="M12 2.8l8.6 4.3v9.8L12 21.2l-8.6-4.3V7.1z" />
      <path d="M3.4 7.1L12 11.4l8.6-4.3M12 11.4v9.8" />
    </>
  ),
  savings: (
    <>
      <path d="M3 6.6l6.8 6.8 4-4 7.2 7.2" />
      <path d="M21 11.4v5.2h-5.2" />
    </>
  ),
  /** Three settled groups, one still dashed — the proposal not yet accepted. */
  autoGroup: (
    <>
      <rect x="3" y="3.4" width="7.4" height="7.4" rx="1.5" />
      <rect x="13.6" y="3.4" width="7.4" height="7.4" rx="1.5" />
      <rect x="3" y="13.6" width="7.4" height="7.4" rx="1.5" />
      <rect x="13.6" y="13.6" width="7.4" height="7.4" rx="1.5" strokeDasharray="2 1.8" />
    </>
  ),

  // ── Actions & status ────────────────────────────────────────────────────────
  /** Marquee + plus — bank the current map selection as a new design group. The
   *  dashed rule is the lasso, echoing autoGroup's dashed (proposed) bin. */
  groupSelection: (
    <>
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="2.2" strokeDasharray="3 2.2" />
      <path d="M12 8.3v7.4M8.3 12h7.4" />
    </>
  ),
  suggest: (
    <>
      <path d="M11 3.2l1.5 4.1 4.1 1.5-4.1 1.5L11 14.4 9.5 10.3 5.4 8.8l4.1-1.5z" />
      <path d="M17.8 14.2l.85 2.35 2.35.85-2.35.85-.85 2.35-.85-2.35-2.35-.85 2.35-.85z" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.2l9.2 15.6H2.8z" />
      <path d="M12 10v4.2" />
      {dot(12, 17, 0.95)}
    </>
  ),
  reviewed: <path d="M4 12.6l5.2 5.2L20 6.2" />,
  delete: (
    <>
      <path d="M4 6.4h16" />
      <path d="M9.6 6.4V4.6a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v1.8" />
      <path d="M6.6 6.4l.95 13.1a1.6 1.6 0 0 0 1.6 1.5h5.7a1.6 1.6 0 0 0 1.6-1.5l.95-13.1" />
      <path d="M10.4 10.4v6.4M13.6 10.4v6.4" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8.4" y="8.4" width="12" height="12" rx="2" />
      <path d="M16.2 8.4V6a2.4 2.4 0 0 0-2.4-2.4H6A2.4 2.4 0 0 0 3.6 6v7.8a2.4 2.4 0 0 0 2.4 2.4h2.4" />
    </>
  ),
  inspect: (
    <>
      <circle cx="10.6" cy="10.6" r="6.6" />
      <path d="M15.3 15.3L20.8 20.8" />
    </>
  ),
  resync: (
    <>
      <path d="M20.4 11.2a8.4 8.4 0 0 0-14.5-5.3L3.2 8.6" />
      <path d="M3.2 4.2v4.4h4.4" />
      <path d="M3.6 12.8a8.4 8.4 0 0 0 14.5 5.3l2.7-2.7" />
      <path d="M20.8 19.8v-4.4h-4.4" />
    </>
  ),

  // ── Map toolbar ─────────────────────────────────────────────────────────────
  /** Eye — what is DRAWN on the plan (members, walls, grids, floors). */
  visibility: (
    <>
      <path d="M2 12s3.6-6.4 10-6.4S22 12 22 12s-3.6 6.4-10 6.4S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  /** Funnel — narrowing the set down to a subset (groups, sections). */
  filter: <path d="M3.4 5h17.2l-6.7 7.9v5.4l-3.8 2.2v-7.6L3.4 5Z" />,
  /**
   * Colour-by. The dropdown spans DCR, design group, section, steel %, grades,
   * S-Concrete status — so the glyph is a PALETTE (one surface, many distinct
   * wells) rather than any single mode's symbol: it reads as "pick the scheme
   * the plan is painted with", which is exactly what the control does. The wells
   * are the set's usual marker dots, so it needs no new drawing primitive.
   */
  colourBy: (
    <>
      <path d="M12 3.2a8.8 8.8 0 0 0 0 17.6c1.5 0 2.2-1 2.2-1.9 0-1.3-1.2-1.6-1.2-2.7 0-.9.7-1.6 1.7-1.6h1.6a4.5 4.5 0 0 0 4.5-4.5c0-4-4-6.9-8.8-6.9Z" />
      {dot(8.1, 9.2, 1.25)}{dot(12, 7.3, 1.25)}{dot(15.9, 9.4, 1.25)}{dot(7.6, 13.9, 1.25)}
    </>
  ),
  /**
   * Line weight — three rules, thin to thick. Thickness IS the meaning here, so
   * these are FILLED rects rather than strokes: varying stroke-width per glyph is
   * banned by this set's rules (see the header), and a filled bar renders the
   * same 1px hairline crisply at 16px where a 0.75 stroke would go muddy.
   */
  lineWeight: (
    <g fill="currentColor" stroke="none">
      <rect x="3" y="6.4" width="18" height="1.1" rx="0.55" />
      <rect x="3" y="10.9" width="18" height="2.2" rx="1.1" />
      <rect x="3" y="16.1" width="18" height="3.5" rx="1.75" />
    </g>
  ),
};

export interface IconProps {
  name: IconName;
  /** px; defaults to ICON.md (16) — the tab/button size. */
  size?: number;
  /** Accessible name. Omit for decorative icons that sit beside a text label. */
  title?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = ICON.md, title, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON.stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      style={{ display: 'block', flex: 'none', ...style }}
    >
      {title && <title>{title}</title>}
      {GLYPHS[name]}
    </svg>
  );
}
