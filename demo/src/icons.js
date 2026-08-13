// The icon set. Same drawing rules as the Template's: a 24×24 box, no fill, currentColor
// stroke at 1.7, round caps and joins — so an icon inherits its colour from the button it
// sits in and never needs a variant per state.
const S = ({ size = 17, sw = 1.7, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)

// ── panel identities (toolbar + panel headers) ──────────────────────────────────
/** Section — a beam cross-section: the outline with bars in it. */
export const IconSection = ({ size = 17 }) => (
  <S size={size}>
    <rect x="4" y="3" width="16" height="18" rx="1.5" />
    <circle cx="8" cy="7" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="7" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="17" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="17" r="1.2" fill="currentColor" stroke="none" />
  </S>
)

/** Calc sheet — ruled lines with a rule under the last, like a worked derivation. */
export const IconCalc = ({ size = 17 }) => (
  <S size={size}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h4" />
  </S>
)

/** Loads — a table: header band plus rows. */
export const IconTable = ({ size = 17 }) => (
  <S size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M9 9v11M15 9v11" />
  </S>
)

/** Force diagram — a moment parabola over a baseline. */
export const IconDiagram = ({ size = 17 }) => (
  <S size={size}>
    <path d="M3 6v13a1 1 0 0 0 1 1h17" />
    <path d="M6 17c3-9 9-9 12 0" />
  </S>
)

/** Elevation — a beam in side view, with its links. */
export const IconElevation = ({ size = 17 }) => (
  <S size={size}>
    <rect x="2" y="8" width="20" height="8" rx="1" />
    <path d="M6 8v8M10 8v8M14 8v8M18 8v8" strokeWidth="1.1" />
  </S>
)

/** Editor — the input side: fields and a stepper. */
export const IconEditor = ({ size = 17 }) => (
  <S size={size}>
    <path d="M4 7h16M4 12h10M4 17h13" />
    <path d="M17.5 10.5v3M16 12h3" strokeWidth="1.4" />
  </S>
)

/** Group Dashboard — cards. */
export const IconDashboard = ({ size = 17 }) => (
  <S size={size}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" />
  </S>
)

/** Plan — a framing grid seen from above. */
export const IconPlan = ({ size = 17 }) => (
  <S size={size}>
    <rect x="3" y="3" width="18" height="18" rx="1.5" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" strokeWidth="1.15" />
  </S>
)

/** Groups — a lasso (dashed) around a set of members, which is how one is made. */
export const IconGroups = ({ size = 17 }) => (
  <S size={size}>
    <rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3.4 2.6" />
    <circle cx="9" cy="9" r="2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="9" r="2" fill="currentColor" stroke="none" />
    <circle cx="9" cy="15" r="2" fill="currentColor" stroke="none" />
  </S>
)

/** S-Concrete Verify — a check inside a section outline: the cage, independently signed
 *  off. The app's own "verify" icon is a shield; here it has to read at 16px beside eight
 *  other outlines, and a shield at that size is a blob, so the meaning is carried by the
 *  tick and the frame says which object was checked. */
export const IconVerify = ({ size = 17 }) => (
  <S size={size}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="M7.5 12.4l3.1 3.1L16.8 9.3" strokeWidth="2" />
  </S>
)

// ── panel-header affordances ────────────────────────────────────────────────────
/** Detach — an arrow leaving its box. */
export const IconDetach = ({ size = 14 }) => (
  <S size={size}><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></S>
)

/** Attach — the same arrow, coming home. */
export const IconAttach = ({ size = 14 }) => (
  <S size={size}><path d="M20 4l-8 8M13 12H8V7M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></S>
)

/** Float — lift the panel out of the grid into a draggable window. */
export const IconFloat = ({ size = 14 }) => (
  <S size={size}><rect x="3" y="5" width="12" height="10" rx="1.6" /><rect x="9" y="9" width="12" height="10" rx="1.6" /></S>
)

/** Dock — drop it back into the tiled grid. */
export const IconDock = ({ size = 14 }) => (
  <S size={size}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M12 10v10" /></S>
)

/** Maximise — corners pushing out. */
export const IconMax = ({ size = 14 }) => (
  <S size={size}><path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4" /></S>
)

/** Restore — corners pulling in. */
export const IconMin = ({ size = 14 }) => (
  <S size={size}><path d="M4 9h4a1 1 0 0 0 1-1V4M20 9h-4a1 1 0 0 1-1-1V4M4 15h4a1 1 0 0 1 1 1v4M20 15h-4a1 1 0 0 0-1 1v4" /></S>
)

/** Chevron — the rail's open/close affordance. Takes a style so it can be flipped. */
export const IconChevronRight = ({ size = 14, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <path d="M9 5l7 7-7 7" />
  </svg>
)

/** Pin, open. */
export const IconPin = ({ size = 14 }) => (
  <S size={size}><path d="M15 3l6 6-3.5 1.5L14 20l-4-4-6 4 4-6-4-4 9.5-3.5z" /></S>
)

/** Pin, pushed in — filled, because a pinned rail is a committed state. */
export const IconPinned = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
       strokeWidth="1.4" strokeLinejoin="round">
    <path d="M15 3l6 6-3.5 1.5L14 20l-4-4-6 4 4-6-4-4 9.5-3.5z" />
  </svg>
)

export const IconClose = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5 5 19" /></svg>
)

// ── toolbar ─────────────────────────────────────────────────────────────────────
/** Units — a ruler. */
export const IconUnits = ({ size = 17 }) => (
  <S size={size}><rect x="2" y="8" width="20" height="8" rx="1.5" /><path d="M7 8v3M12 8v4M17 8v3" /></S>
)

/** Type — the font toggle. */
export const IconType = ({ size = 17 }) => (
  <S size={size}><path d="M5 7V5h14v2M12 5v14M9 19h6" /></S>
)

/** Governing row — a target/crosshair. */
export const IconGoverning = ({ size = 17 }) => (
  <S size={size}><circle cx="12" cy="12" r="7" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" /></S>
)

/** Warnings. */
export const IconWarn = ({ size = 17 }) => (
  <S size={size}><path d="M10.3 4.3 2.6 17.5A1.5 1.5 0 0 0 3.9 20h16.2a1.5 1.5 0 0 0 1.3-2.5L13.7 4.3a1.5 1.5 0 0 0-2.6 0z" />
    <path d="M12 10v4M12 17.2v.1" /></S>
)

/** Reset. */
export const IconReset = ({ size = 17 }) => (
  <S size={size}><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v5h-5" /></S>
)
