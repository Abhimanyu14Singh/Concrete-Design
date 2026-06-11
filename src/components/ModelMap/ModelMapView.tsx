/**
 * ModelMapView — top-level Map tab: canvas (left) + group panel (right).
 * Shows the ETABS connectivity snapshot stored in project.modelMap.
 */
import { useState, useMemo, useRef, useLayoutEffect } from 'react';
import type { Project, Member, DesignGroup, RebarLayout } from '../../types';
import { runDesign } from '../../engines';
import MapCanvas, { type ColorMode } from './MapCanvas';
import GroupPanel from './GroupPanel';
import GroupRebarEditor from './GroupRebarEditor';

interface Props {
  project: Project;
  onProjectChange: (p: Project) => void;
  onOpenEtabsImport: () => void;
  onPickMember: (memberId: string) => void;
}

export default function ModelMapView({ project, onProjectChange, onOpenEtabsImport, onPickMember }: Props) {
  const [selectedFrames, setSelectedFrames] = useState<Set<string>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('dcr');
  const [story, setStory] = useState<string>('All');

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

  // Live DCR lookup — recomputes when members (incl. rebar) change
  const dcrById = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of members) {
      if (m.memberType !== 'beam' || !m.loads.length) continue;
      try {
        const worst = Math.max(...m.loads.map(l => {
          const r = runDesign(m.section, m.material, m.rebar, l, m.span, project.code, m.crackParams);
          return Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear);
        }));
        out[m.id] = worst;
      } catch { /* skip members the engine can't design */ }
    }
    return out;
  }, [members, project.code]);

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
  const frames = map?.frames ?? [];

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

        {/* Map canvas */}
        <div ref={canvasWrapRef} style={{ flex: 1, overflow: 'hidden' }}>
          <MapCanvas
            frames={frames}
            dcrById={dcrById}
            designGroups={groups}
            story={story}
            colorMode={colorMode}
            selected={selectedFrames}
            onSelectionChange={setSelectedFrames}
            onDoubleClick={onPickMember}
            width={canvasSize.w}
            height={canvasSize.h}
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
