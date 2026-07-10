/**
 * ModelMapView — top-level Map tab: canvas (left) + tabbed right panel
 * (Groups | Auto-Group | Savings).
 */
import { useState, useMemo, useRef, useLayoutEffect, useCallback, useEffect, useDeferredValue, startTransition } from 'react';
import type { Project, DesignGroup, RebarLayout, ComboForces, DesignResults, AutoGroupBin } from '../../types';
import { runDesign } from '../../engines';
import { resolveCrack } from '../../utils/resolveCrack';
import { formatBarLabel } from '../../utils/rebar';
import { flexSteelRatioPct, stirrupAvPerFt, steelWeightPerFt } from '../../utils/autoGroup';
import { suggestGroupRebar, isSuggestError } from '../../utils/suggestRebar';
import MapCanvas, { type ColorMode, type FrameInfo, type DiagramMode } from './MapCanvas';
import GroupPanel from './GroupPanel';
import GroupRebarEditor from './GroupRebarEditor';
import ColumnForceGrid from './ColumnForceGrid';
import AutoGroupPanel from './AutoGroupPanel';
import TopProgressBar from '../common/TopProgressBar';
import HistogramPanel from './HistogramPanel';
import { concGradeLabel, steelGradeLabel, METRIC_MODES } from './frameColor';
import { groupColor } from './groupColors';
import { rampStops } from './colorRamp';
import SavingsPanel from './SavingsPanel';
import TakeoffPanel from './TakeoffPanel';
import BeamContextMenu from './BeamContextMenu';
import BeamInspectCard from './BeamInspectCard';
import HelpLink from '../Help/HelpLink';
import GroupDashboard from '../Dashboard/GroupDashboard';
import SconcreteDashboard from '../Dashboard/SconcreteDashboard';
import { buildDashboardPayload } from '../../utils/dashboardPayload';
import { useUnits } from '../../contexts/UnitsContext';
import Dropdown from '../common/Dropdown';
import { ACCENT, BORDER, CATEGORICAL, INK, MONO_NUM, STATUS, SURFACE } from '../../theme';

type RightTab = 'groups' | 'autogroup' | 'savings' | 'takeoff';
type FlexFace = 'top' | 'bot';

interface Props {
  project: Project;
  onProjectChange: (updater: (prev: Project) => Project) => void;
  onOpenEtabsImport: () => void;
  onPickMember: (memberId: string) => void;
  onDeleteMember?: (memberId: string) => void;
  onDeleteMembers?: (ids: string[]) => void;
}

/** Build "2-#8 + 3-#6" style rebar string from layers. */
function rebarStr(bars: { numBars: number; barSize: number }[]): string {
  return bars.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join(' + ');
}

/** Build stirrup string: "#4 @ 6 in" or "#4 @ 6/12/6 in". */
function stirrupStr(
  rebar: { ties?: { barSize: number; spacing: number; legs: number }; tieZones?: { spacing: number }[] },
  fmtLen: (v: number) => string,
  lenLabel: string,
): string {
  const t = rebar.ties;
  if (!t) return '—';
  const bar = formatBarLabel(t.barSize);
  if (rebar.tieZones) {
    return `${bar} @ ${rebar.tieZones.map(z => fmtLen(z.spacing)).join('/')} ${lenLabel}`;
  }
  return `${bar} @ ${fmtLen(t.spacing)} ${lenLabel}`;
}

/** Per-station envelope: max |M| or |V| across all combos. */
function stationEnvelope(stationForces: ComboForces[], type: 'M' | 'V'): { x: number; v: number }[] {
  const byX = new Map<number, number>();
  for (const cf of stationForces) {
    for (const s of cf.stations) {
      const val = Math.abs(type === 'M' ? s.M : s.V);
      byX.set(s.x, Math.max(byX.get(s.x) ?? 0, val));
    }
  }
  return [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([x, v]) => ({ x, v }));
}

// stationEnvelope is used inside BeamInspectCard too, exported there locally.

/**
 * Remembers the Map tab's working context across tab switches. Opening a member's
 * design tab unmounts ModelMapView (App renders the map only when `tab === 'map'`),
 * so without this the dashboard, selected group and colour mode would be lost.
 * A module-level cache survives the unmount and is restored on remount, so
 * returning to the Map lands on the same view the user left.
 */
const mapViewCache: {
  colorMode?: ColorMode; story?: string; flexFace?: FlexFace; diagramMode?: DiagramMode;
  rightTab?: RightTab; activeGroupId?: string | null;
  dashboardOpen?: boolean; dashboardSelectedGroupId?: string | null;
  sconcreteOpen?: boolean; sconcreteSelectedGroupId?: string | null;
} = {};

export default function ModelMapView({ project, onProjectChange, onOpenEtabsImport, onPickMember, onDeleteMember, onDeleteMembers }: Props) {
  const { fmtVal, label, units, toDisplay } = useUnits();
  const [selectedFrames, setSelectedFrames] = useState<Set<string>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string | null>(mapViewCache.activeGroupId ?? null);
  const [colorMode, setColorMode] = useState<ColorMode>(mapViewCache.colorMode ?? 'dcr');
  const [flexFace, setFlexFace] = useState<FlexFace>(mapViewCache.flexFace ?? 'bot');
  const [story, setStory] = useState<string>(mapViewCache.story ?? 'All');
  const [diagramMode, setDiagramMode] = useState<DiagramMode>(mapViewCache.diagramMode ?? 'off');
  const [lineWeightScale, setLineWeightScale] = useState(0.4); // feature ④: 0 = uniform 3px
  const [legendKey, setLegendKey] = useState<string | null>(null); // clicked legend row → isolate on plan
  const [dashHoverFrame, setDashHoverFrame] = useState<string | null>(null); // hovered dashboard beam → highlight on plan
  // In-map Group Dashboard: splits the map area (plan | dashboard) and can pop out.
  const [dashboardOpen, setDashboardOpen] = useState(mapViewCache.dashboardOpen ?? false);
  const [dashboardPoppedOut, setDashboardPoppedOut] = useState(false); // Phase B (Electron window)
  const [dashboardSelectedGroupId, setDashboardSelectedGroupId] = useState<string | null>(mapViewCache.dashboardSelectedGroupId ?? null);
  // In-map S-Concrete "Verify" dashboard — a parallel split (plan | S-Concrete). Only
  // one split (Dashboard or Verify) is open at a time; opening one closes the other.
  const [sconcreteOpen, setSconcreteOpen] = useState(mapViewCache.sconcreteOpen ?? false);
  const [sconcreteSelectedGroupId, setSconcreteSelectedGroupId] = useState<string | null>(mapViewCache.sconcreteSelectedGroupId ?? null);
  const [dashboardSplit, setDashboardSplit] = useState<number>(() => {
    const v = Number(localStorage.getItem('mapDashboardSplit'));
    return Number.isFinite(v) && v > 0.15 && v < 0.85 ? v : 0.5;
  });
  const dashHostRef = useRef<HTMLDivElement>(null);
  const [rightTab, setRightTab] = useState<RightTab>(mapViewCache.rightTab ?? 'groups');
  const [highlightedFrames, setHighlightedFrames] = useState<Set<string>>(new Set());
  const [inspectMode, setInspectMode] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [inspectedMemberId, setInspectedMemberId] = useState<string | null>(null);
  const [inspectPos, setInspectPos] = useState({ x: 0, y: 0 });
  // Reference overlay lives in component state, NOT the project — writing it to
  // the project on every recompute caused an infinite render loop.
  const [autoGroupOverlay, setAutoGroupOverlay] = useState<AutoGroupBin[]>([]);
  const [contextMenu, setContextMenu] = useState<{ memberId: string; frameName: string; x: number; y: number } | null>(null);
  const [suggestAllNote, setSuggestAllNote] = useState<string | null>(null);
  // User override for the metric color-ramp bounds (Steel% / Stirrups / Weight).
  // null = auto (data min/max). Lets the user refine the legend to highlight a band.
  const [metricOverride, setMetricOverride] = useState<{ min: number; max: number } | null>(null);
  const [showMetricHistogram, setShowMetricHistogram] = useState(true);

  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 900, h: 600 });
  useLayoutEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    // Apply a measured size, deduping no-op updates. Uses layout (untransformed)
    // dimensions so the canvas fills its box correctly at any preferences zoom.
    const apply = (w: number, h: number) => {
      if (w > 50 && h > 50) {
        setCanvasSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    };
    // Measure synchronously on mount — the ResizeObserver's first callback can be
    // dropped in Electron/Chromium when the element is sized in the same frame it
    // is observed, which would leave the canvas stuck at its default size.
    apply(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      apply(Math.floor(r.width), Math.floor(r.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Persist the working context so a member-tab round-trip returns to this view.
  useEffect(() => {
    mapViewCache.colorMode = colorMode;
    mapViewCache.story = story;
    mapViewCache.flexFace = flexFace;
    mapViewCache.diagramMode = diagramMode;
    mapViewCache.rightTab = rightTab;
    mapViewCache.activeGroupId = activeGroupId;
    mapViewCache.dashboardOpen = dashboardOpen;
    mapViewCache.dashboardSelectedGroupId = dashboardSelectedGroupId;
    mapViewCache.sconcreteOpen = sconcreteOpen;
    mapViewCache.sconcreteSelectedGroupId = sconcreteSelectedGroupId;
  }, [colorMode, story, flexFace, diagramMode, rightTab, activeGroupId, dashboardOpen, dashboardSelectedGroupId, sconcreteOpen, sconcreteSelectedGroupId]);

  // A restored story filter from a previous model would blank a newly-loaded one —
  // fall back to "All" if the remembered story isn't in the current model.
  useEffect(() => {
    const stories = project.modelMap?.stories ?? [];
    if (story !== 'All' && !stories.includes(story)) setStory('All');
  }, [story, project.modelMap]);

  const map = project.modelMap;
  const groups = project.designGroups ?? [];
  const members = project.members;
  const frameByMemberId = useMemo(() => {
    const fm = new Map<string, string>();
    for (const f of project.modelMap?.frames ?? []) if (f.memberId) fm.set(f.memberId, f.frameName);
    return fm;
  }, [project.modelMap]);
  // Defer the heavy design recompute so changing a dropdown / applying rebar
  // keeps the UI responsive instead of blocking the thread. `recomputing` is
  // true while the deferred value lags behind — used to show a progress bar.
  //
  // To avoid a ~5-minute freeze on first render with many members, we use a
  // transitional state that starts empty and is populated via startTransition
  // after mount. This ensures the initial paint is fast (empty canvas) and
  // the heavy design computation runs in a low-priority transition.
  const [committedMembers, setCommittedMembers] = useState(() => [] as typeof members);
  useEffect(() => {
    startTransition(() => setCommittedMembers(members));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);
  const deferredMembers = useDeferredValue(committedMembers);
  const recomputing = deferredMembers !== committedMembers;
  const hiddenMemberIds = useMemo(() => new Set(project.hiddenMemberIds ?? []), [project.hiddenMemberIds]);
  const hiddenStories = useMemo(() => new Set(project.hiddenStories ?? []), [project.hiddenStories]);

  // S-Concrete pass/fail per member, from the last persisted batch — colours the
  // map so the "additional design" results feed back into the model view.
  const scoStatusById = useMemo(() => {
    const out: Record<string, 'OK' | 'NG'> = {};
    for (const r of project.sconcreteResults ?? []) {
      const util = Math.max(r.nmUtil ?? 0, r.vtUtil ?? 0);
      const s: 'OK' | 'NG' = ((r.status != null && r.status !== 'OK') || util > 1) ? 'NG' : 'OK';
      for (const mid of r.memberIds) if (out[mid] !== 'NG') out[mid] = s; // worst wins
    }
    return out;
  }, [project.sconcreteResults]);

  // Live frame→member linkage
  const enrichedFrames = useMemo(() => {
    const byFrameName = new Map<string, string>();
    for (const m of members) {
      if (m.etabs?.frameName) byFrameName.set(m.etabs.frameName, m.id);
    }
    return (map?.frames ?? []).map(f => ({
      ...f,
      memberId: byFrameName.get(f.frameName) ?? f.memberId,
    }));
  }, [map?.frames, members]);

  // Single design pass — produces DesignResults + FrameInfo for all members
  const { infoById, designResultsById } = useMemo(() => {
    const info: Record<string, FrameInfo> = {};
    const results: Record<string, DesignResults> = {};
    for (const m of deferredMembers) {
      if (m.memberType !== 'beam' || !m.loads.length) continue;
      try {
        let dcrFlex = 0, dcrShear = 0;
        let bestRes: DesignResults | null = null;
        for (const l of m.loads) {
          const r = runDesign(m.section, m.material, m.rebar, l, m.span, project.code, resolveCrack(m, project.code, project.slsCombo));
          const govDCR = Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion, r.DCR_crack ?? 0);
          if (!bestRes || govDCR > Math.max(bestRes.DCR_flex_pos, bestRes.DCR_flex_neg, bestRes.DCR_shear, bestRes.DCR_torsion, bestRes.DCR_crack ?? 0)) bestRes = r;
          dcrFlex = Math.max(dcrFlex, r.DCR_flex_pos, r.DCR_flex_neg);
          dcrShear = Math.max(dcrShear, r.DCR_shear);
        }
        if (bestRes) results[m.id] = bestRes;
        const w = steelWeightPerFt(m);
        info[m.id] = {
          dcr: Math.max(dcrFlex, dcrShear),
          dcrFlex,
          dcrShear,
          top: rebarStr(m.rebar.topBars),
          bot: rebarStr(m.rebar.botBars),
          stirrups: stirrupStr(m.rebar, v => fmtVal(v, 'length'), label('length')),
          weight: `${fmtVal(w.totalLbFt, 'steelWeightPerLength')} ${label('steelWeightPerLength')} (L ${fmtVal(w.longLbFt, 'steelWeightPerLength')} + S ${fmtVal(w.stirrupLbFt, 'steelWeightPerLength')})`,
          warnings: bestRes?.warnings,
          status: bestRes?.status,
        };
      } catch (e) {
        info[m.id] = {
          dcr: 0, dcrFlex: 0, dcrShear: 0,
          top: '—', bot: '—', stirrups: '—',
          error: (e as Error).message,
          status: 'NG',
        };
      }
    }
    return { infoById: info, designResultsById: results };
  }, [deferredMembers, project.code, project.slsCombo, fmtVal, label]);

  const errorMemberIds = useMemo(() => {
    const out = new Set<string>();
    for (const [id, info] of Object.entries(infoById)) {
      if (info.status === 'NG' || info.error || info.warnings?.some(w => w.severity === 'error')) {
        out.add(id);
      }
    }
    return out;
  }, [infoById]);

  const dcrById = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, info] of Object.entries(infoById)) out[id] = info.dcr;
    return out;
  }, [infoById]);

  const diagramDataById = useMemo(() => {
    if (diagramMode === 'off') return {} as Record<string, { x: number; v: number }[]>;
    const out: Record<string, { x: number; v: number }[]> = {};
    for (const m of members) {
      if (!m.stationForces?.length) continue;
      out[m.id] = stationEnvelope(m.stationForces, diagramMode === 'moment' ? 'M' : 'V');
    }
    return out;
  }, [members, diagramMode]);

  const isMetricMode = METRIC_MODES.includes(colorMode);

  // Hotspot metric memos. Steel% / Stirrups / Weight are beam-only; Height / Width
  // cover every member (beams + columns) and are converted to the display length unit.
  const { metricById, metricRange, metricLabel, metricValues } = useMemo(() => {
    if (!METRIC_MODES.includes(colorMode)) {
      return { metricById: undefined, metricRange: undefined, metricLabel: undefined, metricValues: [] as number[] };
    }
    const isDim = colorMode === 'height' || colorMode === 'width';
    const out: Record<string, number> = {};
    const vals: number[] = [];
    let min = Infinity, max = -Infinity;
    for (const m of members) {
      if (!isDim && m.memberType !== 'beam') continue;
      const s = m.section;
      const v = colorMode === 'flexSteel' ? flexSteelRatioPct(m, flexFace)
        : colorMode === 'stirrups' ? stirrupAvPerFt(m)
        : colorMode === 'weight' ? steelWeightPerFt(m).totalLbFt
        : colorMode === 'height' ? toDisplay(s.type === 'circular_column' ? (s.diameter ?? s.b) : s.h, 'length')
        : toDisplay(s.type === 'circular_column' ? (s.diameter ?? s.b) : (s.bw ?? s.b), 'length'); // width
      out[m.id] = v;
      vals.push(v);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return { metricById: undefined, metricRange: undefined, metricLabel: undefined, metricValues: [] as number[] };
    return {
      metricById: out,
      metricRange: { min, max },
      metricValues: vals,
      metricLabel: colorMode === 'flexSteel' ? `ρ${flexFace === 'bot' ? '⁺' : '⁻'} (%)`
        : colorMode === 'stirrups' ? `Av/s (${label('areaPerLength')})`
        : colorMode === 'weight' ? `Steel (${label('steelWeightPerLength')})`
        : colorMode === 'height' ? `h (${label('length')})`
        : `b (${label('length')})`,
    };
  }, [members, colorMode, flexFace, label, toDisplay]);

  // Reset any manual legend bounds when the active metric changes — a range tuned
  // for ρ% would be meaningless for Av/s or weight.
  useEffect(() => { setMetricOverride(null); setLegendKey(null); }, [colorMode, flexFace]);

  // Effective ramp bounds handed to the canvas: user override if set, else auto.
  const effectiveMetricRange = metricRange
    ? (metricOverride ?? metricRange)
    : undefined;

  // Feature ④: memberId → section width (in) for proportional line weight.
  const widthById = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of members) {
      const s = m.section;
      out[m.id] = s.type === 'circular_column' ? (s.diameter ?? s.b) : (s.bw ?? s.b);
    }
    return out;
  }, [members]);

  // Feature ①: frame names of the active group — highlighted on the canvas while
  // every other frame halftones. Undefined when no group is selected.
  const focusFrames = useMemo(() => {
    if (!activeGroupId) return undefined;
    const g = groups.find(gr => gr.id === activeGroupId);
    if (!g) return undefined;
    const s = new Set<string>();
    for (const mid of g.memberIds) { const fn = frameByMemberId.get(mid); if (fn) s.add(fn); }
    return s;
  }, [activeGroupId, groups, frameByMemberId]);

  // Clicking a categorical legend row isolates that entry on the plan — its frames
  // are highlighted, everything else halftones (same visual as a group focus).
  // Resolves the clicked key to member frames for the active mode.
  const legendFocusFrames = useMemo(() => {
    if (!legendKey) return null;
    let memberIds: string[] = [];
    if (colorMode === 'groupTags') {
      memberIds = groups.find(g => g.id === legendKey)?.memberIds ?? [];
    } else if (colorMode === 'concGrade' || colorMode === 'steelGrade') {
      const valOf = (m: (typeof members)[number]) => colorMode === 'concGrade' ? m.material.fc : m.material.fy;
      memberIds = members.filter(m => String(valOf(m)) === legendKey).map(m => m.id);
    } else {
      return null;
    }
    const s = new Set<string>();
    for (const mid of memberIds) { const fn = frameByMemberId.get(mid); if (fn) s.add(fn); }
    return s.size ? s : null;
  }, [legendKey, colorMode, groups, members, frameByMemberId]);

  // Feature ②: categorical colour map + legend for Conc grade (f′c) / Steel grade (f_y).
  const { gradeColorMap, gradeLegend } = useMemo(() => {
    if (colorMode !== 'concGrade' && colorMode !== 'steelGrade') {
      return { gradeColorMap: undefined, gradeLegend: [] as { key: string; label: string; color: string; count: number }[] };
    }
    const si = units === 'si';
    const valOf = (m: (typeof members)[number]) => colorMode === 'concGrade' ? m.material.fc : m.material.fy;
    const labelOf = (v: number) => colorMode === 'concGrade' ? concGradeLabel(v, si) : steelGradeLabel(v, si);
    const distinct = [...new Set(members.map(valOf))].sort((a, b) => a - b);
    const colorByVal = new Map<number, string>();
    distinct.forEach((v, i) => colorByVal.set(v, CATEGORICAL[i % CATEGORICAL.length]));
    const map = new Map<string, string>();
    for (const m of members) map.set(m.id, colorByVal.get(valOf(m))!);
    const legend = distinct.map(v => ({ key: String(v), label: labelOf(v), color: colorByVal.get(v)!, count: members.filter(m => valOf(m) === v).length }));
    return { gradeColorMap: map, gradeLegend: legend };
  }, [colorMode, members, units]);

  // ── In-map Group Dashboard: distilled payload + card-selection focus ───────
  const dashboardPayload = useMemo(
    () => buildDashboardPayload(groups, members, designResultsById, dcrById, project.code, units),
    [groups, members, designResultsById, dcrById, project.code, units],
  );

  // Selecting a card in either split (Dashboard or S-Concrete) isolates that group
  // on the plan (same halftone). Only one split is open at a time.
  const splitFocusGroupId = sconcreteOpen ? sconcreteSelectedGroupId : dashboardOpen ? dashboardSelectedGroupId : null;
  const dashboardFocusFrames = useMemo(() => {
    if (!splitFocusGroupId) return null;
    const g = groups.find(gr => gr.id === splitFocusGroupId);
    if (!g) return null;
    const s = new Set<string>();
    for (const mid of g.memberIds) { const fn = frameByMemberId.get(mid); if (fn) s.add(fn); }
    return s.size ? s : null;
  }, [splitFocusGroupId, groups, frameByMemberId]);

  // Desktop only — the pop-out opens a real second Electron window.
  const canPopOut = typeof window !== 'undefined' && !!window.electronAPI?.openDashboardWindow;

  function applyDashboardRebar(groupId: string, rebar: RebarLayout) {
    const g = groups.find(gr => gr.id === groupId);
    handleApplyRebar(groupId, rebar, g?.memberIds ?? []);
  }

  function onDashDividerDown(e: React.MouseEvent) {
    e.preventDefault();
    const host = dashHostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const frac = Math.min(0.75, Math.max(0.25, (ev.clientX - rect.left) / rect.width));
      setDashboardSplit(frac);
      localStorage.setItem('mapDashboardSplit', String(frac));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ── Pop-out window sync (Electron; no-ops on web) ─────────────────────────
  // Broadcast the (distilled) payload to the popped-out window whenever it changes.
  useEffect(() => {
    if (dashboardPoppedOut) window.electronAPI?.sendDashboardState?.(dashboardPayload);
  }, [dashboardPoppedOut, dashboardPayload]);

  // The dashboard window asks for a resend when it (re)mounts — send current state.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onDashboardReady) return;
    api.onDashboardReady(() => api.sendDashboardState?.(dashboardPayload));
    return () => api.offDashboardReady?.();
  }, [dashboardPayload]);

  // Receive commands from the popped-out window (selection / edits / pop-in) and
  // track when the window closes so the pane flips back in-app.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onDashboardCommand) return;
    api.onDashboardCommand(cmd => {
      if (cmd.type === 'select-group') setDashboardSelectedGroupId(cmd.groupId);
      else if (cmd.type === 'apply-rebar') {
        const g = groups.find(gr => gr.id === cmd.groupId);
        handleApplyRebar(cmd.groupId, cmd.rebar, g?.memberIds ?? []);
      } else if (cmd.type === 'move-member') {
        handleMoveToGroup(cmd.memberId, cmd.groupId);
      } else if (cmd.type === 'create-group-for-member') {
        handleCreateGroupForMember(cmd.memberId);
      } else if (cmd.type === 'suggest-all') {
        handleSuggestAllGroups();
      } else if (cmd.type === 'pop-in') {
        setDashboardPoppedOut(false);
        api.closeDashboardWindow?.();
      }
    });
    api.onDashboardPoppedOut?.(v => setDashboardPoppedOut(v));
    return () => { api.offDashboardCommand?.(); api.offDashboardPoppedOut?.(); };
  }, [groups]);

  // Close the popped-out window if we leave the Map tab (ModelMapView unmounts).
  useEffect(() => () => { window.electronAPI?.closeDashboardWindow?.(); }, []);

  function handleGroupsChange(newGroups: DesignGroup[]) {
    onProjectChange(prev => ({ ...prev, designGroups: newGroups }));
  }

  function handleApplyRebar(groupId: string, rebar: RebarLayout, memberIds: string[]) {
    const memberIdSet = new Set(memberIds);
    onProjectChange(prev => ({
      ...prev,
      designGroups: (prev.designGroups ?? []).map(g => g.id === groupId ? { ...g, rebar } : g),
      members: prev.members.map(m => memberIdSet.has(m.id) ? { ...m, rebar } : m),
    }));
  }

  function handleDeleteGroupWithMembers(groupId: string) {
    const grp = groups.find(g => g.id === groupId);
    if (!grp) return;
    // deleteMembers (App-level) removes the members AND drops any group that
    // becomes empty as a result — all within a single functional setProject,
    // so the group disappears with its members. We must NOT also call
    // onProjectChange here: that runs setProject with a literal object built
    // from the stale `project` prop (still containing the deleted members),
    // which would clobber the deletion and resurrect the beams.
    onDeleteMembers?.(grp.memberIds);
    if (activeGroupId === groupId) setActiveGroupId(null);
  }

  function handleSuggestAllGroups() {
    const target = project.targetDCR ?? 0.9;
    let ok = 0, fail = 0;
    let firstError: string | null = null;
    // Resolve the suggested rebar per group up front; apply it inside the
    // functional update so we never clobber a concurrent member/group edit.
    const rebarByGroupId = new Map<string, RebarLayout>();
    const rebarByMemberId = new Map<string, RebarLayout>();

    for (const g of groups) {
      const membersInGroup = members.filter(m => g.memberIds.includes(m.id));
      const designed = membersInGroup.filter(m => m.memberType === 'beam' && m.loads.length > 0);
      if (!designed.length) continue; // skip empty / no designed beams
      const r = suggestGroupRebar(membersInGroup, project.code, target);
      if (isSuggestError(r)) {
        fail++;
        if (!firstError) firstError = r.error;
        continue;
      }
      ok++;
      rebarByGroupId.set(g.id, r.rebar);
      for (const id of g.memberIds) rebarByMemberId.set(id, r.rebar);
    }

    if (ok > 0) {
      onProjectChange(prev => ({
        ...prev,
        designGroups: (prev.designGroups ?? []).map(g => rebarByGroupId.has(g.id) ? { ...g, rebar: rebarByGroupId.get(g.id)! } : g),
        members: prev.members.map(m => rebarByMemberId.has(m.id) ? { ...m, rebar: rebarByMemberId.get(m.id)! } : m),
      }));
    }
    const total = ok + fail;
    setSuggestAllNote(
      total === 0
        ? 'No groups with designed beams to suggest.'
        : `Suggested ${ok}/${total} groups${fail > 0 ? ` · ${fail} need larger sections${firstError ? ` (${firstError})` : ''}` : ''}`
    );
  }

  function handleAcceptSuggestion(suggested: DesignGroup[]) {
    const manual = groups.filter(g => g.source !== 'auto');
    handleGroupsChange([...manual, ...suggested]);
    setRightTab('groups');
  }

  function handleMergeGroups(keepId: string, removeId: string) {
    const keep = groups.find(g => g.id === keepId);
    const remove = groups.find(g => g.id === removeId);
    if (!keep || !remove) return;
    const merged: DesignGroup = { ...keep, memberIds: [...new Set([...keep.memberIds, ...remove.memberIds])] };
    handleGroupsChange(groups.filter(g => g.id !== removeId).map(g => g.id === keepId ? merged : g));
  }

  const activeGroup = activeGroupId ? groups.find(g => g.id === activeGroupId) : null;
  // A split pane (Dashboard or S-Concrete Verify) occupies the right half of the map;
  // while open, the plan narrows and the 320px right panel + slide-out editor hide.
  const splitPaneOpen = (dashboardOpen && !dashboardPoppedOut) || sconcreteOpen;
  const allStories = map ? map.stories : [];
  const storyDropdownOptions = map ? ['All', ...map.stories] : ['All'];
  const frames = enrichedFrames;

  function handleFrameClick(frameName: string): boolean {
    if (!activeGroupId) return false;
    const frame = frames.find(f => f.frameName === frameName);
    if (!frame?.memberId) return false;
    const mid = frame.memberId;
    const grp = groups.find(g => g.id === activeGroupId);
    if (!grp) return false;
    if (grp.memberIds.includes(mid)) {
      // Remove
      handleGroupsChange(groups.map(g => g.id === activeGroupId ? { ...g, memberIds: g.memberIds.filter(id => id !== mid) } : g));
    } else {
      // Add with exclusivity
      handleGroupsChange(groups.map(g =>
        g.id === activeGroupId
          ? { ...g, memberIds: [...g.memberIds, mid] }
          : { ...g, memberIds: g.memberIds.filter(id => id !== mid) }
      ));
    }
    return true;
  }

  function handleHideBeam(memberId: string) {
    onProjectChange(prev => ({ ...prev, hiddenMemberIds: [...new Set([...(prev.hiddenMemberIds ?? []), memberId])] }));
  }

  function handleDeleteBeam(memberId: string) {
    if (!confirm('Delete this beam permanently? This cannot be undone.')) return;
    onDeleteMember?.(memberId);
  }

  function handleMoveToGroup(memberId: string, groupId: string) {
    handleGroupsChange(groups.map(g =>
      g.id === groupId
        ? { ...g, memberIds: g.memberIds.includes(memberId) ? g.memberIds : [...g.memberIds, memberId] }
        : { ...g, memberIds: g.memberIds.filter(id => id !== memberId) }
    ));
  }

  // Split an outlier beam out into its own new group (removing it from every other
  // group). Used by the dashboard right-click "New group from this beam".
  function handleCreateGroupForMember(memberId: string) {
    const m = members.find(mm => mm.id === memberId);
    const newId = `dg-${Date.now()}`;
    const color = CATEGORICAL[groups.length % CATEGORICAL.length];
    onProjectChange(prev => {
      const existing = (prev.designGroups ?? []).map(g => ({ ...g, memberIds: g.memberIds.filter(id => id !== memberId) }));
      const newGroup: DesignGroup = { id: newId, label: m?.label ?? 'New group', memberIds: [memberId], color, source: 'manual' };
      return { ...prev, designGroups: [...existing, newGroup] };
    });
    setDashboardSelectedGroupId(newId);
  }

  function toggleStoryVisibility(s: string) {
    onProjectChange(prev => {
      const hidden = new Set(prev.hiddenStories ?? []);
      if (hidden.has(s)) hidden.delete(s); else hidden.add(s);
      return { ...prev, hiddenStories: [...hidden] };
    });
  }

  const handleOverlayChange = useCallback((bins: AutoGroupBin[]) => {
    setAutoGroupOverlay(bins);
  }, []);

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '7px 4px', border: 'none', background: active ? 'white' : SURFACE.subtle,
    borderBottom: active ? `2px solid ${ACCENT.primary}` : '2px solid transparent',
    color: active ? ACCENT.primary : INK.secondary, fontWeight: active ? 700 : 500,
    fontSize: 11, cursor: 'pointer', textAlign: 'center',
  });

  const inspectedMember = inspectedMemberId ? members.find(m => m.id === inspectedMemberId) : null;

  if (!map) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, color: INK.secondary }}>
        <div style={{ fontSize: 48 }}>🗺️</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: INK.strong }}>No model map yet</div>
        <div style={{ fontSize: 13 }}>Connect to ETABS or open a tables file to import beams (and columns).</div>
        <button
          onClick={onOpenEtabsImport}
          style={{ padding: '10px 24px', background: ACCENT.primary, color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}
        >
          Connect to ETABS / Import tables
        </button>
        <div style={{ fontSize: 12, color: INK.muted, maxWidth: 380, textAlign: 'center', lineHeight: 1.6 }}>
          Then: <strong style={{ color: INK.secondary }}>①</strong> group members (Groups tab) ·
          <strong style={{ color: INK.secondary }}> ②</strong> design (✨ Suggest) ·
          <strong style={{ color: INK.secondary }}> ③</strong> run the S-Concrete batch ·
          <strong style={{ color: INK.secondary }}> ④</strong> read results back on the map.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flex: 1, height: '100%', minWidth: 0, overflow: 'hidden', position: 'relative' }}>
      <TopProgressBar active={recomputing} />
      {/* Context menu portal */}
      {contextMenu && (
        <BeamContextMenu
          memberId={contextMenu.memberId}
          frameName={contextMenu.frameName}
          x={contextMenu.x}
          y={contextMenu.y}
          groups={groups}
          selectedCount={selectedFrames.size}
          onNavigate={mid => { onPickMember(mid); setContextMenu(null); }}
          onMoveToGroup={(mid, gid) => { handleMoveToGroup(mid, gid); setContextMenu(null); }}
          onHide={mid => { handleHideBeam(mid); setContextMenu(null); }}
          onDelete={mid => { handleDeleteBeam(mid); setContextMenu(null); }}
          onCreateGroupFromSelection={() => {
            const label = window.prompt('Group name:');
            if (label === null) return;
            const color = CATEGORICAL[Math.floor(Math.random() * CATEGORICAL.length)];
            const frame = frames.find(f => f.frameName === contextMenu.frameName);
            const memberIds = [...selectedFrames]
              .map(fname => frames.find(f => f.frameName === fname)?.memberId)
              .filter((id): id is string => !!id);
            const newGroup: DesignGroup = {
              id: `dg-${Date.now()}`,
              label: label.trim() || 'New Group',
              memberIds,
              color,
              source: 'manual',
            };
            onProjectChange(prev => ({ ...prev, designGroups: [...(prev.designGroups ?? []), newGroup] }));
            setSelectedFrames(new Set());
            void frame;
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Plan | Dashboard split host */}
      <div ref={dashHostRef} style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'hidden', position: 'relative' }}>
      {/* Canvas area (plan pane) */}
      <div style={splitPaneOpen
        ? { width: `${dashboardSplit * 100}%`, flexShrink: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12, gap: 8 }
        : { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12, gap: 8 }}>
        {/* Toolbar — clustered: View · Colour · Overlay · Model */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
          {/* Story filter */}
          <Dropdown
            value={story}
            options={storyDropdownOptions.map(s => ({ value: s, label: s }))}
            onChange={setStory}
            style={{ padding: '5px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, background: 'white' }}
          />

          <div style={toolSep} />

          {/* Colour by: one dropdown replaces the 8 mode buttons */}
          <span style={{ fontSize: 11, color: INK.secondary }}>Colour</span>
          <Dropdown
            value={colorMode}
            options={[
              { value: 'dcr', label: 'DCR' },
              { value: 'group', label: 'Design group' },
              { value: 'groupTags', label: 'Group + tags' },
              { value: 'section', label: 'Section' },
              { value: 'flexSteel', label: 'Steel % (ρ)' },
              { value: 'stirrups', label: `Stirrups (${label('areaPerLength')})` },
              { value: 'weight', label: `Steel weight (${label('steelWeightPerLength')})` },
              { value: 'height', label: `Height (${label('length')})` },
              { value: 'width', label: `Width (${label('length')})` },
              { value: 'concGrade', label: 'Conc grade (f′c)' },
              { value: 'steelGrade', label: 'Steel grade (f_y)' },
              { value: 'autoGroup', label: 'Auto-group overlay' },
              { value: 'sconcrete', label: 'S-Concrete pass/fail' },
            ]}
            onChange={v => setColorMode(v as ColorMode)}
            style={{ padding: '5px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, background: 'white', minWidth: 120 }}
          />
          {colorMode === 'flexSteel' && (
            <button onClick={() => setFlexFace(f => f === 'bot' ? 'top' : 'bot')}
              style={{ padding: '5px 10px', border: '1px solid #0891b2', borderRadius: 6, fontSize: 11, cursor: 'pointer', background: '#e0f2fe', color: '#0369a1' }}
              title="Toggle the reinforcement face used for the ratio">
              {flexFace === 'bot' ? 'Bot ↕' : 'Top ↕'}
            </button>
          )}

          <div style={toolSep} />

          {/* Line weight — stroke thickness proportional to beam width */}
          <span style={{ fontSize: 11, color: INK.secondary }}>Line wt</span>
          <input
            type="range" min={0} max={1} step={0.05} value={lineWeightScale}
            onChange={e => setLineWeightScale(parseFloat(e.target.value))}
            title="Line weight — thicker lines for wider beams (0 = uniform)"
            style={{ width: 84, cursor: 'pointer', accentColor: ACCENT.primary }}
          />

          <div style={toolSep} />

          {/* Overlay: diagram + inspect + errors */}
          <div style={{ display: 'flex', gap: 2 }}>
            {(['off', 'moment', 'shear'] as DiagramMode[]).map(m => (
              <button key={m} onClick={() => setDiagramMode(m)}
                style={{ padding: '5px 9px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: diagramMode === m ? '#7c3aed' : 'white', color: diagramMode === m ? 'white' : INK.base }}
                title={m === 'off' ? 'No force-diagram overlay' : m === 'moment' ? 'Moment envelope overlay' : 'Shear envelope overlay'}>
                {m === 'off' ? 'Diag' : m === 'moment' ? 'M' : 'V'}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setInspectMode(m => !m); setInspectedMemberId(null); }}
            style={{ padding: '5px 9px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', background: inspectMode ? '#7c3aed' : 'white', color: inspectMode ? 'white' : INK.base }}
            title="Inspect: click a beam to see its section sketch and V/M diagrams">
            🔍
          </button>
          <button
            onClick={() => setShowErrors(s => !s)}
            style={{ padding: '5px 9px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', background: showErrors ? STATUS.fail : 'white', color: showErrors ? 'white' : INK.base }}
            title="Highlight members with design errors or warnings">
            ⚠
          </button>

          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: INK.muted }}>
            {map.modelName} · {frames.length} frames
          </span>
          <button onClick={onOpenEtabsImport}
            title="Re-import / re-sync from ETABS"
            style={{ padding: '5px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 11, cursor: 'pointer', background: 'white', color: INK.base, fontWeight: 600 }}>
            ↻ Re-sync
          </button>
        </div>

        {/* Story visibility chips */}
        {allStories.length > 1 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flexShrink: 0, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: INK.muted, marginRight: 2 }}>Floors:</span>
            {allStories.map(s => {
              const hidden = hiddenStories.has(s);
              return (
                <button key={s} onClick={() => toggleStoryVisibility(s)}
                  style={{ padding: '2px 8px', borderRadius: 12, border: `1px solid ${BORDER.strong}`, fontSize: 10, cursor: 'pointer', background: hidden ? '#f3f4f6' : ACCENT.softBg, color: hidden ? INK.muted : ACCENT.primary, fontWeight: hidden ? 400 : 600, textDecoration: hidden ? 'line-through' : 'none' }}>
                  {s}
                </button>
              );
            })}
            {hiddenStories.size > 0 && (
              <button onClick={() => onProjectChange(prev => ({ ...prev, hiddenStories: [] }))}
                style={{ padding: '2px 6px', borderRadius: 12, border: '1px solid #fca5a5', fontSize: 10, cursor: 'pointer', background: '#fee2e2', color: STATUS.fail }}>
                Show all
              </button>
            )}
          </div>
        )}

        {/* Group-edit mode banner */}
        {activeGroup && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: ACCENT.softBg, border: `1px solid ${ACCENT.softBorder}`, borderRadius: 6, flexShrink: 0 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: activeGroup.color ?? ACCENT.primary, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: ACCENT.primaryHover, fontWeight: 600 }}>
              Editing <strong>{activeGroup.label}</strong> — click beams to add or remove members
            </span>
            <button onClick={() => setActiveGroupId(null)}
              style={{ marginLeft: 'auto', padding: '3px 10px', background: ACCENT.primary, color: 'white', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
              Done
            </button>
          </div>
        )}

        {/* Map canvas */}
        <div ref={canvasWrapRef} style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <MapCanvas
            frames={frames}
            dcrById={dcrById}
            infoById={infoById}
            designGroups={groups}
            story={story}
            colorMode={colorMode}
            selected={new Set([...selectedFrames, ...highlightedFrames, ...(dashHoverFrame ? [dashHoverFrame] : [])])}
            onSelectionChange={setSelectedFrames}
            onDoubleClick={onPickMember}
            onFrameClick={activeGroup ? handleFrameClick : undefined}
            onBeamInspect={(mid, cx, cy) => {
              const rect = canvasWrapRef.current?.getBoundingClientRect();
              setInspectedMemberId(mid);
              setInspectPos({ x: cx - (rect?.left ?? 0), y: cy - (rect?.top ?? 0) });
            }}
            onBeamContextMenu={(mid, fname, cx, cy) => setContextMenu({ memberId: mid, frameName: fname, x: cx, y: cy })}
            width={canvasSize.w}
            height={canvasSize.h}
            diagramMode={diagramMode}
            diagramDataById={diagramMode !== 'off' ? diagramDataById : undefined}
            metricById={metricById}
            metricRange={effectiveMetricRange}
            metricLabel={metricLabel}
            scoStatusById={scoStatusById}
            autoGroupOverlay={autoGroupOverlay}
            hiddenMemberIds={hiddenMemberIds}
            hiddenStories={hiddenStories}
            inspectMode={inspectMode}
            inspectedMemberId={inspectedMemberId}
            showErrors={showErrors}
            errorMemberIds={errorMemberIds}
            focusFrames={dashboardFocusFrames ?? legendFocusFrames ?? focusFrames}
            lineWeightScale={lineWeightScale}
            widthById={widthById}
            gradeColorMap={gradeColorMap}
          />

          {/* Beam inspect card */}
          {inspectMode && inspectedMember && (
            <BeamInspectCard
              member={inspectedMember}
              designResults={designResultsById[inspectedMember.id]}
              code={project.code}
              clientX={inspectPos.x}
              clientY={inspectPos.y}
              containerWidth={canvasSize.w}
              containerHeight={canvasSize.h}
              onClose={() => setInspectedMemberId(null)}
            />
          )}

          {/* Metric legend + histogram panel — refine the color ramp and see the
              distribution of Steel% / Stirrups / Weight right on the map. */}
          {isMetricMode && metricRange && metricValues.length > 0 && (
            <MetricLegendPanel
              label={metricLabel ?? ''}
              values={metricValues}
              autoRange={metricRange}
              override={metricOverride}
              onOverrideChange={setMetricOverride}
              showHistogram={showMetricHistogram}
              onToggleHistogram={() => setShowMetricHistogram(s => !s)}
            />
          )}

          {/* Categorical legend — concrete/steel grade, or numbered design groups.
              Rows are clickable: click one to isolate it on the plan (halftone the rest). */}
          {(colorMode === 'concGrade' || colorMode === 'steelGrade') && gradeLegend.length > 0 && (
            <CategoricalLegend
              title={colorMode === 'concGrade' ? 'Concrete grade' : 'Steel grade'}
              rows={gradeLegend}
              activeKey={legendKey}
              onRowClick={k => setLegendKey(prev => prev === k ? null : k)}
            />
          )}
          {colorMode === 'groupTags' && (
            <CategoricalLegend
              title="Design groups"
              rows={groups.map((g, i) => ({ key: g.id, index: i + 1, label: g.label, color: groupColor(g.color, i), count: g.memberIds.length }))}
              activeKey={legendKey}
              onRowClick={k => setLegendKey(prev => prev === k ? null : k)}
            />
          )}
        </div>
      </div>

      {/* Dashboard pane — right half of the split (feature: in-map Group Dashboard) */}
      {dashboardOpen && !dashboardPoppedOut && (
        <>
          <div onMouseDown={onDashDividerDown} title="Drag to resize plan / dashboard"
            style={{ width: 8, flexShrink: 0, cursor: 'col-resize', background: '#eef2f7', borderLeft: '1px solid #e2e8f0', borderRight: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 3, height: 40, borderRadius: 2, background: '#cbd5e1' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
            <GroupDashboard
              payload={dashboardPayload}
              selectedGroupId={dashboardSelectedGroupId}
              onSelectGroup={setDashboardSelectedGroupId}
              onApplyRebar={applyDashboardRebar}
              onOpenMember={onPickMember}
              onHoverMember={mid => setDashHoverFrame(mid ? (frameByMemberId.get(mid) ?? null) : null)}
              onMoveMember={handleMoveToGroup}
              onCreateGroupForMember={handleCreateGroupForMember}
              onSuggestAll={handleSuggestAllGroups}
              canPopOut={canPopOut}
              onPopOut={() => { setDashboardPoppedOut(true); window.electronAPI?.openDashboardWindow?.(); }}
              onClose={() => setDashboardOpen(false)}
            />
          </div>
        </>
      )}
      {dashboardOpen && dashboardPoppedOut && (
        <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 30, display: 'flex', alignItems: 'center', gap: 8, background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 8, padding: '6px 10px', boxShadow: '0 2px 10px rgba(0,0,0,0.08)', fontSize: 12, color: INK.secondary }}>
          <span>📊 Dashboard in a separate window</span>
          <button onClick={() => { setDashboardPoppedOut(false); window.electronAPI?.closeDashboardWindow?.(); }}
            style={{ padding: '4px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, background: 'white', cursor: 'pointer', fontWeight: 600, color: INK.base }}>⤡ Pop in</button>
        </div>
      )}

      {/* S-Concrete Verify pane — right half of the split (mirrors the Group Dashboard) */}
      {sconcreteOpen && (
        <>
          <div onMouseDown={onDashDividerDown} title="Drag to resize plan / S-Concrete"
            style={{ width: 8, flexShrink: 0, cursor: 'col-resize', background: '#eef2f7', borderLeft: '1px solid #e2e8f0', borderRight: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 3, height: 40, borderRadius: 2, background: '#cbd5e1' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
            <SconcreteDashboard
              payload={dashboardPayload}
              project={project}
              frameByMemberId={frameByMemberId}
              onProjectChange={onProjectChange}
              selectedGroupId={sconcreteSelectedGroupId}
              onSelectGroup={setSconcreteSelectedGroupId}
              onOpenMember={onPickMember}
              onClose={() => setSconcreteOpen(false)}
            />
          </div>
        </>
      )}
      </div>
      {/* end Plan | Dashboard split host */}

      {/* Reinforcement editor — slides out as its own column between the map and the
          right panel whenever a group is active, so the cage is visible without
          scrolling the Design pane. Dismiss with ✕ or by re-clicking the group row.
          The map (flex:1) narrows and its ResizeObserver re-fits the canvas. */}
      {!dashboardOpen && !sconcreteOpen && activeGroup && (
        <div style={{ width: 320, flexShrink: 0, borderLeft: `1px solid ${BORDER.default}`, display: 'flex', flexDirection: 'column', background: SURFACE.raised, overflow: 'hidden', animation: 'slideInCol 160ms ease-out' }}>
          <div style={{ ...sectionHdr, justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeGroup.label} · Reinforcement</span>
            <button title="Close editor" onClick={() => setActiveGroupId(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: INK.secondary, fontSize: 13, lineHeight: 1, padding: 2, flexShrink: 0 }}>✕</button>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <GroupRebarEditor
              group={activeGroup}
              members={members.filter(m => activeGroup.memberIds.includes(m.id))}
              onApply={handleApplyRebar}
              code={project.code}
              targetDCR={project.targetDCR ?? 0.9}
            />
            {members.some(m => activeGroup.memberIds.includes(m.id) && m.memberType === 'column') && (
              <ColumnForceGrid
                members={members.filter(m => activeGroup.memberIds.includes(m.id))}
                onProjectChange={onProjectChange}
              />
            )}
          </div>
        </div>
      )}

      {/* Right panel */}
      <div style={{ width: 320, flexShrink: 0, borderLeft: `1px solid ${BORDER.default}`, display: (dashboardOpen || sconcreteOpen) ? 'none' : 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' }}>
        {/* Tab bar — the workflow (Design, then the two split dashboards) is primary;
            read-only analytics are tucked behind an "Analyze" picker. */}
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${BORDER.default}`, background: SURFACE.subtle, paddingRight: 6 }}>
          <button style={tabStyle(rightTab === 'groups')} onClick={() => setRightTab('groups')}
            title="Group members on the map and design their cage">① Design</button>
          <button style={tabStyle(false)} onClick={() => { setDashboardOpen(true); setSconcreteOpen(false); setRightTab('groups'); }}
            title="Open the Group Dashboard — section cards + per-group DCR table, split beside the plan">📊 Dashboard</button>
          <button style={tabStyle(false)} onClick={() => { setSconcreteOpen(true); setDashboardOpen(false); setRightTab('groups'); }}
            title="Open the S-Concrete Verify dashboard — push & run the batch, read results per group, split beside the plan">🔬 Verify</button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: INK.muted, marginRight: 4 }}>Analyze:</span>
          <Dropdown
            value={rightTab === 'groups' ? '' : rightTab}
            options={[
              { value: '', label: '—' },
              { value: 'autogroup', label: 'Auto-group' },
              { value: 'savings', label: 'Savings' },
              { value: 'takeoff', label: 'Takeoff' },
            ]}
            onChange={v => setRightTab((v || 'groups') as RightTab)}
            style={{ padding: '4px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 6, fontSize: 11, background: 'white', margin: '4px 0' }}
          />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {rightTab === 'groups' && (
            /* ① Design fills the pane; ② Verify (the S-Concrete batch) now lives in the
               🔬 Verify split dashboard, reached from the footer button below or the tab. */
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                {/* ① DESIGN — group members, then set or ✨-suggest the cage. The active
                    group's rebar editor opens as a slide-out column beside this panel. */}
                <div style={sectionHdr}>① Design<span style={sectionHint}>group members on the map, then set or ✨-suggest the cage</span><div style={{ flex: 1 }} /><HelpLink section="design" title="How grouping & the cage work" /></div>
                <GroupPanel
                  groups={groups}
                  frames={frames}
                  selected={selectedFrames}
                  activeGroupId={activeGroupId}
                  onGroupsChange={handleGroupsChange}
                  onActiveGroupChange={setActiveGroupId}
                  onSelectionChange={setSelectedFrames}
                  dcrById={dcrById}
                  designResultsById={designResultsById}
                  members={members}
                  onDeleteGroupWithMembers={onDeleteMembers ? handleDeleteGroupWithMembers : undefined}
                  onSuggestAll={handleSuggestAllGroups}
                  suggestAllNote={suggestAllNote}
                />
              </div>
              {/* ② VERIFY — opens the S-Concrete dashboard split beside the plan. */}
              <button
                onClick={() => { setSconcreteOpen(true); setDashboardOpen(false); }}
                title="Open the S-Concrete Verify dashboard beside the plan — push & run the batch, read results per group"
                style={{ display: 'flex', alignItems: 'baseline', gap: 6, width: '100%', textAlign: 'left', border: 'none', borderTop: `1px solid ${BORDER.default}`, background: SURFACE.subtle, padding: '9px 10px', cursor: 'pointer', flexShrink: 0 }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: INK.strong }}>② Verify</span>
                <span style={sectionHint}>run the S-Concrete batch · results per group</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: ACCENT.primary }}>🔬 Open →</span>
              </button>
            </div>
          )}

          {rightTab !== 'groups' && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {rightTab === 'autogroup' && (
                <AutoGroupPanel
                  members={members}
                  onHighlightChange={setHighlightedFrames}
                  onApplySuggestion={handleAcceptSuggestion}
                  onOverlayChange={handleOverlayChange}
                />
              )}

              {rightTab === 'savings' && (
                <SavingsPanel
                  members={members}
                  resultsById={designResultsById}
                  designGroups={groups}
                  onMergeGroups={handleMergeGroups}
                  targetDCR={project.targetDCR ?? 0.9}
                  onTargetDCRChange={v => onProjectChange(prev => ({ ...prev, targetDCR: v }))}
                />
              )}

              {rightTab === 'takeoff' && (
                <TakeoffPanel members={members} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Metric legend + histogram (floating on the map) ───────────────────────────

/** Numeric input with a local string draft so the user can type freely. */
function RangeInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  function commit() {
    const n = parseFloat(draft);
    if (Number.isFinite(n)) onCommit(n);
    else setDraft(String(value));
  }
  return (
    <input
      type="number"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
      style={{ width: 60, padding: '2px 5px', border: `1px solid ${BORDER.strong}`, borderRadius: 4, fontSize: 11, ...MONO_NUM }}
    />
  );
}

/** Compact top-right legend for categorical color modes (grade / numbered groups). */
function CategoricalLegend({ title, rows, activeKey, onRowClick }: {
  title: string;
  rows: { key: string; label: string; color: string; count: number; index?: number }[];
  activeKey?: string | null;
  onRowClick?: (key: string) => void;
}) {
  const clickable = !!onRowClick;
  return (
    <div style={{
      position: 'absolute', top: 8, right: 8, width: 210, maxHeight: '70%', overflowY: 'auto',
      background: 'white', borderRadius: 8, padding: '8px 10px', border: `1px solid ${BORDER.default}`,
      boxShadow: '0 2px 10px rgba(0,0,0,0.08)', fontSize: 11, color: INK.base, zIndex: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, color: INK.strong }}>{title}</span>
        {clickable && activeKey != null && (
          <button onClick={() => onRowClick!(activeKey)} title="Show all again"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: ACCENT.primary, fontSize: 10, fontWeight: 600, padding: 0 }}>
            Clear
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {rows.map(r => {
          const isActive = activeKey === r.key;
          const dim = clickable && activeKey != null && !isActive;
          return (
            <div key={r.key}
              onClick={clickable ? () => onRowClick!(r.key) : undefined}
              title={clickable ? 'Click to isolate on the plan' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px', borderRadius: 5,
                cursor: clickable ? 'pointer' : 'default',
                background: isActive ? ACCENT.softBg : 'transparent',
                opacity: dim ? 0.45 : 1,
              }}
              onMouseEnter={clickable ? e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = SURFACE.subtle; } : undefined}
              onMouseLeave={clickable ? e => { (e.currentTarget as HTMLDivElement).style.background = isActive ? ACCENT.softBg : 'transparent'; } : undefined}
            >
              {r.index !== undefined && <span style={{ ...MONO_NUM, width: 14, textAlign: 'right', color: INK.muted, fontWeight: 700 }}>{r.index}</span>}
              <span style={{ width: 14, height: 12, borderRadius: 3, background: r.color, flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
              <span style={{ color: INK.muted }}>({r.count})</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface MetricLegendPanelProps {
  label: string;
  values: number[];
  autoRange: { min: number; max: number };
  override: { min: number; max: number } | null;
  onOverrideChange: (r: { min: number; max: number } | null) => void;
  showHistogram: boolean;
  onToggleHistogram: () => void;
}

function MetricLegendPanel({
  label, values, autoRange, override, onOverrideChange, showHistogram, onToggleHistogram,
}: MetricLegendPanelProps) {
  const range = override ?? autoRange;
  // Percentile presets help the user clip outliers so the ramp spreads over the
  // bulk of the data (where the interesting variation lives).
  function percentile(p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
  }
  function setMin(v: number) { onOverrideChange({ min: v, max: Math.max(v + 1e-6, range.max) }); }
  function setMax(v: number) { onOverrideChange({ min: Math.min(range.min, v - 1e-6), max: v }); }
  function applyPercentiles(lo: number, hi: number) {
    onOverrideChange({ min: percentile(lo), max: percentile(hi) });
  }

  return (
    <div style={{
      position: 'absolute', top: 8, right: 8, width: 250, background: 'white',
      borderRadius: 8, padding: '8px 10px', border: `1px solid ${BORDER.default}`,
      boxShadow: '0 2px 10px rgba(0,0,0,0.08)', fontSize: 11, color: INK.base, zIndex: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, color: INK.strong }}>{label}</span>
        <button onClick={onToggleHistogram}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: INK.secondary, fontSize: 10, padding: 0 }}>
          {showHistogram ? 'Hide ▴' : 'Histogram ▾'}
        </button>
      </div>

      {showHistogram && (
        <HistogramPanel
          values={values}
          rampMode
          rampMin={range.min}
          rampMax={range.max}
          breaks={override ? [range.min, range.max] : []}
          xLabel={label}
          valueDecimals={2}
        />
      )}

      {/* Ramp gradient bar */}
      <div style={{
        height: 10, borderRadius: 4, marginTop: 6, overflow: 'hidden',
        background: `linear-gradient(to right, ${rampStops(range.min, range.max).map(s => s.color).join(',')})`,
      }} />

      {/* Min / Max range controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 6 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: INK.muted }}>
          MIN
          <RangeInput value={range.min} onCommit={setMin} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: INK.muted, alignItems: 'flex-end' }}>
          MAX
          <RangeInput value={range.max} onCommit={setMax} />
        </label>
      </div>

      {/* Quick presets */}
      <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
        <button onClick={() => applyPercentiles(5, 95)}
          style={presetBtn} title="Clip to the 5th–95th percentile to suppress outliers">5–95%</button>
        <button onClick={() => applyPercentiles(10, 90)}
          style={presetBtn} title="Clip to the 10th–90th percentile">10–90%</button>
        <button onClick={() => onOverrideChange(null)}
          style={{ ...presetBtn, marginLeft: 'auto', color: override ? STATUS.fail : INK.muted, borderColor: override ? '#fca5a5' : BORDER.default }}
          disabled={!override}>
          Auto
        </button>
      </div>
      <div style={{ fontSize: 10, color: INK.muted, marginTop: 4 }}>
        Full data: {autoRange.min.toFixed(2)} – {autoRange.max.toFixed(2)} · {values.length} beams
      </div>
    </div>
  );
}

const toolSep: React.CSSProperties = { width: 1, height: 20, background: BORDER.default, margin: '0 2px', flexShrink: 0 };
const sectionHdr: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: INK.strong, padding: '8px 10px 4px', background: SURFACE.subtle, borderBottom: '1px solid #eef2f7', display: 'flex', alignItems: 'baseline', gap: 6, flexShrink: 0 };
const sectionHint: React.CSSProperties = { fontSize: 10, fontWeight: 400, color: INK.muted };

const presetBtn: React.CSSProperties = {
  padding: '2px 7px', border: `1px solid ${BORDER.strong}`, borderRadius: 5,
  background: 'white', color: INK.base, fontSize: 10, cursor: 'pointer', fontWeight: 600,
};
