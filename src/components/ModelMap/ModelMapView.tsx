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
import AutoGroupPanel from './AutoGroupPanel';
import TopProgressBar from '../common/TopProgressBar';
import HistogramPanel from './HistogramPanel';
import { rampStops } from './colorRamp';
import SavingsPanel from './SavingsPanel';
import BeamContextMenu from './BeamContextMenu';
import BeamInspectCard from './BeamInspectCard';
import { useUnits } from '../../contexts/UnitsContext';
import Dropdown from '../common/Dropdown';

type RightTab = 'groups' | 'autogroup' | 'savings';
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

export default function ModelMapView({ project, onProjectChange, onOpenEtabsImport, onPickMember, onDeleteMember, onDeleteMembers }: Props) {
  const { fmtVal, label } = useUnits();
  const [selectedFrames, setSelectedFrames] = useState<Set<string>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('dcr');
  const [flexFace, setFlexFace] = useState<FlexFace>('bot');
  const [story, setStory] = useState<string>('All');
  const [diagramMode, setDiagramMode] = useState<DiagramMode>('off');
  const [rightTab, setRightTab] = useState<RightTab>('groups');
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

  const map = project.modelMap;
  const groups = project.designGroups ?? [];
  const members = project.members;
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

  const isMetricMode = colorMode === 'flexSteel' || colorMode === 'stirrups' || colorMode === 'weight';

  // Hotspot metric memos
  const { metricById, metricRange, metricLabel, metricValues } = useMemo(() => {
    if (colorMode !== 'flexSteel' && colorMode !== 'stirrups' && colorMode !== 'weight') {
      return { metricById: undefined, metricRange: undefined, metricLabel: undefined, metricValues: [] as number[] };
    }
    const out: Record<string, number> = {};
    const vals: number[] = [];
    let min = Infinity, max = -Infinity;
    for (const m of members) {
      if (m.memberType !== 'beam') continue;
      const v = colorMode === 'flexSteel' ? flexSteelRatioPct(m, flexFace)
        : colorMode === 'stirrups' ? stirrupAvPerFt(m)
        : steelWeightPerFt(m).totalLbFt;
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
        : `Steel (${label('steelWeightPerLength')})`,
    };
  }, [members, colorMode, flexFace, label]);

  // Reset any manual legend bounds when the active metric changes — a range tuned
  // for ρ% would be meaningless for Av/s or weight.
  useEffect(() => { setMetricOverride(null); }, [colorMode, flexFace]);

  // Effective ramp bounds handed to the canvas: user override if set, else auto.
  const effectiveMetricRange = metricRange
    ? (metricOverride ?? metricRange)
    : undefined;

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
    flex: 1, padding: '7px 4px', border: 'none', background: active ? 'white' : '#f9fafb',
    borderBottom: active ? '2px solid #2563eb' : '2px solid transparent',
    color: active ? '#2563eb' : '#6b7280', fontWeight: active ? 700 : 500,
    fontSize: 11, cursor: 'pointer', textAlign: 'center',
  });

  const inspectedMember = inspectedMemberId ? members.find(m => m.id === inspectedMemberId) : null;

  if (!map) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, color: '#6b7280' }}>
        <div style={{ fontSize: 48 }}>🗺️</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>No model map yet</div>
        <div style={{ fontSize: 13 }}>Connect to ETABS or open a tables file to import the connectivity map.</div>
        <button
          onClick={onOpenEtabsImport}
          style={{ padding: '10px 24px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}
        >
          Connect to ETABS / Import tables
        </button>
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
            const colors = ['#2563eb','#16a34a','#d97706','#9333ea','#0891b2','#dc2626'];
            const color = colors[Math.floor(Math.random() * colors.length)];
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

      {/* Canvas area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12, gap: 8 }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
          <Dropdown
            value={story}
            options={storyDropdownOptions.map(s => ({ value: s, label: s }))}
            onChange={setStory}
            style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: 'white' }}
          />

          {/* Color mode buttons */}
          <div style={{ display: 'flex', gap: 2 }}>
            {(['dcr', 'group', 'section'] as ColorMode[]).map(mode => (
              <button key={mode} onClick={() => setColorMode(mode)}
                style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: colorMode === mode ? '#2563eb' : 'white', color: colorMode === mode ? 'white' : '#374151' }}>
                {mode === 'dcr' ? 'DCR' : mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>

          {/* Hotspot modes */}
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              onClick={() => setColorMode(colorMode === 'flexSteel' ? 'dcr' : 'flexSteel')}
              style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: colorMode === 'flexSteel' ? '#0891b2' : 'white', color: colorMode === 'flexSteel' ? 'white' : '#374151' }}
              title="Longitudinal reinforcement ratio ρ (top or bottom face)">
              Steel %
            </button>
            {colorMode === 'flexSteel' && (
              <button onClick={() => setFlexFace(f => f === 'bot' ? 'top' : 'bot')}
                style={{ padding: '5px 10px', border: '1px solid #0891b2', borderRadius: 6, fontSize: 11, cursor: 'pointer', background: '#e0f2fe', color: '#0369a1' }}>
                {flexFace === 'bot' ? 'Bot ↕' : 'Top ↕'}
              </button>
            )}
            <button
              onClick={() => setColorMode(colorMode === 'stirrups' ? 'dcr' : 'stirrups')}
              style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: colorMode === 'stirrups' ? '#0891b2' : 'white', color: colorMode === 'stirrups' ? 'white' : '#374151' }}
              title={`Stirrup area per unit length Av/s (${label('areaPerLength')})`}>
              Stirrups
            </button>
            <button
              onClick={() => setColorMode(colorMode === 'weight' ? 'dcr' : 'weight')}
              style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: colorMode === 'weight' ? '#0891b2' : 'white', color: colorMode === 'weight' ? 'white' : '#374151' }}
              title={`Total steel weight intensity, longitudinal + stirrups (${label('steelWeightPerLength')} of beam)`}>
              {label('steelWeightPerLength')}
            </button>
            <button
              onClick={() => setColorMode(colorMode === 'autoGroup' ? 'dcr' : 'autoGroup')}
              style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: colorMode === 'autoGroup' ? '#f59e0b' : 'white', color: colorMode === 'autoGroup' ? 'white' : '#374151' }}
              title="Auto-group reference overlay (from Auto-Group tab)">
              Auto-G
            </button>
          </div>

          {/* Diagram toggle */}
          <div style={{ display: 'flex', gap: 2, marginLeft: 4 }}>
            {(['off', 'moment', 'shear'] as DiagramMode[]).map(m => (
              <button key={m} onClick={() => setDiagramMode(m)}
                style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: diagramMode === m ? '#7c3aed' : 'white', color: diagramMode === m ? 'white' : '#374151' }}>
                {m === 'off' ? 'Diag Off' : m === 'moment' ? 'M' : 'V'}
              </button>
            ))}
          </div>

          {/* Inspect mode toggle */}
          <button
            onClick={() => { setInspectMode(m => !m); setInspectedMemberId(null); }}
            style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: inspectMode ? '#7c3aed' : 'white', color: inspectMode ? 'white' : '#374151' }}
            title="Click a beam to inspect section sketch and V/M diagrams">
            🔍 Inspect
          </button>

          {/* Error highlight toggle */}
          <button
            onClick={() => setShowErrors(s => !s)}
            style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: showErrors ? '#dc2626' : 'white', color: showErrors ? 'white' : '#374151' }}
            title="Highlight beams with design errors or warnings">
            ⚠ Errors
          </button>

          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {map.modelName} · {frames.length} frames · {new Date(map.importedAt).toLocaleDateString()}
          </span>
          <button onClick={onOpenEtabsImport}
            style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, cursor: 'pointer', background: 'white', color: '#374151', fontWeight: 600 }}>
            ↻ Re-sync
          </button>
        </div>

        {/* Story visibility chips */}
        {allStories.length > 1 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flexShrink: 0, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: '#9ca3af', marginRight: 2 }}>Floors:</span>
            {allStories.map(s => {
              const hidden = hiddenStories.has(s);
              return (
                <button key={s} onClick={() => toggleStoryVisibility(s)}
                  style={{ padding: '2px 8px', borderRadius: 12, border: '1px solid #d1d5db', fontSize: 10, cursor: 'pointer', background: hidden ? '#f3f4f6' : '#eff6ff', color: hidden ? '#9ca3af' : '#2563eb', fontWeight: hidden ? 400 : 600, textDecoration: hidden ? 'line-through' : 'none' }}>
                  {s}
                </button>
              );
            })}
            {hiddenStories.size > 0 && (
              <button onClick={() => onProjectChange(prev => ({ ...prev, hiddenStories: [] }))}
                style={{ padding: '2px 6px', borderRadius: 12, border: '1px solid #fca5a5', fontSize: 10, cursor: 'pointer', background: '#fee2e2', color: '#dc2626' }}>
                Show all
              </button>
            )}
          </div>
        )}

        {/* Group-edit mode banner */}
        {activeGroup && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, flexShrink: 0 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: activeGroup.color ?? '#2563eb', display: 'inline-block', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: '#1d4ed8', fontWeight: 600 }}>
              Editing <strong>{activeGroup.label}</strong> — click beams to add or remove members
            </span>
            <button onClick={() => setActiveGroupId(null)}
              style={{ marginLeft: 'auto', padding: '3px 10px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
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
            selected={new Set([...selectedFrames, ...highlightedFrames])}
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
            autoGroupOverlay={autoGroupOverlay}
            hiddenMemberIds={hiddenMemberIds}
            hiddenStories={hiddenStories}
            inspectMode={inspectMode}
            inspectedMemberId={inspectedMemberId}
            showErrors={showErrors}
            errorMemberIds={errorMemberIds}
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
        </div>
      </div>

      {/* Right panel */}
      <div style={{ width: 320, flexShrink: 0, borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' }}>
        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', background: '#f9fafb' }}>
          <button style={tabStyle(rightTab === 'groups')} onClick={() => setRightTab('groups')}>Groups</button>
          <button style={tabStyle(rightTab === 'autogroup')} onClick={() => setRightTab('autogroup')}>Auto-Group</button>
          <button style={tabStyle(rightTab === 'savings')} onClick={() => setRightTab('savings')}>Savings</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {rightTab === 'groups' && (
            <>
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
              {activeGroup && (
                <GroupRebarEditor
                  group={activeGroup}
                  members={members.filter(m => activeGroup.memberIds.includes(m.id))}
                  onApply={handleApplyRebar}
                  code={project.code}
                  targetDCR={project.targetDCR ?? 0.9}
                />
              )}
            </>
          )}

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
      style={{ width: 60, padding: '2px 5px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 11, fontFamily: 'monospace' }}
    />
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
      borderRadius: 8, padding: '8px 10px', border: '1px solid #e5e7eb',
      boxShadow: '0 2px 10px rgba(0,0,0,0.08)', fontSize: 11, color: '#374151', zIndex: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, color: '#111827' }}>{label}</span>
        <button onClick={onToggleHistogram}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 10, padding: 0 }}>
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
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9, color: '#9ca3af' }}>
          MIN
          <RangeInput value={range.min} onCommit={setMin} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9, color: '#9ca3af', alignItems: 'flex-end' }}>
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
          style={{ ...presetBtn, marginLeft: 'auto', color: override ? '#dc2626' : '#9ca3af', borderColor: override ? '#fca5a5' : '#e5e7eb' }}
          disabled={!override}>
          Auto
        </button>
      </div>
      <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 4 }}>
        Full data: {autoRange.min.toFixed(2)} – {autoRange.max.toFixed(2)} · {values.length} beams
      </div>
    </div>
  );
}

const presetBtn: React.CSSProperties = {
  padding: '2px 7px', border: '1px solid #d1d5db', borderRadius: 5,
  background: 'white', color: '#374151', fontSize: 10, cursor: 'pointer', fontWeight: 600,
};
