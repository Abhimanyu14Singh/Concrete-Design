/**
 * MapCanvas — generalized plan-view SVG canvas for model frames.
 * Supports coloring by DCR, group, or section; lasso multi-select; zoom/pan;
 * V/M diagram overlays; and a rich hover tooltip showing DCR split + rebar.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import type { MapFrame, DesignGroup, AutoGroupBin } from '../../types';
import { dcrToColor } from '../EtabsImport/dcrColors';
import { rampStops } from './colorRamp';
import { frameColorFor, buildGroupColorMap, buildAutoGroupColorMap, buildGroupIndexMap, type ColorMode } from './frameColor';
import {
  fitTransform, zoomViewBox, clampPitch, boundingSphere, stableProjection,
  screenBounds, viewBoxForBounds, normalizeWheelDelta, wheelZoomFactor,
  dampCamera, VIEW_PRESETS, DEFAULT_CAMERA, type Camera, type ViewPreset,
} from '../../utils/mapViewport';
import { ACCENT, BORDER, DEFAULT_DCR_THRESHOLDS, INK, MAP_DCR_BANDS, MAP_DCR_COLORS, MAP_GRAY, MONO_NUM, STATUS, TRACK, type DcrBand } from '../../theme';

export type { ColorMode };
export type DiagramMode = 'off' | 'moment' | 'shear';

/** Rich per-member info shown in the tooltip. */
export interface FrameInfo {
  dcr: number;
  dcrFlex: number;
  dcrShear: number;
  /** Worst per-mode DCR across ALL load rows (M⁺ / M⁻ / V / crack) — not a single
   *  representative row, so the dashboard chips never understate a mode that
   *  governs on a different station than the overall-governing row. */
  modeDcr?: { flexPos: number; flexNeg: number; shear: number; torsion?: number; wk: number };
  top: string;
  bot: string;
  stirrups: string;
  /** Steel weight intensity, e.g. "23.4 lb/ft (L 16.1 + S 7.3)". */
  weight?: string;
  error?: string;
  warnings?: { code: string; message: string; severity: 'error' | 'warning' }[];
  status?: 'OK' | 'NG' | 'Warning';
}

const DIAGRAM_MAX_PX = 18; // max perpendicular offset for diagram in SVG user-space pixels
// How far along the beam (0 = mark node, 0.5 = midpoint) to park the group tag when
// a mark end is known. 0.22 keeps it clearly biased toward that end without sitting
// on the beam-column joint, where tags from several beams would collide.
const MARK_TAG_FRAC = 0.22;

/** Shared look for the small navigation buttons floating over the canvas. */
const navBtn: React.CSSProperties = {
  background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 6,
  padding: '4px 8px', fontSize: 11, cursor: 'pointer', color: INK.base, lineHeight: 1.2,
};

interface Props {
  frames: MapFrame[];
  dcrById?: Record<string, number>;
  infoById?: Record<string, FrameInfo>;
  designGroups?: DesignGroup[];
  story?: string;
  colorMode?: ColorMode;
  selected: Set<string>;
  onSelectionChange: (names: Set<string>) => void;
  onDoubleClick?: (memberId: string) => void;
  /** When provided and returns true, default selection change is suppressed. */
  onFrameClick?: (frameName: string) => boolean;
  /** Called on single click in inspect mode; provides screen coords. */
  onBeamInspect?: (memberId: string, clientX: number, clientY: number) => void;
  /** Called on right-click on a designed frame. */
  onBeamContextMenu?: (memberId: string, frameName: string, clientX: number, clientY: number) => void;
  width?: number;
  height?: number;
  diagramMode?: DiagramMode;
  diagramDataById?: Record<string, { x: number; v: number }[]>;
  /** memberId → its "mark" end (higher-hogging support). In 'groupTags' mode the
   *  group tag is drawn near that end of the line instead of at the midpoint.
   *  'start' = the pt1/I-node end, 'end' = the pt2/J-node end. Members absent from
   *  this map keep the midpoint tag. */
  markEndById?: Record<string, 'start' | 'end'>;
  /** For 'flexSteel' / 'stirrups' modes: metric value by memberId. */
  metricById?: Record<string, number>;
  metricRange?: { min: number; max: number };
  metricLabel?: string;
  /** Persisted S-Concrete pass/fail per member (for 'sconcrete' color mode). */
  scoStatusById?: Record<string, 'OK' | 'NG'>;
  /** Worst S-Concrete utilisation per member — max(N-M, V&T) — for the 'sconcreteDcr'
   *  colour mode. Absent from the map means "not run", which is drawn grey rather than
   *  green: no result is a different statement from a passing one. */
  scoDcrById?: Record<string, number>;
  /** Auto-group overlay bins for 'autoGroup' color mode. */
  autoGroupOverlay?: AutoGroupBin[];
  /** Member ids to hide from the canvas. */
  hiddenMemberIds?: Set<string>;
  /** Stories to hide from the canvas. */
  hiddenStories?: Set<string>;
  /** Whether click-to-inspect is active. */
  inspectMode?: boolean;
  /** Member currently shown in the rich inspect card (tooltip suppressed for it). */
  inspectedMemberId?: string | null;
  /** When true, draw red halos under flagged members. */
  showErrors?: boolean;
  /** Member ids flagged as having errors. */
  errorMemberIds?: Set<string>;
  /** Frames of the active design group — highlighted; all others halftone. Empty = no focus. */
  focusFrames?: Set<string>;
  /** 0 = uniform line weight (today's look); >0 scales stroke by member width. */
  lineWeightScale?: number;
  /** memberId → section width (in), for proportional line weight. */
  widthById?: Record<string, number>;
  /** memberId → categorical color for the 'concGrade' / 'steelGrade' modes. */
  gradeColorMap?: Map<string, string>;
  /** The (user-edited) DCR colour bands driving fills + legend. Defaults to MAP_DCR_BANDS. */
  dcrBands?: readonly DcrBand[];
  /** The 3 editable DCR cut-points behind `dcrBands` (for the legend's slider). */
  dcrThresholds?: [number, number, number];
  /** Persist a new set of cut-points from the editable legend. */
  onDcrThresholdsChange?: (t: [number, number, number]) => void;
  /** The 4 editable band COLOURS behind `dcrBands` (for the legend's swatches). */
  dcrColors?: readonly string[];
  /** Persist a new set of band colours from the editable legend. */
  onDcrColorsChange?: (c: string[]) => void;
  /** Optional imported geometry layers (walls / grids / openings), drawn behind
   *  the frames. Each is opt-in via the matching show* flag. */
  walls?: { id: string; story: string; points: { x: number; y: number; z?: number }[]; kind?: 'wall' | 'slab'; memberId?: string }[];
  grids?: { id: string; label: string; p1: { x: number; y: number; z?: number }; p2: { x: number; y: number; z?: number }; story?: string }[];
  openings?: { id: string; story: string; points: { x: number; y: number; z?: number }[]; memberId?: string }[];
  /** Vertical frames (columns / braces) drawn as CONTEXT only — never selectable,
   *  never designed. In plan they collapse to a point, so they only draw in 3D. */
  columns?: { id: string; story: string; sectionName?: string; pt1: { x: number; y: number; z: number }; pt2: { x: number; y: number; z: number } }[];
  showWalls?: boolean;
  showGrids?: boolean;
  showOpenings?: boolean;
  showColumns?: boolean;
  /** Draw the model axonometrically instead of in plan. Everything else — picking,
   *  lasso, diagrams, colouring, inspect — works exactly as it does in 2D. */
  view3d?: boolean;
}

export default function MapCanvas({
  frames, dcrById = {}, infoById = {}, designGroups = [], story = 'All',
  colorMode = 'dcr', selected, onSelectionChange, onDoubleClick, onFrameClick,
  onBeamInspect, onBeamContextMenu,
  width = 640, height = 480,
  diagramMode = 'off', diagramDataById = {}, markEndById = {},
  metricById = {}, metricRange, metricLabel, scoStatusById = {}, scoDcrById = {},
  autoGroupOverlay = [], hiddenMemberIds = new Set(), hiddenStories = new Set(),
  inspectMode = false, inspectedMemberId = null,
  showErrors = false, errorMemberIds = new Set(),
  focusFrames, lineWeightScale = 0, widthById = {}, gradeColorMap,
  dcrBands = MAP_DCR_BANDS, dcrThresholds, onDcrThresholdsChange, dcrColors, onDcrColorsChange,
  walls = [], grids = [], openings = [], columns = [],
  showWalls = false, showGrids = false, showOpenings = false, showColumns = false,
  view3d = false,
}: Props) {
  const [hover, setHover] = useState<string | null>(null);
  // Pinned member — the last single-clicked frame. Its summary card stays up
  // (survives hover-out) until another beam is clicked or the plan is cleared.
  const [pinned, setPinned] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: width, h: height });
  // 3D camera. `cam` is what renders; `camTarget` is where the drag has put it.
  // A rAF loop eases one toward the other (see the damping effect below), which
  // is what turns a stream of raw mouse deltas into a smooth orbit.
  const [cam, setCam] = useState<Camera>(DEFAULT_CAMERA);
  const [camTarget, setCamTarget] = useState<Camera>(DEFAULT_CAMERA);
  const orbitStart = useRef<{ mx: number; my: number; yaw: number; pitch: number } | null>(null);
  const [isOrbiting, setIsOrbiting] = useState(false);
  const [lasso, setLasso] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const lassoBgOnly = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  /** Space-bar held → temporary pan tool, the Figma/Photoshop convention. */
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** Set on a right-drag so the context menu is suppressed for that gesture only. */
  const rightDragged = useRef(false);
  const [showHelp, setShowHelp] = useState(false);

  const visibleFrames = frames.filter(f =>
    (story === 'All' || f.story === story) &&
    !hiddenStories.has(f.story) &&
    !(f.memberId && hiddenMemberIds.has(f.memberId))
  );
  // Layers reuse the same story/hidden predicate as frames; grid axes are model-
  // global (story-agnostic).
  const visibleWalls = walls.filter(w =>
    (story === 'All' || w.story === story) && !hiddenStories.has(w.story) &&
    !(w.memberId && hiddenMemberIds.has(w.memberId)));
  const visibleOpenings = openings.filter(o =>
    (story === 'All' || o.story === story) && !hiddenStories.has(o.story) &&
    !(o.memberId && hiddenMemberIds.has(o.memberId)));
  const visibleGrids = grids;
  const visibleColumns = columns.filter(c =>
    (story === 'All' || c.story === story) && !hiddenStories.has(c.story));

  // Compute bounds — include visible layer geometry so they register to the same
  // plan and drive fit-to-view (frame-only bounds would clip walls/grids).
  const pts = [
    ...visibleFrames.flatMap(f => [f.pt1, f.pt2]),
    ...(showWalls ? visibleWalls.flatMap(w => w.points) : []),
    ...(showOpenings ? visibleOpenings.flatMap(o => o.points) : []),
    ...(showGrids ? visibleGrids.flatMap(g => [g.p1, g.p2]) : []),
    ...(showColumns ? visibleColumns.flatMap(c => [c.pt1, c.pt2]) : []),
  ];
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 1;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxY = ys.length ? Math.max(...ys) : 1;

  // Fit the plan into the canvas, centered on both axes (see fitTransform).
  const { tx, ty } = fitTransform({ minX, maxX, minY, maxY }, width, height);

  // ── One projection for both views ───────────────────────────────────────────
  // Everything downstream (frames, layers, diagrams, tags, lasso hit-testing)
  // goes through P(), so switching to 3D changes only where a point lands — not
  // how anything behaves. In plan, z is ignored and P is exactly the old tx/ty.
  const zOf = (p: { z?: number }): number => p.z ?? 0;

  /**
   * The 3D fit is built from the model's bounding SPHERE and is therefore
   * CAMERA-INDEPENDENT: it does not appear in the dependency list below, and
   * orbiting cannot change it.
   *
   * This is the fix for the jarring feel. The old code refitted the projected
   * bounding BOX on every render, so each mouse-move during an orbit produced a
   * new scale and a new centre — the model pumped in and out and slid around
   * under the cursor while you dragged. Framing a sphere removes the coupling
   * entirely: an orthographic projection of a sphere is the same circle at every
   * angle, so rotation now only reorients.
   */
  // Computed straight through rather than memoized: it is one O(n) pass over the
  // same points the bounds above already walk, and any cache key cheap enough to
  // be worth it would have to be recomputed from those points anyway.
  const sphere3 = view3d ? boundingSphere(pts.map(p => ({ x: p.x, y: p.y, z: zOf(p) }))) : null;
  const proj3 = sphere3 ? stableProjection(sphere3, width, height) : null;
  /** Model point → SVG coordinates, for whichever view is active. */
  const P = (p: { x: number; y: number; z?: number }): [number, number] => {
    if (!proj3) return [tx(p.x), ty(p.y)];
    const { sx, sy } = proj3({ x: p.x, y: p.y, z: zOf(p) }, cam);
    return [sx, sy];
  };

  // Bounds of the structure alone (frames), used to park grid-line labels a clear
  // distance OUTSIDE the members so the bubbles don't clutter the plan itself.
  const fpts = visibleFrames.flatMap(f => [f.pt1, f.pt2]);
  const fMinX = fpts.length ? Math.min(...fpts.map(p => p.x)) : minX;
  const fMaxX = fpts.length ? Math.max(...fpts.map(p => p.x)) : maxX;
  const fMinY = fpts.length ? Math.min(...fpts.map(p => p.y)) : minY;
  const fMaxY = fpts.length ? Math.max(...fpts.map(p => p.y)) : maxY;

  /**
   * Frame everything on screen.
   *
   * In plan the fit transform already sizes the model to the canvas, so the fit
   * IS the untransformed viewBox. In 3D the projection deliberately frames the
   * bounding SPHERE — loose, but rotation-proof — so fitting means reframing the
   * viewBox onto what the current camera actually projects. Doing it here rather
   * than inside the projection is the whole trick: the tight framing happens when
   * asked for, and never mid-drag.
   */
  const fitView = useCallback(() => {
    if (!proj3) { setViewBox({ x: 0, y: 0, w: width, h: height }); return; }
    const b = screenBounds(pts.map(p => proj3({ x: p.x, y: p.y, z: zOf(p) }, cam)));
    setViewBox(b ? viewBoxForBounds(b, width, height) : { x: 0, y: 0, w: width, h: height });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj3, cam, width, height, pts.length]);

  // Re-frame when the MODEL, the CANVAS or the VIEW MODE changes — and only then.
  //
  // `cam` and `fitView` are deliberately absent from the dependency list. In 3D
  // the tight framing has to be computed from the camera, but re-running it
  // whenever the camera moves is precisely the behaviour being removed here: it
  // would rescale the model on every frame of an orbit. Fitting is an action, not
  // a continuous reaction, so this closes over whatever camera is current at the
  // moment the model or the mode changed.
  useEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, width, height, view3d]);

  // Shared coloring: group / auto-group lookups + the per-frame color for the mode.
  const groupColorMap = buildGroupColorMap(designGroups);
  const autoGroupColorMap = buildAutoGroupColorMap(autoGroupOverlay);
  const groupIndexMap = buildGroupIndexMap(designGroups);
  const frameColor = (f: MapFrame): string =>
    frameColorFor(f, { colorMode, dcrById, groupColorMap, autoGroupColorMap, metricById, metricRange, gradeColorMap, scoStatusById, scoDcrById, dcrBands });

  // Proportional line weight (feature ④): scale a beam's stroke by its width. At
  // lineWeightScale 0 this collapses to the constant 3px (today's look); higher
  // values spread strokes across ~2–10px in proportion to width, so wider beams
  // read as heavier lines. Halos add a fixed offset so they track the line.
  const wVals = Object.values(widthById);
  const minW = wVals.length ? Math.min(...wVals) : 0;
  const maxW = wVals.length ? Math.max(...wVals) : 1;
  const strokeFor = (memberId: string | undefined, hov: boolean): number => {
    const base = 3;
    const w = memberId ? widthById[memberId] : undefined;
    let px = base;
    if (lineWeightScale > 0 && w !== undefined && maxW > minW) {
      const t = (w - minW) / (maxW - minW);              // 0..1 across the width range
      px = base + lineWeightScale * (2 + t * 6 - base);  // blend base → 2..8px band
    }
    return px + (hov ? 2 : 0);
  };

  const mouseToSvg = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return {
      x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.w,
      y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.h,
    };
  }, [viewBox]);

  // Wheel zoom — native non-passive. Two guards keep heavy scrolling from taking
  // the renderer down: (1) the zoom is CLAMPED to a sane range — without a floor,
  // scrolling in far enough shrinks the viewBox toward zero, which blows every
  // stroke up to tens of thousands of screen px and exhausts GPU/RAM (a hard crash
  // on large models); (2) rapid wheel ticks are COALESCED to one state update per
  // animation frame, so the plan stays smooth instead of thrashing React.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Relative to the fit width (viewBox.w === width at fit): allow up to ~50× zoom
    // in and ~10× zoom out. Generous for detailing, nowhere near the blow-up regime.
    const MIN_W = width / 50;
    const MAX_W = width * 10;
    let raf = 0;
    let pending: { clientX: number; clientY: number; factor: number } | null = null;
    const apply = () => {
      raf = 0;
      const job = pending; pending = null;
      if (!job) return;
      const pt = mouseToSvg(job.clientX, job.clientY);
      if (!pt) return;
      setViewBox(vb => zoomViewBox(vb, job.factor, pt.x, pt.y, MIN_W, MAX_W));
    };
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      // Proportional to how far the wheel/trackpad actually moved, and
      // exponential so the feel is scale-invariant and out-then-back-in returns
      // to where it started. A browser reports a trackpad PINCH as a wheel event
      // with ctrlKey set — the same zoom, just a finer delta, so it needs no
      // special case beyond not being swallowed by a modifier check.
      const factor = wheelZoomFactor(normalizeWheelDelta(e.deltaY, e.deltaMode));
      // Accumulate ticks that arrive within the same frame; anchor on the latest.
      pending = { clientX: e.clientX, clientY: e.clientY, factor: (pending?.factor ?? 1) * factor };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => { svg.removeEventListener('wheel', handler); if (raf) cancelAnimationFrame(raf); };
  }, [mouseToSvg, width]);

  // ── Camera damping ─────────────────────────────────────────────────────────
  // A pointer-move fires far more often than the screen refreshes, and each one
  // used to setCam() and re-render every element on the canvas. Now moves only
  // update a target ref; this loop eases the rendered camera toward it once per
  // frame and stops as soon as it arrives. That does two jobs at once: it caps
  // React to one re-render per frame, and it smooths the raw pointer deltas so
  // the orbit glides instead of stepping.
  // Runs a fixed burst of frames after every target change rather than testing
  // for convergence: dampCamera snaps to the target once inside its epsilon, and
  // returns that same object, so the tail frames hand React an identical value
  // and it bails out of re-rendering. A drag simply restarts the burst.
  useEffect(() => {
    let raf = 0, frames = 0;
    const step = () => {
      setCam(prev => dampCamera(prev, camTarget, 0.32));
      if (++frames < 30) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [camTarget]);

  /** Point the camera at a named standard view (keyboard 1–4, or the buttons). */
  const setPreset = useCallback((v: ViewPreset) => setCamTarget({ ...VIEW_PRESETS[v] }), []);

  // ── Pointer input ──────────────────────────────────────────────────────────
  // Bindings follow what CAD/BIM and web 3D viewers have converged on:
  //   left-drag           orbit (3D) / box-select (2D)
  //   middle-drag         pan            — universal
  //   right-drag          pan            — for laptops with no middle button
  //   space + left-drag   pan            — Figma/Photoshop hand tool
  //   alt + left-drag     pan            — kept from the previous binding
  //   shift + left-drag   box-select in 3D, so selection survives the orbit default
  //   wheel / pinch       zoom to cursor
  function beginPan(e: React.PointerEvent) {
    setIsPanning(true);
    panStart.current = { mx: e.clientX, my: e.clientY, vx: viewBox.x, vy: viewBox.y };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button === 2) { rightDragged.current = false; beginPan(e); return; }
    if (e.button === 1 || (e.button === 0 && (e.altKey || spaceHeld))) { beginPan(e); return; }
    if (e.button !== 0) return;

    const pt = mouseToSvg(e.clientX, e.clientY);
    if (!pt) return;
    const tag = (e.target as Element).tagName.toLowerCase();
    const onBackground = tag === 'svg' || tag === 'rect' || tag === 'pattern';
    // In 3D a bare background drag orbits — the gesture people expect from a 3D
    // view. Shift keeps the 2D behaviour (box-select), so nothing is lost;
    // dragging a member still selects it, because that isn't background.
    if (view3d && onBackground && !e.shiftKey) {
      orbitStart.current = { mx: e.clientX, my: e.clientY, yaw: camTarget.yaw, pitch: camTarget.pitch };
      setIsOrbiting(true);
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    lassoBgOnly.current = onBackground;
    setLasso({ sx: pt.x, sy: pt.y, ex: pt.x, ey: pt.y });
  }

  // Pan is rAF-coalesced for the same reason the camera is: one viewBox commit
  // per frame instead of one per pointer event.
  const panRaf = useRef(0);
  const panPending = useRef<{ dx: number; dy: number } | null>(null);

  function onPointerMove(e: React.PointerEvent) {
    const os = orbitStart.current;
    if (os) {
      // Sensitivity is expressed as a fraction of the canvas, so a drag across
      // the view turns the model by the same amount whatever the panel size —
      // the old fixed px constants made a docked panel feel twitchy and a
      // maximised one sluggish.
      const rect = svgRef.current?.getBoundingClientRect();
      const w = rect?.width || width, h = rect?.height || height;
      let dx = (e.clientX - os.mx) / w, dy = (e.clientY - os.my) / h;
      // Shift constrains to the dominant axis — the standard way to get a clean
      // turntable spin or a pure tilt.
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      setCamTarget({
        yaw: os.yaw + dx * 2 * Math.PI,          // one full turn per canvas width
        pitch: clampPitch(os.pitch + dy * Math.PI), // half a turn per canvas height
      });
      return;
    }
    const ps = panStart.current;
    if (isPanning && ps) {
      if (e.pointerType === 'mouse' && e.buttons & 2) rightDragged.current = true;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || !rect.width) return;
      panPending.current = {
        dx: ((e.clientX - ps.mx) / rect.width) * viewBox.w,
        dy: ((e.clientY - ps.my) / rect.height) * viewBox.h,
      };
      if (!panRaf.current) {
        panRaf.current = requestAnimationFrame(() => {
          panRaf.current = 0;
          const d = panPending.current;
          const s = panStart.current;
          if (!d || !s) return;
          setViewBox(vb => ({ ...vb, x: s.vx - d.dx, y: s.vy - d.dy }));
        });
      }
      return;
    }
    if (lasso) {
      const pt = mouseToSvg(e.clientX, e.clientY);
      if (!pt) return;
      setLasso(l => l ? { ...l, ex: pt.x, ey: pt.y } : null);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (orbitStart.current) { orbitStart.current = null; setIsOrbiting(false); return; }
    if (isPanning) {
      setIsPanning(false);
      panStart.current = null;
      return;
    }
    if (lasso) {
      const { sx, sy, ex, ey } = lasso;
      const lx1 = Math.min(sx, ex), lx2 = Math.max(sx, ex);
      const ly1 = Math.min(sy, ey), ly2 = Math.max(sy, ey);
      const drag = Math.abs(ex - sx) > 4 || Math.abs(ey - sy) > 4;
      if (drag) {
        const hit = new Set<string>();
        for (const f of visibleFrames) {
          const [x1, y1] = P(f.pt1);
          const [x2, y2] = P(f.pt2);
          if (Math.min(x1, x2) >= lx1 && Math.max(x1, x2) <= lx2 &&
              Math.min(y1, y2) >= ly1 && Math.max(y1, y2) <= ly2) {
            hit.add(f.frameName);
          }
        }
        onSelectionChange(e.shiftKey ? new Set([...selected, ...hit]) : hit);
        setPinned(null); // a box-select isn't a single-beam pin
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && lassoBgOnly.current) {
        onSelectionChange(new Set());
        setPinned(null); // clicking empty space dismisses the pinned card
      }
      setLasso(null);
    }
  }

  useEffect(() => {
    const onWinPointerUp = () => {
      if (isPanning) { setIsPanning(false); panStart.current = null; }
      // Releasing outside the canvas must end an orbit too, or the camera keeps
      // tracking the mouse after the button is up.
      orbitStart.current = null;
      setIsOrbiting(false);
      setLasso(l => (l ? null : l));
    };
    /** Shortcuts are ignored while the user is typing into a field. */
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable === true;
    };
    const onWinKeyDown = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.key === 'Escape') { onSelectionChange(new Set()); setPinned(null); return; }
      if (e.code === 'Space' && !spaceHeld) { setSpaceHeld(true); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // View shortcuts. F for fit is near-universal; the digits follow the
      // numeric-view convention CAD tools use for standard orientations.
      if (e.key === 'f' || e.key === 'F') { fitView(); return; }
      if (!view3d) return;
      const preset: Record<string, ViewPreset> = { '1': 'top', '2': 'front', '3': 'right', '4': 'iso', '0': 'iso' };
      if (preset[e.key]) setPreset(preset[e.key]);
    };
    const onWinKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    // Losing focus mid-gesture must not leave the hand tool stuck on.
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('pointerup', onWinPointerUp);
    window.addEventListener('pointercancel', onWinPointerUp);
    window.addEventListener('keydown', onWinKeyDown);
    window.addEventListener('keyup', onWinKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerup', onWinPointerUp);
      window.removeEventListener('pointercancel', onWinPointerUp);
      window.removeEventListener('keydown', onWinKeyDown);
      window.removeEventListener('keyup', onWinKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [isPanning, onSelectionChange, spaceHeld, view3d, fitView, setPreset]);

  const hovered = hover ? visibleFrames.find(f => f.frameName === hover) : null;
  // The summary card follows the hovered beam, and when nothing is hovered it
  // falls back to the pinned (last-clicked) beam so the card stays put.
  const pinnedFrame = pinned ? visibleFrames.find(f => f.frameName === pinned) : null;
  const cardFrame = hovered ?? pinnedFrame;
  const cardInfo = cardFrame?.memberId ? infoById[cardFrame.memberId] : null;
  const cardPinned = !hovered && !!pinnedFrame; // showing the pinned card (not a hover)

  // Group-tag labels are drawn in SVG user space, which magnifies with the zoom
  // viewBox. Counter-scale them by the zoom factor so each number stays a roughly
  // constant screen size: as you zoom in, members spread apart but the numbers do
  // not grow, so the dense clusters stop overlapping. (viewBox.w === width at fit.)
  const tagScale = viewBox.w / width;

  // ── V/M diagram overlay ────────────────────────────────────────────────────
  // For each visible linked frame with diagram data, render a filled polygon
  // perpendicular to the beam axis, scaled to the global max.
  const diagramPolygons = (() => {
    if (diagramMode === 'off') return null;

    // Global max for normalization — of the MAGNITUDE, because the series is signed.
    // Taking the raw max would normalise against the largest sagging moment and let every
    // hogging value (all negative) scale off it, so a beam whose worst demand is hogging
    // would draw a tiny lobe on a plan where a smaller sagging beam drew a full-size one.
    let globalMax = 0;
    for (const f of visibleFrames) {
      if (!f.memberId) continue;
      const data = diagramDataById[f.memberId];
      if (data) for (const pt of data) globalMax = Math.max(globalMax, Math.abs(pt.v));
    }
    if (globalMax === 0) return null;

    const color = diagramMode === 'moment' ? 'rgba(124,58,237,0.25)' : 'rgba(8,145,178,0.25)';
    const stroke = diagramMode === 'moment' ? '#7c3aed' : '#0891b2';

    return visibleFrames.map(f => {
      if (!f.memberId) return null;
      const data = diagramDataById[f.memberId];
      if (!data || data.length < 2) return null;

      const [x1s, y1s] = P(f.pt1);
      const [x2s, y2s] = P(f.pt2);
      const dx = x2s - x1s, dy = y2s - y1s;
      const len = Math.hypot(dx, dy);
      if (len < 1) return null;

      // Unit perpendicular (90° CCW from beam direction)
      const nx = -dy / len, ny = dx / len;

      // Map station x (ft from I-node) to SVG coordinates along the beam
      const beamLenFt = f.pt1 && f.pt2
        ? Math.hypot(f.pt2.x - f.pt1.x, f.pt2.y - f.pt1.y)
        : 0;
      if (beamLenFt < 0.001) return null;

      const pts: string[] = [];
      // Bottom edge (baseline along the beam)
      pts.push(`${x1s},${y1s}`);
      pts.push(`${x2s},${y2s}`);
      // Top edge (offset by diagram value)
      for (let i = data.length - 1; i >= 0; i--) {
        const t = data[i].x / beamLenFt; // 0..1
        const bx = x1s + t * dx;
        const by = y1s + t * dy;
        const off = (data[i].v / globalMax) * DIAGRAM_MAX_PX;
        pts.push(`${bx + nx * off},${by + ny * off}`);
      }

      return (
        <polygon key={f.frameName + '-diag'}
          points={pts.join(' ')}
          fill={color} stroke={stroke} strokeWidth={0.8} opacity={0.85}
          style={{ pointerEvents: 'none' }}
        />
      );
    });
  })();

  // Imported geometry layers (walls / grids / openings), built with P() so
  // they register to the same plan. pointerEvents:'none' + no data-framename keeps
  // lasso / click / context-menu behaviour untouched.
  // Walls and floor slabs share this layer but must NOT look alike. Drafting
  // convention: hatch = cut material, so the WALL is poché'd and the slab is a
  // light wash you read across. (These were the wrong way round — a floor drawn
  // in wall hatch reads as a wall, which is exactly how it was reported.)
  const wallLayer = visibleWalls.map(w => {
    const isSlab = w.kind === 'slab';
    return (
      <polygon key={w.id}
        points={w.points.map(p => { const [a, b] = P(p); return `${a},${b}`; }).join(' ')}
        fill={isSlab ? 'rgba(148,163,184,0.16)' : 'url(#wallhatch)'}
        stroke="#94a3b8" strokeWidth={isSlab ? 0.8 : 1.4}
        strokeOpacity={isSlab ? 0.7 : 1}
        style={{ pointerEvents: 'none' }} />
    );
  });
  // Vertical frames. In plan a column projects to a single point, so it is only
  // worth drawing in 3D — showing a field of dots over the beams would just be
  // noise. pointerEvents:'none' and no data-framename keep it out of picking,
  // lasso and grouping entirely: this is scenery, not a designable member.
  const columnLayer = view3d ? visibleColumns.map(c => {
    const [x1, y1] = P(c.pt1);
    const [x2, y2] = P(c.pt2);
    return (
      <line key={`col-${c.id}`} x1={x1} y1={y1} x2={x2} y2={y2}
        stroke="#94a3b8" strokeWidth={2.5} strokeLinecap="round"
        opacity={0.65} style={{ pointerEvents: 'none' }} />
    );
  }) : [];

  // Grid bubbles are parked well clear of the structure so their text never
  // overlaps the members: vertical grid lines (constant X, spanning Y) get their
  // label above the plan; horizontal grid lines (constant Y, spanning X) get it to
  // the left. The dashed line is extended so the bubble still reads as its endpoint.
  const GRID_LABEL_GAP = 30; // user-space px of clearance beyond the structure edge
  const gridLayer = visibleGrids.flatMap(g => {
    const dx = Math.abs(g.p2.x - g.p1.x), dy = Math.abs(g.p2.y - g.p1.y);
    const vertical = dx <= dy;
    let bubble: { x: number; y: number };
    let line: { x1: number; y1: number; x2: number; y2: number };
    if (view3d) {
      // Axonometric: "above" and "left of" the plan mean nothing once the model is
      // tipped, so run the line between its own projected ends and push the bubble
      // out along that same direction.
      const [ax, ay] = P(g.p1);
      const [bx, by] = P(g.p2);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      bubble = { x: bx + ux * GRID_LABEL_GAP, y: by + uy * GRID_LABEL_GAP };
      line = { x1: ax, y1: ay, x2: bubble.x, y2: bubble.y };
    } else if (vertical) {
      const cx = tx((g.p1.x + g.p2.x) / 2);
      const topY = ty(fMaxY) - GRID_LABEL_GAP;      // above the top of the structure
      bubble = { x: cx, y: topY };
      line = { x1: cx, y1: ty(fMinY), x2: cx, y2: topY };
    } else {
      const cy = ty((g.p1.y + g.p2.y) / 2);
      const leftX = tx(fMinX) - GRID_LABEL_GAP;     // left of the structure
      bubble = { x: leftX, y: cy };
      line = { x1: leftX, y1: cy, x2: tx(fMaxX), y2: cy };
    }
    return [
      <line key={g.id + 'l'} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2}
        stroke="#cbd5e1" strokeWidth={1} strokeDasharray="4 4" style={{ pointerEvents: 'none' }} />,
      <g key={g.id + 'b'} style={{ pointerEvents: 'none' }}>
        <circle cx={bubble.x} cy={bubble.y} r={8} fill="white" stroke="#cbd5e1" />
        <text x={bubble.x} y={bubble.y + 3} textAnchor="middle" fontSize={9} fill="#64748b">{g.label}</text>
      </g>,
    ];
  });
  const openingLayer = visibleOpenings.map(o => (
    <polygon key={o.id}
      points={o.points.map(p => { const [a, b] = P(p); return `${a},${b}`; }).join(' ')}
      fill="none" stroke="#64748b" strokeWidth={1.5} strokeDasharray="6 4" style={{ pointerEvents: 'none' }} />
  ));

  return (
    // flexShrink: 0 — the parent centers us with flexbox, and a shrunk SVG would
    // no longer match its own width/height attributes, breaking the viewBox↔client
    // -rect mapping that mouseToSvg (hit-testing, lasso, pan, zoom anchor) relies on.
    <div style={{ position: 'relative', userSelect: 'none', flexShrink: 0 }}>
      <svg
        ref={svgRef}
        width={width} height={height}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        style={{
          background: '#f8fafc', borderRadius: 10, border: `1px solid ${BORDER.default}`, display: 'block',
          // The cursor is the only feedback for which tool a modifier has armed,
          // so it has to track the same precedence the handlers use.
          cursor: isPanning || isOrbiting ? 'grabbing'
            : spaceHeld ? 'grab'
              : lasso ? 'crosshair'
                  : inspectMode ? 'zoom-in'
                    : view3d ? 'grab' : 'default',
          // Claim the gestures from the browser: without this a touch/precision
          // trackpad drag scrolls the page instead of orbiting, and the browser's
          // own pinch fights the wheel handler.
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={e => {
          const tag = (e.target as Element).tagName.toLowerCase();
          if (tag === 'svg' || tag === 'rect' || tag === 'pattern') fitView();
        }}
        onContextMenu={e => {
          e.preventDefault();
          // A right-DRAG is a pan; only a right-CLICK opens the beam menu.
          if (rightDragged.current) { rightDragged.current = false; return; }
          // Find which frame was right-clicked via data attribute
          const el = (e.target as Element).closest('[data-framename]');
          const frameName = el?.getAttribute('data-framename');
          if (!frameName) return;
          const frame = visibleFrames.find(f => f.frameName === frameName);
          if (frame?.memberId) onBeamContextMenu?.(frame.memberId, frameName, e.clientX, e.clientY);
        }}
      >
        <defs>
          <pattern id="mmgrid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#eef2f7" strokeWidth="1" />
          </pattern>
          {/* Wall poché — the hatch belongs to walls (cut material), not slabs. */}
          <pattern id="wallhatch" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="rgba(148,163,184,0.20)" />
            <path d="M0,6 l6,-6" stroke="#64748b" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#mmgrid)" rx="10" />

        {/* Imported geometry layers — behind every frame (walls → grids → openings) */}
        {showColumns && view3d && <g style={{ pointerEvents: 'none' }}>{columnLayer}</g>}
        {showWalls && <g style={{ pointerEvents: 'none' }}>{wallLayer}</g>}
        {showGrids && <g style={{ pointerEvents: 'none' }}>{gridLayer}</g>}
        {showOpenings && <g style={{ pointerEvents: 'none' }}>{openingLayer}</g>}

        {/* Diagram overlays (below beams) */}
        {diagramPolygons}

        {visibleFrames.map(f => {
          const isSel = selected.has(f.frameName);
          const isHov = hover === f.frameName;
          const [x1, y1] = P(f.pt1);
          const [x2, y2] = P(f.pt2);
          const color = frameColor(f);
          const linked = !!f.memberId;
          const flagged = showErrors && !!f.memberId && errorMemberIds.has(f.memberId);
          // Feature ①: when a group is active, halftone every frame not in it.
          const dimmed = !!focusFrames && focusFrames.size > 0 && !focusFrames.has(f.frameName);
          const baseOpacity = dimmed ? 0.12 : (linked ? 1 : 0.6);
          // A (near-)vertical member — a column — projects to a single point in
          // plan; draw it as a square marker instead of a zero-length line.
          const isColumn = Math.hypot(f.pt2.x - f.pt1.x, f.pt2.y - f.pt1.y) < 0.5;
          const r = isHov ? 5 : 4;
          return (
            <g key={f.frameName}
              data-framename={f.frameName}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(f.frameName)}
              onMouseLeave={() => setHover(h => h === f.frameName ? null : h)}
              onClick={e => {
                e.stopPropagation();
                // Inspect mode: show beam card instead of selecting
                if (inspectMode && f.memberId) {
                  onBeamInspect?.(f.memberId, e.clientX, e.clientY);
                  return;
                }
                // Group-edit mode: delegate to onFrameClick; it returns true if handled
                if (onFrameClick && onFrameClick(f.frameName)) return;
                const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                if (additive) {
                  const next = new Set(selected);
                  if (next.has(f.frameName)) next.delete(f.frameName); else next.add(f.frameName);
                  onSelectionChange(next);
                } else {
                  onSelectionChange(new Set([f.frameName]));
                }
                setPinned(f.frameName); // keep this beam's summary card up
              }}
              onDoubleClick={() => f.memberId && onDoubleClick?.(f.memberId)}
            >
              {isColumn ? (
                <>
                  <rect x={x1 - 7} y={y1 - 7} width={14} height={14} fill="transparent" />
                  {flagged && <rect x={x1 - r - 1} y={y1 - r - 1} width={2 * r + 2} height={2 * r + 2} fill="none" stroke={STATUS.fail} strokeWidth={2} opacity={0.5} />}
                  {isSel && <rect x={x1 - r - 1} y={y1 - r - 1} width={2 * r + 2} height={2 * r + 2} fill="none" stroke="#2563eb" strokeWidth={2} />}
                  <rect x={x1 - r} y={y1 - r} width={2 * r} height={2 * r} rx={1.5}
                    fill={color} stroke="#0b1220" strokeWidth={0.5}
                    strokeDasharray={linked ? undefined : '3 2'} opacity={baseOpacity} />
                </>
              ) : (
                <>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(12, strokeFor(f.memberId, isHov) + 8)} />
                  {flagged && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={STATUS.fail} strokeWidth={strokeFor(f.memberId, isHov) + 4} opacity={0.45} strokeLinecap="round" />}
                  {isSel && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2563eb" strokeWidth={strokeFor(f.memberId, isHov) + 6} opacity={0.35} strokeLinecap="round" />}
                  <line x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={color}
                    strokeWidth={strokeFor(f.memberId, isHov)}
                    strokeLinecap="round"
                    strokeDasharray={linked ? undefined : '6 4'}
                    opacity={baseOpacity}
                  />
                  {colorMode === 'groupTags' && f.memberId && groupIndexMap.has(f.memberId) && (() => {
                    // Bias the tag toward the beam's mark end (higher-hogging support):
                    // 'start' → near pt1 (x1,y1), 'end' → near pt2 (x2,y2). x=0 (I-node)
                    // maps to pt1, matching the moment-diagram overlay. No mark end known
                    // → sit at the midpoint (t = 0.5) as before.
                    const me = markEndById[f.memberId];
                    const t = me === 'start' ? MARK_TAG_FRAC : me === 'end' ? 1 - MARK_TAG_FRAC : 0.5;
                    const cx = x1 + t * (x2 - x1), cy = y1 + t * (y2 - y1);
                    const half = 7 * tagScale;
                    return (
                      <>
                        <rect x={cx - half} y={cy - half} width={half * 2} height={half * 2} rx={2.5 * tagScale}
                          fill="white" stroke={BORDER.default} strokeWidth={tagScale} opacity={dimmed ? 0.3 : 0.95} style={{ pointerEvents: 'none' }} />
                        <text x={cx} y={cy + 3.5 * tagScale} fontSize={10 * tagScale} fontWeight={800}
                          textAnchor="middle" fill={INK.strong} opacity={dimmed ? 0.3 : 1} style={{ pointerEvents: 'none' }}>
                          {(groupIndexMap.get(f.memberId) ?? 0) + 1}
                        </text>
                      </>
                    );
                  })()}
                </>
              )}
            </g>
          );
        })}

        {/* Lasso rect */}
        {lasso && (() => {
          const { sx, sy, ex, ey } = lasso;
          return (
            <rect
              x={Math.min(sx, ex)} y={Math.min(sy, ey)}
              width={Math.abs(ex - sx)} height={Math.abs(ey - sy)}
              fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={1} strokeDasharray="4 2"
            />
          );
        })()}
      </svg>

      {/* Toolbar overlay — fit, the standard views, and the controls cheat-sheet */}
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4, alignItems: 'flex-start' }}>
        <button onClick={fitView} style={navBtn} title="Fit to view  (F, or double-click empty space)">⊡ Fit</button>
        {view3d && ([
          ['top', 'Top', '1'], ['front', 'Front', '2'], ['right', 'Right', '3'], ['iso', 'Iso', '4'],
        ] as [ViewPreset, string, string][]).map(([v, label, key]) => (
          <button key={v} onClick={() => setPreset(v)} style={navBtn} title={`${label} view  (${key})`}>{label}</button>
        ))}
        <button
          onClick={() => setShowHelp(h => !h)}
          style={{ ...navBtn, color: showHelp ? ACCENT.primary : INK.muted, borderColor: showHelp ? ACCENT.primary : BORDER.default }}
          title="Navigation controls"
          aria-pressed={showHelp}
        >?</button>
        {showHelp && (
          <div style={{
            position: 'absolute', top: 30, left: 0, zIndex: 20, background: 'white',
            border: `1px solid ${BORDER.default}`, borderRadius: 8, padding: '8px 10px',
            boxShadow: '0 6px 20px rgba(15,23,42,0.14)', fontSize: 10, color: INK.base,
            lineHeight: 1.75, whiteSpace: 'nowrap',
          }}>
            {([
              // Shift STARTS a box-select; held once an orbit is already running
              // it locks the turn to one axis. Two different moments, so they are
              // worded to say which.
              ...(view3d
                ? [['Drag empty space', 'Orbit'], ['Shift while orbiting', 'Lock to one axis'], ['Shift + drag', 'Box-select']]
                : [['Drag empty space', 'Box-select']]),
              ['Middle / right drag', 'Pan'],
              ['Space + drag', 'Pan'],
              ['Scroll / pinch', 'Zoom to cursor'],
              ['Double-click empty', 'Fit'],
              ['F', 'Fit'],
              ...(view3d ? [['1 / 2 / 3 / 4', 'Top / Front / Right / Iso']] : []),
              ['Esc', 'Clear selection'],
            ] as [string, string][]).map(([k, v]) => (
              <div key={`${k}-${v}`} style={{ display: 'flex', gap: 10, justifyContent: 'space-between' }}>
                <span style={{ color: INK.secondary }}>{k}</span>
                <span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Summary card — follows the hovered beam, and stays pinned to the last
          clicked beam once nothing is hovered. Suppressed for the beam already
          shown in the rich inspect card. */}
      {cardFrame && !(inspectMode && cardFrame.memberId === inspectedMemberId) && (
        <div style={{
          position: 'absolute', top: 8, right: 8, background: 'white',
          border: `1px solid ${cardPinned ? ACCENT.primary : BORDER.default}`, borderRadius: 8, padding: '8px 12px',
          fontSize: 11, color: INK.base, boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          pointerEvents: 'none', maxWidth: 280,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
            {cardPinned && <span title="Pinned" style={{ fontSize: 10 }}>📌</span>}
            <span style={{ fontWeight: 700, color: INK.strong }}>{cardFrame.frameName}</span>
          </div>
          <div style={{ color: INK.secondary, marginBottom: 4 }}>{cardFrame.story} · {cardFrame.sectionName}</div>
          {(() => {
            // Feature ⑤: show which design group this beam belongs to.
            const g = cardFrame.memberId ? designGroups.find(gr => gr.memberIds.includes(cardFrame.memberId!)) : undefined;
            const col = cardFrame.memberId ? groupColorMap.get(cardFrame.memberId) : undefined;
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: col ?? MAP_GRAY.unassigned }} />
                <span style={{ color: g ? INK.strong : INK.muted, fontWeight: 600 }}>{g ? g.label : 'Ungrouped'}</span>
              </div>
            );
          })()}
          {cardInfo ? (
            cardInfo.error ? (
              <div style={{ color: STATUS.fail, fontSize: 10 }}>DCR unavailable: {cardInfo.error}</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                  <span>Flex <span style={{ ...MONO_NUM, fontWeight: 700, color: dcrToColor(cardInfo.dcrFlex) }}>{cardInfo.dcrFlex.toFixed(3)}</span></span>
                  <span>Shear <span style={{ ...MONO_NUM, fontWeight: 700, color: dcrToColor(cardInfo.dcrShear) }}>{cardInfo.dcrShear.toFixed(3)}</span></span>
                </div>
                <div style={{ fontSize: 10, color: INK.secondary, lineHeight: 1.6 }}>
                  <div>Top: <span style={{ color: INK.strong }}>{cardInfo.top}</span></div>
                  <div>Bot: <span style={{ color: INK.strong }}>{cardInfo.bot}</span></div>
                  <div>Stirrups: <span style={{ color: INK.strong }}>{cardInfo.stirrups}</span></div>
                  {cardInfo.weight && (
                    <div>Steel: <span style={{ color: INK.strong, ...MONO_NUM }}>{cardInfo.weight}</span></div>
                  )}
                </div>
              </>
            )
          ) : (
            <div style={{ color: INK.muted }}>No results — run design first</div>
          )}
          {cardInfo?.warnings && cardInfo.warnings.length > 0 && (() => {
            const sorted = [...cardInfo.warnings].sort((a, b) =>
              (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
            const shown = sorted.slice(0, 3);
            const extra = sorted.length - shown.length;
            return (
              <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid #f3f4f6', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {shown.map((w, i) => {
                  const txt = `${w.code}: ${w.message}`;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 4, fontSize: 10 }}>
                      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginTop: 3, flexShrink: 0, background: w.severity === 'error' ? STATUS.fail : STATUS.warn }} />
                      <span style={{ color: '#4b5563' }}>{txt.length > 60 ? txt.slice(0, 60) + '…' : txt}</span>
                    </div>
                  );
                })}
                {extra > 0 && <div style={{ fontSize: 10, color: INK.muted }}>+{extra} more</div>}
              </div>
            );
          })()}
          {(colorMode === 'flexSteel' || colorMode === 'stirrups' || colorMode === 'weight') && cardFrame?.memberId && metricById[cardFrame.memberId] !== undefined && (
            <div style={{ marginTop: 4, fontSize: 10 }}>
              <span style={{ color: INK.base }}>{metricLabel ?? 'Metric'}: </span>
              <span style={{ ...MONO_NUM, fontWeight: 700 }}>{metricById[cardFrame.memberId].toFixed(3)}</span>
            </div>
          )}
          <div style={{ color: INK.muted, marginTop: 4, fontSize: 10 }}>
            {cardPinned ? 'pinned · dbl=open · click empty space to dismiss' : 'click=select · dbl=open · shift+click=add'}
          </div>
        </div>
      )}

      {/* Error highlight hint */}
      {showErrors && (
        <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', alignItems: 'center', gap: 4, background: 'white', borderRadius: 6, padding: '4px 10px', border: `1px solid ${BORDER.default}`, fontSize: 10, color: STATUS.fail }}>
          <span style={{ display: 'inline-block', width: 14, height: 3, background: STATUS.fail, borderRadius: 2, opacity: 0.45 }} />
          ⚠ has errors
        </div>
      )}

      {/* DCR legend when in DCR mode — rendered from the (editable) bands so the
          legend can never drift from the fill colors. Click ✎ to reband. */}
      {/* Both DCR modes read the same bands, so they share one legend — flipping between
          the app's DCR and S-Concrete's must not also change the scale underneath. */}
      {(colorMode === 'dcr' || colorMode === 'sconcreteDcr') && (
        <DcrScaleLegend bands={dcrBands} thresholds={dcrThresholds} onChange={onDcrThresholdsChange}
          colors={dcrColors} onColorsChange={onDcrColorsChange} />
      )}

      {/* S-Concrete pass/fail legend */}
      {colorMode === 'sconcrete' && (
        <div style={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 10, background: 'white', borderRadius: 6, padding: '4px 10px', border: `1px solid ${BORDER.default}`, fontSize: 10, color: INK.secondary }}>
          {([['OK', STATUS.ok], ['Overstressed', STATUS.fail], ['Not run', MAP_GRAY.notRun]] as const).map(([l, c]) => (
            <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 14, height: 3, background: c, borderRadius: 2 }} />
              {l}
            </span>
          ))}
        </div>
      )}

      {/* Auto-group overlay legend — family + group # with matching colors */}
      {colorMode === 'autoGroup' && autoGroupOverlay.length > 0 && (
        <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'white', borderRadius: 6, padding: '6px 10px', border: `1px solid ${BORDER.default}`, fontSize: 10, color: INK.base, maxHeight: 180, overflow: 'auto', maxWidth: 260 }}>
          <div style={{ fontWeight: 700, color: INK.secondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: TRACK.wide }}>Auto-group preview</div>
          {autoGroupOverlay.map(bin => (
            <div key={bin.binKey} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0' }}>
              <span style={{ display: 'inline-block', width: 12, height: 4, background: bin.color, borderRadius: 2, flexShrink: 0 }} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bin.label} · {bin.memberIds.length}</span>
            </div>
          ))}
        </div>
      )}

      {/* Metric ramp legend */}
      {(colorMode === 'flexSteel' || colorMode === 'stirrups' || colorMode === 'weight') && metricRange && (
        <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'white', borderRadius: 6, padding: '6px 10px', border: `1px solid ${BORDER.default}`, fontSize: 10, color: INK.secondary, minWidth: 140 }}>
          <div style={{ marginBottom: 4, fontWeight: 600 }}>{metricLabel ?? ''}</div>
          <div style={{ position: 'relative', height: 10, borderRadius: 4, overflow: 'hidden', background: `linear-gradient(to right, ${rampStops(metricRange.min, metricRange.max).map(s => s.color).join(',')})` }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span>{metricRange.min.toFixed(2)}</span>
            <span>{((metricRange.min + metricRange.max) / 2).toFixed(2)}</span>
            <span>{metricRange.max.toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* Diagram legend */}
      {diagramMode !== 'off' && (
        <div style={{ position: 'absolute', bottom: 8, right: 8, background: 'white', borderRadius: 6, padding: '4px 10px', border: `1px solid ${BORDER.default}`, fontSize: 10, color: diagramMode === 'moment' ? '#7c3aed' : '#0891b2' }}>
          {diagramMode === 'moment' ? '▮ Moment envelope (max |M|)' : '▮ Shear envelope (max |V|)'}
        </div>
      )}
    </div>
  );
}

/** DCR-scale legend for the plan. Read-only chips by default; when the Map passes
 *  editable thresholds + an onChange it also offers a ✎ slider panel to move the
 *  green/lime/amber/red cut-points, recolouring the whole plan live. */
function DcrScaleLegend({ bands, thresholds, onChange, colors, onColorsChange }: {
  bands: readonly DcrBand[];
  thresholds?: [number, number, number];
  onChange?: (t: [number, number, number]) => void;
  /** The four band colours, when the host lets them be edited. */
  colors?: readonly string[];
  onColorsChange?: (c: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const editable = !!thresholds && !!onChange;
  const recolourable = !!colors && !!onColorsChange;
  const setT = (i: number, v: number) => {
    if (!thresholds || !onChange) return;
    const lo = i === 0 ? 0.1 : thresholds[i - 1] + 0.05;
    const hi = i === 2 ? 3 : thresholds[i + 1] - 0.05;
    const t = [...thresholds] as [number, number, number];
    t[i] = Math.min(hi, Math.max(lo, Math.round(v * 20) / 20));
    onChange(t);
  };
  // The swatch IS the colour input — an <input type="color"> stripped of its chrome and
  // sized to the bar it replaces. That keeps the affordance to zero extra pixels: no
  // palette popover to build, no second button, and the OS picker does the hard part.
  const Swatch = ({ i, w, h }: { i: number; w: number; h: number }) => (
    recolourable ? (
      <input
        type="color" value={bands[i].color} aria-label={`Colour for ${bands[i].label}`}
        title={`${bands[i].label} — click to recolour`}
        onChange={e => {
          const next = [0, 1, 2, 3].map(k => colors![k] || bands[k].color);
          next[i] = e.target.value;
          onColorsChange!(next);
        }}
        style={{
          width: w, height: h, padding: 0, border: 'none', borderRadius: 2,
          background: 'none', cursor: 'pointer', flexShrink: 0, appearance: 'none',
        }}
      />
    ) : (
      <span style={{ display: 'inline-block', width: w, height: h, background: bands[i].color, borderRadius: 2, flexShrink: 0 }} />
    )
  );
  return (
    <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'white', borderRadius: 6, padding: '4px 10px', border: `1px solid ${BORDER.default}`, fontSize: 10, color: INK.secondary }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {[...bands.map(b => [b.label, b.color] as const), ['Unlinked', MAP_GRAY.unlinked] as const].map(([l, c]) => (
          <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 14, height: 3, background: c, borderRadius: 2 }} />
            {l}
          </span>
        ))}
        {editable && (
          <button onClick={() => setEditing(e => !e)} title="Edit the DCR colour scale"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: editing ? ACCENT.primary : INK.muted, fontSize: 12, lineHeight: 1, padding: 0, marginLeft: 2 }}>✎</button>
        )}
      </div>
      {editable && editing && thresholds && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${BORDER.default}`, display: 'flex', flexDirection: 'column', gap: 5, minWidth: 210 }}>
          {/* One row per band. The first three carry the cut-point that ENDS them; the
              fourth is open-ended (≥ t3) and so has a swatch and a label but no slider —
              there is no fourth cut-point to move, and inventing a dead slider to make
              the rows look alike would be worse than the asymmetry. */}
          {([0, 1, 2] as const).map(i => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Swatch i={i} w={12} h={10} />
              <input type="range" min={0.1} max={2} step={0.05} value={thresholds[i]}
                onChange={e => setT(i, parseFloat(e.target.value))}
                style={{ flex: 1, cursor: 'pointer', accentColor: bands[i].color }} />
              <span style={{ ...MONO_NUM, width: 32, textAlign: 'right' }}>{thresholds[i].toFixed(2)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Swatch i={3} w={12} h={10} />
            <span style={{ flex: 1, color: INK.muted }}>{bands[3].label}</span>
            <span style={{ ...MONO_NUM, width: 32, textAlign: 'right', color: INK.muted }}>over</span>
          </div>
          <button
            onClick={() => {
              onChange!([...DEFAULT_DCR_THRESHOLDS] as [number, number, number]);
              onColorsChange?.([...MAP_DCR_COLORS]);
            }}
            style={{ alignSelf: 'flex-start', marginTop: 2, fontSize: 10, color: INK.muted, background: 'none', border: `1px solid ${BORDER.default}`, borderRadius: 4, padding: '1px 6px', cursor: 'pointer' }}>Reset</button>
        </div>
      )}
    </div>
  );
}
