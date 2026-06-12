/**
 * ModelMapView — top-level Map tab: canvas (left) + tabbed right panel
 * (Groups | Auto-Group | Savings).
 */
import { useState, useMemo, useRef, useLayoutEffect } from 'react';
import type { Project, Member, DesignGroup, RebarLayout, ComboForces, DesignResults } from '../../types';
import { runDesign } from '../../engines';
import { formatBarLabel } from '../../utils/rebar';
import { flexSteelRatioPct, stirrupAvPerFt, steelWeightPerFt } from '../../utils/autoGroup';
import MapCanvas, { type ColorMode, type FrameInfo, type DiagramMode } from './MapCanvas';
import GroupPanel from './GroupPanel';
import GroupRebarEditor from './GroupRebarEditor';
import AutoGroupPanel from './AutoGroupPanel';
import SavingsPanel from './SavingsPanel';

type RightTab = 'groups' | 'autogroup' | 'savings';
type FlexFace = 'top' | 'bot';

interface Props {
  project: Project;
  onProjectChange: (p: Project) => void;
  onOpenEtabsImport: () => void;
  onPickMember: (memberId: string) => void;
}

/** Build "2-#8 + 3-#6" style rebar string from layers. */
function rebarStr(bars: { numBars: number; barSize: number }[]): string {
  return bars.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join(' + ');
}

/** Build stirrup string: "#4 @ 6 in" or "#4 @ 6/12/6 in". */
function stirrupStr(rebar: { ties?: { barSize: number; spacing: number; legs: number }; tieZones?: { spacing: number }[] }): string {
  const t = rebar.ties;
  if (!t) return '—';
  const bar = formatBarLabel(t.barSize);
  if (rebar.tieZones) {
    return `${bar} @ ${rebar.tieZones.map(z => z.spacing).join('/')} in`;
  }
  return `${bar} @ ${t.spacing} in`;
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

export default function ModelMapView({ project, onProjectChange, onOpenEtabsImport, onPickMember }: Props) {
  const [selectedFrames, setSelectedFrames] = useState<Set<string>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('dcr');
  const [flexFace, setFlexFace] = useState<FlexFace>('bot');
  const [story, setStory] = useState<string>('All');
  const [diagramMode, setDiagramMode] = useState<DiagramMode>('off');
  const [rightTab, setRightTab] = useState<RightTab>('groups');
  const [highlightedFrames, setHighlightedFrames] = useState<Set<string>>(new Set());

  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 900, h: 600 });
  useLayoutEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      if (r.width > 50 && r.height > 50) setCanvasSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const map = project.modelMap;
  const groups = project.designGroups ?? [];
  const members = project.members;

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
    for (const m of members) {
      if (m.memberType !== 'beam' || !m.loads.length) continue;
      try {
        let dcrFlex = 0, dcrShear = 0;
        let bestRes: DesignResults | null = null;
        for (const l of m.loads) {
          const r = runDesign(m.section, m.material, m.rebar, l, m.span, project.code, m.crackParams);
          const govDCR = Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear);
          if (!bestRes || govDCR > Math.max(bestRes.DCR_flex_pos, bestRes.DCR_flex_neg, bestRes.DCR_shear)) bestRes = r;
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
          stirrups: stirrupStr(m.rebar),
          weight: `${w.totalLbFt.toFixed(1)} lb/ft (L ${w.longLbFt.toFixed(1)} + S ${w.stirrupLbFt.toFixed(1)})`,
        };
      } catch (e) {
        info[m.id] = {
          dcr: 0, dcrFlex: 0, dcrShear: 0,
          top: '—', bot: '—', stirrups: '—',
          error: (e as Error).message,
        };
      }
    }
    return { infoById: info, designResultsById: results };
  }, [members, project.code]);

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

  // Hotspot metric memos
  const { metricById, metricRange, metricLabel } = useMemo(() => {
    if (colorMode !== 'flexSteel' && colorMode !== 'stirrups' && colorMode !== 'weight') {
      return { metricById: undefined, metricRange: undefined, metricLabel: undefined };
    }
    const out: Record<string, number> = {};
    let min = Infinity, max = -Infinity;
    for (const m of members) {
      if (m.memberType !== 'beam') continue;
      const v = colorMode === 'flexSteel' ? flexSteelRatioPct(m, flexFace)
        : colorMode === 'stirrups' ? stirrupAvPerFt(m)
        : steelWeightPerFt(m).totalLbFt;
      out[m.id] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return { metricById: undefined, metricRange: undefined, metricLabel: undefined };
    return {
      metricById: out,
      metricRange: { min, max },
      metricLabel: colorMode === 'flexSteel' ? `ρ${flexFace === 'bot' ? '⁺' : '⁻'} (%)`
        : colorMode === 'stirrups' ? 'Av/s (in²/ft)'
        : 'Steel (lb/ft)',
    };
  }, [members, colorMode, flexFace]);

  function handleGroupsChange(newGroups: DesignGroup[]) {
    onProjectChange({ ...project, designGroups: newGroups });
  }

  function handleApplyRebar(groupId: string, rebar: RebarLayout, memberIds: string[]) {
    const newGroups = groups.map(g => g.id === groupId ? { ...g, rebar } : g);
    const newMembers = members.map(m =>
      memberIds.includes(m.id) ? { ...m, rebar } : m
    );
    onProjectChange({ ...project, designGroups: newGroups, members: newMembers });
  }

  function handleAcceptSuggestion(suggested: DesignGroup[]) {
    // Keep manual groups; replace all auto groups with the new suggestions
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
  const stories = map ? ['All', ...map.stories] : ['All'];
  const frames = enrichedFrames;

  function handleFrameClick(frameName: string): boolean {
    if (!activeGroupId) return false;
    const frame = frames.find(f => f.frameName === frameName);
    if (!frame?.memberId) return false;
    const mid = frame.memberId;
    const grp = groups.find(g => g.id === activeGroupId);
    if (!grp) return false;
    const next = grp.memberIds.includes(mid)
      ? grp.memberIds.filter(id => id !== mid)
      : [...grp.memberIds, mid];
    handleGroupsChange(groups.map(g => g.id === activeGroupId ? { ...g, memberIds: next } : g));
    return true;
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '7px 4px', border: 'none', background: active ? 'white' : '#f9fafb',
    borderBottom: active ? '2px solid #2563eb' : '2px solid transparent',
    color: active ? '#2563eb' : '#6b7280', fontWeight: active ? 700 : 500,
    fontSize: 11, cursor: 'pointer', textAlign: 'center',
  });

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
    <div style={{ display: 'flex', flex: 1, height: '100%', minWidth: 0, overflow: 'hidden' }}>
      {/* Canvas area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12, gap: 8 }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
          <select value={story} onChange={e => setStory(e.target.value)}
            style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: 'white' }}>
            {stories.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

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
              title="Stirrup area per unit length Av/s (in²/ft)">
              Stirrups
            </button>
            <button
              onClick={() => setColorMode(colorMode === 'weight' ? 'dcr' : 'weight')}
              style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: colorMode === 'weight' ? '#0891b2' : 'white', color: colorMode === 'weight' ? 'white' : '#374151' }}
              title="Total steel weight intensity, longitudinal + stirrups (lb per ft of beam)">
              lb/ft
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

          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {map.modelName} · {frames.length} frames · {new Date(map.importedAt).toLocaleDateString()}
          </span>
          <button onClick={onOpenEtabsImport}
            style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, cursor: 'pointer', background: 'white', color: '#374151', fontWeight: 600 }}>
            ↻ Re-sync
          </button>
        </div>

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
            frames={frames.map(f => ({
              ...f,
              // Dim non-highlighted when auto-group panel is open and hovering a bin
              ...( highlightedFrames.size > 0 && !highlightedFrames.has(f.frameName)
                ? { _dimmed: true } : {}),
            }))}
            dcrById={dcrById}
            infoById={infoById}
            designGroups={groups}
            story={story}
            colorMode={colorMode}
            selected={new Set([...selectedFrames, ...highlightedFrames])}
            onSelectionChange={setSelectedFrames}
            onDoubleClick={onPickMember}
            onFrameClick={activeGroup ? handleFrameClick : undefined}
            width={canvasSize.w}
            height={canvasSize.h}
            diagramMode={diagramMode}
            diagramDataById={diagramMode !== 'off' ? diagramDataById : undefined}
            metricById={metricById}
            metricRange={metricRange}
            metricLabel={metricLabel}
          />
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
              highlightedFrameNames={highlightedFrames}
              onHighlightChange={setHighlightedFrames}
              onApplySuggestion={handleAcceptSuggestion}
            />
          )}

          {rightTab === 'savings' && (
            <SavingsPanel
              members={members}
              resultsById={designResultsById}
              designGroups={groups}
              onMergeGroups={handleMergeGroups}
              targetDCR={project.targetDCR ?? 0.9}
              onTargetDCRChange={v => onProjectChange({ ...project, targetDCR: v })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
