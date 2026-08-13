import React from "react";

// SVG icons ported 1:1 from the S-Dash prototype (dc-runtime ICN + toolbar SVGs).

const Svg = ({ sw = 1.7, size = 17, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const Dot = ({ cx, cy, r = 1.05 }) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;
// a letter set into the middle of an icon (auto-size / auto-detail / revert / grade)
const Glyph = ({ ch, x = 12, y = 16, size = 11 }) => (
  <text x={x} y={y} textAnchor="middle" fontSize={size} fontWeight="800"
        fill="currentColor" stroke="none" style={{ fontFamily: "inherit" }}>{ch}</text>
);

// overflow "more" glyph — the buttons a compact toolbar could not fit
export const IconMore = ({ size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="6" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18" cy="12" r="1.7" />
  </svg>
);

// the pop-out windows group: two overlapping panes
export const IconWindows = ({ size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinejoin="round">
    <rect x="3" y="5" width="12" height="10" rx="1.6" /><rect x="9" y="9" width="12" height="10" rx="1.6" />
  </svg>
);

// mode-button icons (keyed by mode)
export const MODE_ICON = {
  // Flags view: a flag on a pole
  flags:    <Svg><line x1={6} y1={21} x2={6} y2={3} /><path d="M6 4h12l-3 4 3 4H6" /></Svg>,
  all:      <Svg><rect x={3} y={3} width={18} height={18} rx={1.5} /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></Svg>,
  // concrete grade: just the f'c text (no box)
  material: <Svg><Glyph ch="f'c" size={16} y={17} /></Svg>,
  // rebar / tie yield: the fy · fyt text
  fy:       <Svg><Glyph ch="fy" size={16} y={17} /></Svg>,
  fyt:      <Svg><Glyph ch="fyt" size={13} y={16.5} /></Svg>,
  // dimensions: a square with a diagonal dimension line across its interior
  size:     <Svg><rect x={4} y={4} width={16} height={16} rx={2} /><path d="M7.5 16.5l9-9M7.5 16.5v-3M7.5 16.5h3M16.5 7.5v3M16.5 7.5h-3" /></Svg>,
  bars:     <Svg><rect x={4} y={4} width={16} height={16} rx={1} /><Dot cx={7.5} cy={7.5} r={0.95} /><Dot cx={12} cy={7.5} r={0.95} /><Dot cx={16.5} cy={7.5} r={0.95} /><Dot cx={7.5} cy={12} r={0.95} /><Dot cx={16.5} cy={12} r={0.95} /><Dot cx={7.5} cy={16.5} r={0.95} /><Dot cx={12} cy={16.5} r={0.95} /><Dot cx={16.5} cy={16.5} r={0.95} /></Svg>,
  // longitudinal bar SIZE: the diameter symbol ⌀ (circle with a slash through it)
  barsize:  <Svg><circle cx={12} cy={12} r={6.5} /><path d="M5.5 18.5L18.5 5.5" /></Svg>,
  // tie SIZE: a hoop (rounded square) with its hook ticks
  tiesize:  <Svg><rect x={5} y={5} width={14} height={14} rx={3} /><path d="M13.5 5.2l3.2-2.4M11.2 5.2l3.2-2.4" /></Svg>,
  // tie SPACING: a vertical line either side of a horizontal dimension string
  // tie SPACING: the tie-SIZE hoop with a large "s" inside
  ties:     <Svg><rect x={5} y={5} width={14} height={14} rx={3} /><path d="M13.5 5.2l3.2-2.4M11.2 5.2l3.2-2.4" /><Glyph ch="s" size={10} y={15} /></Svg>,
  // compression: arrows pressing INWARD onto a face; tension: arrows pulling OUTWARD
  // compression: a down arrow over a line; tension: an up arrow over a line
  axialcomp: <Svg><path d="M12 4v9" /><path d="M8 9l4 4 4-4" /><path d="M5.5 18h13" /></Svg>,
  axialtens: <Svg><path d="M12 13V4" /><path d="M8 8l4-4 4 4" /><path d="M5.5 18h13" /></Svg>,
  moment:   <Svg><path d="M4 15a8 8 0 0 1 16 0" /><path d="M20 15l-1.6-3.4M20 15l-3.4-1.4" /></Svg>,
  // moment about the strong (M3) / weak (M2) axis — the moment arc with a subscript
  m3:       <Svg><path d="M3 16a7 7 0 0 1 14 0" /><path d="M17 16l-1.4-3M17 16l-3-1.2" /><Glyph ch="3" size={9} x={20} y={9} /></Svg>,
  m2:       <Svg><path d="M3 16a7 7 0 0 1 14 0" /><path d="M17 16l-1.4-3M17 16l-3-1.2" /><Glyph ch="2" size={9} x={20} y={9} /></Svg>,
  shear:    <Svg><path d="M4 9h11M12 6l3.5 3-3.5 3" /><path d="M20 15H9M12 18l-3.5-3 3.5-3" /></Svg>,
  shearv2:  <Svg><path d="M3 9h10M10 6l3 3-3 3" /><path d="M18 15H8M11 18l-3-3 3-3" /><Glyph ch="2" size={8} x={20} y={9} /></Svg>,
  shearv3:  <Svg><path d="M3 9h10M10 6l3 3-3 3" /><path d="M18 15H8M11 18l-3-3 3-3" /><Glyph ch="3" size={8} x={20} y={9} /></Svg>,
  torsion:  <Svg><path d="M18 6.5A8 8 0 1 0 20 12" /><path d="M20 5v4h-4" /></Svg>,
  detailing:<Svg><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M12 7.5l3 4.5-3 4.5-3-4.5z" /></Svg>,
  dcr:      <Svg><path d="M4 16.5a8 8 0 0 1 16 0" /><path d="M12 16.5l5-3.2" /><Dot cx={12} cy={16.5} r={1.4} /></Svg>,
  designdcr:<Svg><path d="M4 16.5a8 8 0 0 1 16 0" /><path d="M8.5 15l2.5 2.5 4.5-4.5" /></Svg>,
  vtdcr:    <Svg><path d="M4 16.5a8 8 0 0 1 16 0" /><path d="M7 15.5l4-3 3 2 3-3.5" /></Svg>,
  // Verified (.sco) DCRs: the same gauge, with the check (P-M-M) / zigzag (V+T)
  // marks used above, plus a small "s" for S-Concrete. The governing one keeps the
  // plain gauge + "S".
  sconcdcr: <Svg><path d="M4 16.5a8 8 0 0 1 16 0" /><path d="M8 15l2.4 2.4 4.3-4.3" /><Glyph ch="s" size={9} x={20.5} y={8.5} /></Svg>,
  sconcvt:  <Svg><path d="M4 16.5a8 8 0 0 1 16 0" /><path d="M7 15.5l3.6-2.8 2.8 1.9 2.6-3.1" /><Glyph ch="s" size={9} x={20.5} y={8.5} /></Svg>,
  sconcgov: <Svg><path d="M4 16.5a8 8 0 0 1 16 0" /><Glyph ch="S" size={10} y={14.5} /></Svg>,
  // DCR errors: a delta (estimate minus verified), marked with the same check /
  // zigzag so it reads as the error OF that check
  sconcerr: <Svg><Glyph ch="Δ" size={16} y={18} /><path d="M16.4 6.6l1.7 1.7 3.1-3.1" /></Svg>,
  sconcerrvt: <Svg><Glyph ch="Δ" size={16} y={18} /><path d="M16 7.6l1.9-1.5 1.5 1 1.9-1.7" /></Svg>,
  // Section type: a square and a circle side by side (different section shapes)
  secttype: <Svg><rect x={3} y={7} width={9} height={9} rx={1.3} /><circle cx={17} cy={11.5} r={4.5} /></Svg>,
  // Reinforcement ratio: ρ
  rho:      <Svg><Glyph ch="ρ" size={15} y={17} /></Svg>,
  // Type view: a 2×2 grid of cells — a collection grouped by kind
  type:     <Svg><rect x={3.5} y={3.5} width={7} height={7} rx={1.3} /><rect x={13.5} y={3.5} width={7} height={7} rx={1.3} /><rect x={3.5} y={13.5} width={7} height={7} rx={1.3} /><rect x={13.5} y={13.5} width={7} height={7} rx={1.3} /></Svg>,
  // TRIAL combined: a box split down the middle (like the rectangular b×h cell)
  barcombo: <Svg><rect x={4} y={4} width={16} height={16} rx={2} /><path d="M12 4v16" /><Glyph ch="n" size={7} x={6} y={15} /><Glyph ch="Ø" size={7} x={13.5} y={15} /></Svg>,
  tiecombo: <Svg><rect x={4} y={5} width={16} height={14} rx={3} /><path d="M12 5v14" /><Glyph ch="Ø" size={7} x={5.5} y={15} /><Glyph ch="s" size={7} x={14} y={15} /></Svg>,
};


// stroke-2 UI icons
const S2 = ({ size, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
export const IconLC = ({ size = 16 }) => <S2 size={size}><Glyph ch="LC" x={12} y={16} size={12} /></S2>;
export const IconGear = ({ size = 16 }) => <S2 size={size}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></S2>;
export const IconEye = ({ size = 16 }) => <S2 size={size}><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></S2>;
// running status log — lines with a clock
export const IconLog = ({ size = 16 }) => <S2 size={size}><path d="M4 6h10M4 12h7M4 18h5" /><circle cx="17.5" cy="16.5" r="4.5" /><path d="M17.5 14.6v2l1.4 1" /></S2>;
export const IconList = ({ size = 16 }) => <S2 size={size}><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></S2>;
export const IconInfo = ({ size = 16 }) => <S2 size={size}><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16.5" /><circle cx="12" cy="7.6" r="0.6" fill="currentColor" /></S2>;
export const IconFunnel = ({ size = 15 }) => <S2 size={size}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></S2>;
export const IconPlan = ({ size = 16 }) => <S2 size={size}><path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" /><path d="M9 3v15M15 6v15" /></S2>;
export const IconClose = ({ size = 14 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5 5 19" /></svg>;
// action / toolbar icons
export const IconFit = ({ size = 14 }) => <S2 size={size}><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" /></S2>;
export const IconGrid = ({ size = 14 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>;
export const IconSave = ({ size = 16 }) => <S2 size={size}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></S2>;
export const IconOpen = ({ size = 16 }) => <S2 size={size}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></S2>;
// File menu trigger — a document with a folded corner
export const IconFileMenu = ({ size = 16 }) => <S2 size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></S2>;
// New — document with a plus
export const IconNew = ({ size = 16 }) => <S2 size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="12" x2="12" y2="18" /><line x1="9" y1="15" x2="15" y2="15" /></S2>;
export const IconExcel = ({ size = 16 }) => <S2 size={size}><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></S2>;
export const IconInteraction = ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3v18h18" /><path d="M6 5c8 0 13 4 13 16" /></svg>;
// Axial demand-vs-capacity: an elevation axis with a demand line and a downward axial arrow
export const IconAxial = ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3v18h16" /><path d="M7 18l4-6 3 3 5-8" /><path d="M17 3v6M17 3l-2 2M17 3l2 2" /></svg>;
// Cross-section: outer section, inner tie hoop, corner bars
export const IconSection = ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1.5" /><rect x="6" y="6" width="12" height="12" rx="1.5" /><circle cx="7.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="16.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="7.5" cy="16.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="16.5" cy="16.5" r="1.1" fill="currentColor" stroke="none" /></svg>;
export const IconConnect = ({ size = 16 }) => <S2 size={size}><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" /></S2>;
export const IconPull = ({ size = 16 }) => <S2 size={size}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></S2>;
export const IconPush = ({ size = 16 }) => <S2 size={size}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></S2>;
export const IconBatch = ({ size = 16 }) => <S2 size={size}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></S2>;
// Return verified DCRs: a DCR gauge with an arrow coming back down into it
export const IconReturnDcr = ({ size = 16 }) => <S2 size={size}><path d="M3 17a9 9 0 0 1 18 0" /><path d="M12 3v8" /><path d="M8.5 7.5 12 11l3.5-3.5" /></S2>;
// Auto-size: the dimension (section) box with an A set in it
export const IconAutosize = ({ size = 16 }) => <Svg size={size} sw={1.7}><rect x={3} y={3} width={18} height={18} rx={2} /><Glyph ch="A" size={12} y={16.5} /></Svg>;
// Auto-detail: two longitudinal bars flanking an A
export const IconDesign = ({ size = 16 }) => <Svg size={size} sw={1.9}><line x1={6.5} y1={3.5} x2={6.5} y2={20.5} /><line x1={17.5} y1={3.5} x2={17.5} y2={20.5} /><Glyph ch="A" size={11} y={15.8} /></Svg>;
// Revert to ETABS sections: a section box with an E in it (matches the A box)
export const IconReset = ({ size = 16 }) => <Svg size={size} sw={1.7}><rect x={3} y={3} width={18} height={18} rx={2} /><Glyph ch="E" size={12} y={16.5} /></Svg>;
export const IconValues = ({ size = 16 }) => <S2 size={size}><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" /></S2>;
// spinning progress icon — replaces a button's icon while a run is in flight
export const IconSpinner = ({ size = 16 }) => <svg className="sdash-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>;
// auto-group — the standard "group objects" glyph: corner brackets drawn
// around two cells, i.e. gather these into one group
export const IconGroup = ({ size = 16 }) => <S2 size={size}><path d="M4 8V5a1 1 0 0 1 1-1h3" /><path d="M16 4h3a1 1 0 0 1 1 1v3" /><path d="M20 16v3a1 1 0 0 1-1 1h-3" /><path d="M8 20H5a1 1 0 0 1-1-1v-3" /><rect x="7.5" y="7.5" width="4" height="4" rx="0.6" /><rect x="12.5" y="12.5" width="4" height="4" rx="0.6" /></S2>;
// stacking settings — a bar chart
export const IconStack = ({ size = 16 }) => <S2 size={size}><rect x="3.5" y="12" width="4" height="9" rx="1" /><rect x="10" y="6" width="4" height="15" rx="1" /><rect x="16.5" y="9" width="4" height="12" rx="1" /></S2>;
// transpose — swap rows/columns (↔ over ↕)
export const IconTranspose = ({ size = 16 }) => <S2 size={size}><path d="M3 8h13M13 5l3 3-3 3" /><path d="M21 16H8M11 13l-3 3 3 3" /></S2>;
// quantities — a pie chart
export const IconPie = ({ size = 16 }) => <S2 size={size}><path d="M12 3a9 9 0 1 0 9 9h-9z" /><path d="M12 3v9l6.4-6.4A9 9 0 0 0 12 3z" /></S2>;
// Autostack — an "A" in front of the stacking bar chart
export const IconAutostack = ({ size = 16 }) => <S2 size={size}><text x="0.5" y="20" fontSize="12" fontWeight="700" stroke="none" fill="currentColor">A</text><rect x="9" y="12" width="3.2" height="9" rx="1" /><rect x="14" y="6" width="3.2" height="15" rx="1" /><rect x="19" y="9" width="3.2" height="12" rx="1" /></S2>;
// small down-chevron badge marking a button that opens a panel
export const IconChevronDown = ({ size = 9 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>;
// arrowhead-only chevrons (like ^) — used for the cell-size d-pad
export const IconChevronUp    = ({ size = 12 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>;
export const IconChevronLeft  = ({ size = 12 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>;
export const IconChevronRight = ({ size = 12 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>;
// panel param icons that don't map to a mode icon
export const IconHeight = ({ size = 16 }) => <S2 size={size}><path d="M12 3v18" /><path d="M8 6l4-3 4 3M8 18l4 3 4-3" /></S2>;
export const IconLayers = ({ size = 16 }) => <S2 size={size}><path d="M12 3 3 8l9 5 9-5-9-5z" /><path d="M3 13l9 5 9-5" /></S2>;
export const IconOff = ({ size = 16 }) => <S2 size={size}><circle cx="12" cy="12" r="9" /><line x1="6" y1="6" x2="18" y2="18" /></S2>;
export const IconRefresh = ({ size = 15 }) => <S2 size={size}><path d="M3 3v6h6" /><path d="M3.5 9a9 9 0 1 1-1 5" /></S2>;
export const IconGridAll = ({ size = 16 }) => <S2 size={size}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></S2>;
// directional arrows for name/tick placement
export const IconArrowUp = ({ size = 16 }) => <S2 size={size}><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></S2>;
export const IconArrowDown = ({ size = 16 }) => <S2 size={size}><path d="M12 5v14" /><path d="M6 13l6 6 6-6" /></S2>;
export const IconArrowUpDown = ({ size = 16 }) => <S2 size={size}><path d="M12 4v16" /><path d="M7 8l5-4 5 4" /><path d="M7 16l5 4 5-4" /></S2>;
export const IconArrowLeft = ({ size = 16 }) => <S2 size={size}><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></S2>;
export const IconArrowRight = ({ size = 16 }) => <S2 size={size}><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></S2>;
export const IconArrowLeftRight = ({ size = 16 }) => <S2 size={size}><path d="M4 12h16" /><path d="M8 7l-4 5 4 5" /><path d="M16 7l4 5-4 5" /></S2>;
// width / depth: a section box with a horizontal / vertical dimension line
export const IconWidth = ({ size = 16 }) => <Svg size={size} sw={1.6}><rect x={3} y={6} width={18} height={12} rx={1.5} /><path d="M6 12h12M8 10l-2 2 2 2M16 10l2 2-2 2" /></Svg>;
export const IconDepth = ({ size = 16 }) => <Svg size={size} sw={1.6}><rect x={6} y={3} width={12} height={18} rx={1.5} /><path d="M12 6v12M10 8l2-2 2 2M10 16l2 2 2-2" /></Svg>;
export const IconDiameter = ({ size = 16 }) => <Svg size={size} sw={1.6}><circle cx={12} cy={12} r={8} /><path d="M6.5 12h11M8.5 10l-2 2 2 2M15.5 10l2 2-2 2" /></Svg>;
// nested squares — clear cover
export const IconCover = ({ size = 16 }) => <Svg size={size} sw={1.6}><rect x={3} y={3} width={18} height={18} rx={2} /><rect x={7} y={7} width={10} height={10} rx={1.5} /></Svg>;
// run / execute (play)
export const IconRun = ({ size = 15 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4.5v15a1 1 0 0 0 1.5.87l12-7.5a1 1 0 0 0 0-1.74l-12-7.5A1 1 0 0 0 7 4.5z" /></svg>;
// reinforcement ratio ρ, and target-DCR gauge, for the setting sliders
export const IconRho = ({ size = 16 }) => <Svg size={size} sw={1.7}><Glyph ch="ρ" size={15} y={17} /></Svg>;
// aspect ratio (a wide rectangle) and dimension increment (stepped)
export const IconAspect = ({ size = 16 }) => <Svg size={size} sw={1.7}><rect x={3} y={7} width={18} height={10} rx={1.5} /><path d="M12 7v10" /></Svg>;
export const IconIncrement = ({ size = 16 }) => <S2 size={size}><path d="M4 20h4v-4h4v-4h4V8h4" /></S2>;
// step-down: a descending stack of blocks (bigger at the base)
export const IconStepDown = ({ size = 16 }) => <S2 size={size}><rect x="3" y="14" width="18" height="6" rx="1" /><rect x="6" y="8" width="12" height="6" rx="1" /><rect x="9" y="3" width="6" height="5" rx="1" /></S2>;
// angle — for the incline-tolerance setting
export const IconAngle = ({ size = 16 }) => <S2 size={size}><path d="M4 20h16" /><path d="M4 20L18 6" /><path d="M4 20V9" /><path d="M9 20a5 5 0 0 0-5-5" /></S2>;
// horizontal distance — for the proximity setting
export const IconDistance = ({ size = 16 }) => <S2 size={size}><path d="M5 4v16" /><path d="M19 4v16" /><path d="M5 12h14" /><path d="M8 9l-3 3 3 3" /><path d="M16 9l3 3-3 3" /></S2>;

// ── canvas stat chips (bottom-left info strip) ──────────────────────────────
// a chain link — stacks formed by joint connectivity
export const IconLink = ({ size = 16 }) => <S2 size={size}><path d="M9.5 14.5a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1" /><path d="M14.5 9.5a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1" /></S2>;
// a branching stack — one column carried on by more than one above
export const IconBranch = ({ size = 16 }) => <S2 size={size}><path d="M12 21V11" /><path d="M12 11 7 6" /><path d="M12 11l5-5" /><circle cx="12" cy="21" r="1.6" /><circle cx="6.5" cy="5" r="1.6" /><circle cx="17.5" cy="5" r="1.6" /></S2>;
// mismatch — the stack members disagree
export const IconMismatch = ({ size = 16 }) => <S2 size={size}><path d="M12 4 2.5 20h19L12 4z" /><path d="M12 10v4" /><path d="M12 17.2v.1" /></S2>;
// marquee — the current selection
export const IconSelection = ({ size = 16 }) => <S2 size={size}><rect x="3.5" y="3.5" width="17" height="17" rx="2" strokeDasharray="3 2.4" /></S2>;

