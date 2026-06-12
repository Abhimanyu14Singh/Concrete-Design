/**
 * ModelMapView — top-level Map tab: canvas (left) + group panel (right).
 * Shows the ETABS connectivity snapshot stored in project.modelMap.
 */
import { useState, useMemo, useRef, useLayoutEffect } from 'react';
import type { Project, Member, DesignGroup, RebarLayout, ComboForces } from '../../types';
import { runDesign } from '../../engines';
import { formatBarLabel } from '../../utils/rebar';
import MapCanvas, { type ColorMode, type FrameInfo, type DiagramMode } from './MapCanvas';
import GroupPanel from './GroupPanel';
import GroupRebarEditor from './GroupRebarEditor';

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
  const [story, setStory] = useState<string>('All');
  const [diagramMode, setDiagramMode] = useState<DiagramMode>('off');

  // Size the canvas to its container
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

  // Live frame→member linkage from current project.members (not stale modelMap)
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

  // Rich per-member info for tooltip and DCR coloring
  const infoById = useMemo(() => {
    const out: Record<string, FrameInfo> = {};
    for (const m of members) {
      if (m.memberType !== 'beam' || !m.loads.length) continue;
      try {
        let dcrFlex = 0, dcrShear = 0;
        for (const l of m.loads) {
          const r = runDesign(m.section, m.material, m.rebar, l, m.span, project.code, m.crackParams);
          dcrFlex = Math.max(dcrFlex, r.DCR_flex_pos, r.DCR_flex_neg);
          dcrShear = Math.max(dcrShear, r.DCR_shear);
        }
        out[m.id] = {
          dcr: Math.max(dcrFlex, dcrShear),
          dcrFlex,
          dcrShear,
          top: rebarStr(m.rebar.topBars),
          bot: rebarStr(m.rebar.botBars),
          stirrups: stirrupStr(m.rebar),
        };
      } catch (e) {
        out[m.id] = {
          dcr: 0, dcrFlex: 0, dcrShear: 0,
          top: '—', bot: '—', stirrups: '—',
          error: (e as Error).message,
        };
      }
    }
    return out;
  }, [members, project.code]);

  const dcrById = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, info] of Object.entries(infoById)) out[id] = info.dcr;
    return out;
  }, [infoById]);

  // V/M diagram data per memberId
  const diagramDataById = useMemo(() => {
    if (diagramMode === 'off') return {} as Record<string, { x: number; v: number }[]>;
    const out: Record<string, { x: number; v: number }[]> = {};
    for (const m of members) {
      if (!m.stationForces?.length) continue;
      out[m.id] = stationEnvelope(m.stationForces, diagramMode === 'moment' ? 'M' : 'V');
    }
    return out;
  }, [members, diagramMode]);

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

  const activeGroup = activeGroupId ? groups.find(g => g.id === activeGroupId) : null;
  const stories = map ? ['All', ...map.stories] : ['All'];
  const frames = enrichedFrames;

  // Group-edit mode: clicking a linked beam toggles it in/out of the active group
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
    return true; // suppress default selection change
  }

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
          {/* Story selector */}
          <select value={story} onChange={e => setStory(e.target.value)}
            style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: 'white' }}>
            {stories.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          {/* Color mode */}
          <div style={{ display: 'flex', gap: 2 }}>
            {(['dcr', 'group', 'section'] as ColorMode[]).map(mode => (
              <button key={mode} onClick={() => setColorMode(mode)}
                style={{
                  padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6,
                  fontSize: 11, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
                  background: colorMode === mode ? '#2563eb' : 'white',
                  color: colorMode === mode ? 'white' : '#374151',
                }}>
                {mode === 'dcr' ? 'DCR' : mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>

          {/* Diagram toggle */}
          <div style={{ display: 'flex', gap: 2, marginLeft: 4 }}>
            {(['off', 'moment', 'shear'] as DiagramMode[]).map(m => (
              <button key={m} onClick={() => setDiagramMode(m)}
                style={{
                  padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6,
                  fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  background: diagramMode === m ? '#7c3aed' : 'white',
                  color: diagramMode === m ? 'white' : '#374151',
                }}>
                {m === 'off' ? 'Diagrams Off' : m === 'moment' ? 'M Diagram' : 'V Diagram'}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          {/* Model info */}
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {map.modelName} · {frames.length} frames · imported {new Date(map.importedAt).toLocaleDateString()}
          </span>

          {/* Re-sync */}
          <button onClick={onOpenEtabsImport}
            style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, cursor: 'pointer', background: 'white', color: '#374151', fontWeight: 600 }}>
            ↻ Re-sync
          </button>
        </div>

        {/* Group-edit mode banner */}
        {activeGroup && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
            background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, flexShrink: 0,
          }}>
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
        <div ref={canvasWrapRef} style={{ flex: 1, overflow: 'hidden' }}>
          <MapCanvas
            frames={frames}
            dcrById={dcrById}
            infoById={infoById}
            designGroups={groups}
            story={story}
            colorMode={colorMode}
            selected={selectedFrames}
            onSelectionChange={setSelectedFrames}
            onDoubleClick={onPickMember}
            onFrameClick={activeGroup ? handleFrameClick : undefined}
            width={canvasSize.w}
            height={canvasSize.h}
            diagramMode={diagramMode}
            diagramDataById={diagramMode !== 'off' ? diagramDataById : undefined}
          />
        </div>
      </div>

      {/* Right panel */}
      <div style={{ width: 300, flexShrink: 0, borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 700, fontSize: 12, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Design Groups
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
        </div>
        {activeGroup && (
          <GroupRebarEditor
            group={activeGroup}
            members={members.filter(m => activeGroup.memberIds.includes(m.id))}
            onApply={handleApplyRebar}
          />
        )}
      </div>
    </div>
  );
}
