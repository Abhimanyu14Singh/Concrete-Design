import { useState, useEffect, useRef, useCallback } from 'react';
import type { Project, Member, ModelMap, DesignGroup } from './types';
import { defaultProject } from './utils/sampleData';
import { saveProject, openProject } from './utils/electronBridge';
import { exportExcel } from './utils/export/excelExport';
import { buildSchedulePDF } from './utils/export/schedulePdfExport';
import ReportModal from './components/ReportModal';
import Dashboard from './components/Dashboard/Dashboard';
import MemberResults from './components/Results/MemberResults';
import MemberEditor from './components/SectionInput/MemberEditor';
import EtabsImportWizard from './components/EtabsImport/EtabsImportWizard';
import ModelMapView from './components/ModelMap/ModelMapView';
import ErrorBoundary from './components/common/ErrorBoundary';
import Dropdown from './components/common/Dropdown';
import { useUnits } from './contexts/UnitsContext';
import { MEMBER_COLOR } from './theme';

type Tab = 'dashboard' | 'map' | 'member';

const hdrBtn: React.CSSProperties = {
  padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6,
  background: 'white', fontSize: 12, cursor: 'pointer', color: '#374151', fontWeight: 600,
};

export default function App() {
  // ── Core state ────────────────────────────────────────────────────────────
  const [project, setProjectRaw] = useState<Project>(defaultProject);
  const [activeMemberId, setActiveMemberId] = useState<string>(project.members[0].id);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarW, setSidebarW] = useState(220);
  const sidebarDragging = useRef(false);
  const sidebarDragStartX = useRef(0);
  const sidebarDragStartW = useRef(220);
  const [zoom, setZoom] = useState<number>(() => {
    const s = localStorage.getItem('sc-zoom');
    return s ? parseFloat(s) : 1.0;
  });
  const [showPrefs, setShowPrefs] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const { units, setUnits, fmt } = useUnits();

  // B5: dirty indicator
  const [isDirty, setIsDirty] = useState(false);

  // B4: undo/redo history
  const historyRef = useRef<Project[]>([defaultProject]);
  const historyIndexRef = useRef<number>(0);

  // A3: drag-to-reorder state
  const [dragSrcId, setDragSrcId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Collapsible group sections in sidebar
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('sc-collapsed-groups') ?? '[]')); } catch { return new Set(); }
  });
  // Persist collapse state (toggled from either the sidebar or the Dashboard)
  useEffect(() => {
    localStorage.setItem('sc-collapsed-groups', JSON.stringify([...collapsedGroups]));
  }, [collapsedGroups]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupLabel, setEditGroupLabel] = useState('');

  // A1: split-pane width
  const [splitPos, setSplitPos] = useState<number>(() => {
    const s = localStorage.getItem('sc-split');
    return s ? parseInt(s) : 360;
  });
  const splitDragging = useRef(false);
  const splitStartX = useRef(0);
  const splitStartPos = useRef(360);

  const activeMember = project.members.find(m => m.id === activeMemberId) ?? project.members[0];

  // ── Project mutation wrapper (marks dirty, tracks history) ────────────────
  function setProject(p: Project | ((prev: Project) => Project)) {
    setProjectRaw(prev => {
      const next = typeof p === 'function' ? p(prev) : p;
      // Push to history (cap at 20)
      const sliced = historyRef.current.slice(0, historyIndexRef.current + 1);
      historyRef.current = [...sliced, next].slice(-20);
      historyIndexRef.current = historyRef.current.length - 1;
      setIsDirty(true);
      return next;
    });
  }

  // ── File handlers ──────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    try {
      const saved = await saveProject(project);
      // Only clear the dirty flag when the file was actually written
      // (not when the user cancelled the save dialog).
      if (saved) setIsDirty(false);
    } catch (e) {
      alert(`Could not save the project:\n${(e as Error).message}`);
    }
  }, [project]);

  const handleOpen = useCallback(async () => {
    try {
      const loaded = await openProject();
      if (!loaded) return; // cancelled
      setProjectRaw(loaded);
      historyRef.current = [loaded];
      historyIndexRef.current = 0;
      setActiveMemberId(loaded.members[0]?.id ?? '');
      setTab('dashboard');
      setIsDirty(false);
    } catch (e) {
      alert(`Could not open the project file:\n${(e as Error).message}`);
    }
  }, []);

  function handleNewProject() {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
    // Native confirm() can steal keyboard focus from the window in Electron
    window.focus();
    setProjectRaw(defaultProject);
    historyRef.current = [defaultProject];
    historyIndexRef.current = 0;
    setActiveMemberId(defaultProject.members[0].id);
    setTab('dashboard');
    setIsDirty(false);
  }

  function changeZoom(z: number) {
    setZoom(z);
    localStorage.setItem('sc-zoom', String(z));
    setShowPrefs(false);
  }

  // ── B4: Undo/Redo ──────────────────────────────────────────────────────────
  function undo() {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    const prev = historyRef.current[historyIndexRef.current];
    setProjectRaw(prev);
    setIsDirty(historyIndexRef.current > 0);
  }

  function redo() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    const next = historyRef.current[historyIndexRef.current];
    setProjectRaw(next);
    setIsDirty(true);
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) {
        // A4: Arrow navigation in sidebar
        if (tab === 'member' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          const idx = project.members.findIndex(m => m.id === activeMemberId);
          if (e.key === 'ArrowUp' && idx > 0)
            setActiveMemberId(project.members[idx - 1].id);
          if (e.key === 'ArrowDown' && idx < project.members.length - 1)
            setActiveMemberId(project.members[idx + 1].id);
        }
        return;
      }
      // In Electron, Ctrl+S and Ctrl+O are handled by the native File-menu
      // accelerators (which fire IPC events). Running them here too would open
      // a second dialog. Ctrl+N uses confirm() not a dialog, so it's safe to
      // keep in both environments.
      const inElectron = !!window.electronAPI;
      if (e.key === 's' && !inElectron) { e.preventDefault(); handleSave(); }
      if (e.key === 'o' && !inElectron) { e.preventDefault(); handleOpen(); }
      if (e.key === 'n') { e.preventDefault(); handleNewProject(); }
      if (e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (e.key === 'y') { e.preventDefault(); redo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, activeMemberId, tab, handleSave, handleOpen]);

  // ── Electron menu → renderer events ───────────────────────────────────────
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    api.onTriggerSave(handleSave);
    api.onTriggerOpen(handleOpen);
    api.onNewProject(handleNewProject);
    return () => {
      api.offTriggerSave();
      api.offTriggerOpen();
      api.offNewProject();
    };
  }, [handleSave, handleOpen]);

  // ── Click outside to close popovers ───────────────────────────────────────
  useEffect(() => {
    if (!showPrefs && !showExport) return;
    function close(e: MouseEvent) {
      if (!(e.target as Element).closest('[data-popover]')) {
        setShowPrefs(false);
        setShowExport(false);
      }
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showPrefs, showExport]);

  // ── A1: Split-pane drag ───────────────────────────────────────────────────
  function onSplitMouseDown(e: React.MouseEvent) {
    splitDragging.current = true;
    splitStartX.current = e.clientX;
    splitStartPos.current = splitPos;
    e.preventDefault();
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!splitDragging.current) return;
      const newPos = Math.max(240, Math.min(640, splitStartPos.current + e.clientX - splitStartX.current));
      setSplitPos(newPos);
      localStorage.setItem('sc-split', String(newPos));
    }
    function onMouseUp() { splitDragging.current = false; }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, []);

  // ── ETABS import ───────────────────────────────────────────────────────────
  const [showEtabsImport, setShowEtabsImport] = useState(false);

  function handleEtabsImport(
    members: Member[],
    groups: DesignGroup[],
    pickId?: string,
    modelMap?: ModelMap,
    slsCombo?: string,
    applyCode?: import('./types').DesignCode,
    applyUnits?: 'imperial' | 'si',
  ) {
    if (applyUnits) setUnits(applyUnits);
    setProject(p => {
      // Re-imports replace members with the same frame id
      const incoming = new Set(members.map(m => m.id));
      return {
        ...p,
        members: [...p.members.filter(m => !incoming.has(m.id)), ...members],
        designGroups: [...(p.designGroups ?? []).filter(g => !g.memberIds.some(id => incoming.has(id))), ...groups],
        ...(modelMap ? { modelMap } : {}),
        slsCombo: slsCombo || undefined,
        ...(applyCode ? { code: applyCode } : {}),
      };
    });
    setShowEtabsImport(false);
    if (pickId) {
      setActiveMemberId(pickId);
      setTab('member');
    } else if (modelMap) {
      setTab('map');
    } else {
      setTab('dashboard');
    }
  }

  // ── Member helpers ─────────────────────────────────────────────────────────
  function handleSelectMember(id: string) {
    setActiveMemberId(id);
    setTab('member');
  }

  function handleUpdateMember(updated: Member) {
    setProject(p => ({
      ...p,
      members: p.members.map(m => m.id === updated.id ? updated : m),
    }));
  }

  function addMember() {
    const id = `M${project.members.length + 1}`;
    const newMember: Member = {
      id,
      label: `New Member ${id}`,
      memberType: 'beam',
      span: 20,
      material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 },
      section: { type: 'rectangular_beam', b: 14, h: 22, coverClear: 1.5, stirrupDia: 4 },
      rebar: {
        topBars: [{ numBars: 3, barSize: 7 }],
        botBars: [{ numBars: 3, barSize: 7 }],
        ties: { barSize: 4, spacing: 6, legs: 2 },
      },
      loads: [
        { id: '1.2D+1.6L', label: '1.2D + 1.6L', Mu_pos: 100, Mu_neg: 80, Vu: 45, Tu: 0, Pu: 0 },
      ],
    };
    setProject(p => ({ ...p, members: [...p.members, newMember] }));
    setActiveMemberId(id);
    setTab('member');
  }

  // A2: Duplicate member
  function duplicateMember(id: string) {
    const src = project.members.find(m => m.id === id);
    if (!src) return;
    const newId = `M${project.members.length + 1}`;
    const copy: Member = {
      ...JSON.parse(JSON.stringify(src)),
      id: newId,
      label: src.label + ' (Copy)',
    };
    setProject(p => ({ ...p, members: [...p.members, copy] }));
    setActiveMemberId(newId);
    setTab('member');
  }

  function deleteMember(id: string) {
    const m = project.members.find(mm => mm.id === id);
    if (!m) return;
    if (!confirm(`Delete member ${m.id} — "${m.label}"? (Ctrl+Z to undo)`)) return;
    setProject(p => {
      const members = p.members.filter(mm => mm.id !== id);
      // Clean dangling group references; drop groups that become empty
      const designGroups = (p.designGroups ?? [])
        .map(g => ({ ...g, memberIds: g.memberIds.filter(mid => mid !== id) }))
        .filter(g => g.memberIds.length > 0);
      return { ...p, members, designGroups };
    });
    if (activeMemberId === id) {
      const remaining = project.members.filter(mm => mm.id !== id);
      if (remaining.length) {
        setActiveMemberId(remaining[0].id);
      } else {
        setTab('dashboard');
      }
    }
  }

  function deleteMembers(ids: string[]) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setProject(p => {
      const members = p.members.filter(mm => !idSet.has(mm.id));
      const designGroups = (p.designGroups ?? [])
        .map(g => ({ ...g, memberIds: g.memberIds.filter(mid => !idSet.has(mid)) }))
        .filter(g => g.memberIds.length > 0);
      return { ...p, members, designGroups };
    });
    if (activeMemberId && idSet.has(activeMemberId)) {
      const remaining = project.members.filter(mm => !idSet.has(mm.id));
      if (remaining.length) {
        setActiveMemberId(remaining[0].id);
      } else {
        setTab('dashboard');
      }
    }
  }

  // A3: Drag-to-reorder
  function onDragStart(id: string) { setDragSrcId(id); }
  function onDragOver(e: React.DragEvent, id: string) { e.preventDefault(); setDragOverId(id); }
  function onDrop(targetId: string) {
    if (!dragSrcId || dragSrcId === targetId) { setDragSrcId(null); setDragOverId(null); return; }
    setProject(p => {
      const members = [...p.members];
      const srcIdx = members.findIndex(m => m.id === dragSrcId);
      const tgtIdx = members.findIndex(m => m.id === targetId);
      const [item] = members.splice(srcIdx, 1);
      members.splice(tgtIdx, 0, item);
      return { ...p, members };
    });
    setDragSrcId(null);
    setDragOverId(null);
  }

  const sectionLabel = (m: Member) => {
    const s = m.section;
    if (s.type === 'circular_column') return `Ø${fmt(s.diameter ?? s.b, 'length')}`;
    return `${fmt(s.b, 'length')} × ${fmt(s.h, 'length')}`;
  };

  function toggleGroupCollapse(gid: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid); else next.add(gid);
      return next;
    });
  }

  function renameGroupStart(g: DesignGroup) {
    setEditingGroupId(g.id);
    setEditGroupLabel(g.label);
  }

  function renameGroupCommit() {
    if (!editingGroupId || !editGroupLabel.trim()) { setEditingGroupId(null); return; }
    setProject(p => ({
      ...p,
      designGroups: (p.designGroups ?? []).map(g => g.id === editingGroupId ? { ...g, label: editGroupLabel.trim() } : g),
    }));
    setEditingGroupId(null);
  }

  // Build ordered group sections: each group + ungrouped at end
  function buildSidebarSections(): Array<{ groupId: string | null; label: string; color?: string; members: Member[] }> {
    const groups = project.designGroups ?? [];
    const assignedIds = new Set(groups.flatMap(g => g.memberIds));
    const sections: Array<{ groupId: string | null; label: string; color?: string; members: Member[] }> = [];
    for (const g of groups) {
      const gMembers = project.members.filter(m => g.memberIds.includes(m.id));
      if (gMembers.length) sections.push({ groupId: g.id, label: g.label, color: g.color, members: gMembers });
    }
    const ungrouped = project.members.filter(m => !assignedIds.has(m.id));
    if (ungrouped.length) sections.push({ groupId: null, label: 'Ungrouped', members: ungrouped });
    return sections;
  }

  return (
    <div id="app-root" style={{ display: 'flex', height: '100vh', background: '#f3f4f6', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
      {showEtabsImport && (
        <EtabsImportWizard
          code={project.code}
          onClose={() => setShowEtabsImport(false)}
          onImport={handleEtabsImport}
        />
      )}
      {showReport && (
        <ReportModal project={project} onClose={() => setShowReport(false)} />
      )}
      {/* Sidebar */}
      <aside id="app-sidebar" style={{ width: sidebarOpen ? sidebarW : 48, flexShrink: 0, background: 'white', borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ width: 28, height: 28, background: '#2563eb', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 'bold', color: 'white', flexShrink: 0 }}>
            SD
          </div>
          {sidebarOpen && (
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', color: '#111827' }}>S-Dashboard</div>
              <div style={{ color: '#9ca3af', fontSize: 10, whiteSpace: 'nowrap' }}>{project.code}</div>
            </div>
          )}
          <button onClick={() => setSidebarOpen(o => !o)} style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer' }}>
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        {/* Members list — grouped sections */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {sidebarOpen && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 12px 6px' }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 }}>Members</span>
              <button onClick={addMember} style={{ color: '#2563eb', fontSize: 18, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }} title="Add member">+</button>
            </div>
          )}
          {sidebarOpen ? buildSidebarSections().map(section => {
            const collapsed = section.groupId ? collapsedGroups.has(section.groupId) : false;
            return (
              <div key={section.groupId ?? '__ungrouped'}>
                {/* Section header */}
                <div
                  onClick={() => section.groupId && toggleGroupCollapse(section.groupId)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 10px',
                    background: '#f9fafb', borderTop: '1px solid #f3f4f6',
                    cursor: section.groupId ? 'pointer' : 'default',
                  }}
                >
                  {section.color && <span style={{ width: 8, height: 8, borderRadius: '50%', background: section.color, flexShrink: 0 }} />}
                  {section.groupId && editingGroupId === section.groupId ? (
                    <input
                      autoFocus value={editGroupLabel}
                      onChange={e => setEditGroupLabel(e.target.value)}
                      onBlur={renameGroupCommit}
                      onKeyDown={e => { if (e.key === 'Enter') renameGroupCommit(); if (e.key === 'Escape') setEditingGroupId(null); }}
                      onClick={e => e.stopPropagation()}
                      style={{ flex: 1, fontSize: 11, fontWeight: 700, border: '1px solid #2563eb', borderRadius: 3, padding: '1px 4px', minWidth: 0 }}
                    />
                  ) : (
                    <span
                      onDoubleClick={e => { e.stopPropagation(); const g = (project.designGroups ?? []).find(g => g.id === section.groupId); if (g) renameGroupStart(g); }}
                      style={{ flex: 1, fontSize: 11, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={section.groupId ? 'Double-click to rename' : undefined}
                    >
                      {section.label}
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>{section.members.length}</span>
                  {section.groupId && <span style={{ fontSize: 9, color: '#9ca3af' }}>{collapsed ? '▸' : '▾'}</span>}
                </div>
                {/* Member rows */}
                {!collapsed && section.members.map(m => (
                  <div
                    key={m.id}
                    draggable
                    onDragStart={() => onDragStart(m.id)}
                    onDragOver={e => onDragOver(e, m.id)}
                    onDrop={() => onDrop(m.id)}
                    onDragEnd={() => { setDragSrcId(null); setDragOverId(null); }}
                    style={{
                      display: 'flex', alignItems: 'center',
                      borderTop: dragOverId === m.id && dragSrcId !== m.id ? '2px solid #2563eb' : '2px solid transparent',
                      opacity: dragSrcId === m.id ? 0.5 : 1,
                      paddingLeft: section.groupId ? 8 : 0,
                    }}
                  >
                    <span style={{ fontSize: 14, color: '#d1d5db', cursor: 'grab', padding: '0 4px 0 4px', flexShrink: 0 }}>⠿</span>
                    <button
                      onClick={() => handleSelectMember(m.id)}
                      style={{
                        flex: 1, textAlign: 'left', padding: '6px 6px', display: 'flex', alignItems: 'center', gap: 5,
                        background: activeMemberId === m.id ? '#eff6ff' : 'none',
                        borderRight: `3px solid ${activeMemberId === m.id ? '#2563eb' : 'transparent'}`,
                        border: 'none', borderLeft: 'none', borderTop: 'none', borderBottom: 'none',
                        cursor: 'pointer', minWidth: 0,
                      }}
                    >
                      <span style={{ fontSize: 10, fontWeight: 700, flexShrink: 0, color: MEMBER_COLOR[m.memberType] ?? MEMBER_COLOR.beam }}>{m.id}</span>
                      <span style={{ fontSize: 11, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {m.label}
                      </span>
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); duplicateMember(m.id); }}
                      title="Duplicate member"
                      style={{ fontSize: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}
                    >⧉</button>
                    <button
                      onClick={e => { e.stopPropagation(); deleteMember(m.id); }}
                      title="Delete member"
                      style={{ fontSize: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px 0 2px', flexShrink: 0 }}
                      onMouseEnter={e => { (e.target as HTMLElement).style.color = '#dc2626'; }}
                      onMouseLeave={e => { (e.target as HTMLElement).style.color = '#9ca3af'; }}
                    >🗑</button>
                  </div>
                ))}
              </div>
            );
          }) : (
            // Collapsed sidebar — just member dots
            project.members.map(m => (
              <button key={m.id} onClick={() => handleSelectMember(m.id)}
                style={{ display: 'block', width: '100%', padding: '8px 0', background: 'none', border: 'none', cursor: 'pointer' }}
                title={m.id}
              >
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: MEMBER_COLOR[m.memberType] ?? MEMBER_COLOR.beam, margin: '0 auto' }} />
              </button>
            ))
          )}
          {sidebarOpen && (
            <button onClick={addMember} style={{ width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', gap: 6 }}>
              <span>+</span><span>Add Member</span>
            </button>
          )}
        </div>

        {/* Resize handle */}
        {sidebarOpen && (
          <div
            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 10, background: 'transparent' }}
            onMouseDown={e => {
              sidebarDragging.current = true;
              sidebarDragStartX.current = e.clientX;
              sidebarDragStartW.current = sidebarW;
              const onMove = (me: MouseEvent) => {
                if (!sidebarDragging.current) return;
                const dx = me.clientX - sidebarDragStartX.current;
                setSidebarW(Math.max(160, Math.min(480, sidebarDragStartW.current + dx)));
              };
              const onUp = () => { sidebarDragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
              e.preventDefault();
            }}
            title="Drag to resize"
          />
        )}

        {sidebarOpen && (
          <div style={{ padding: '10px 12px', borderTop: '1px solid #e5e7eb' }}>
            {[['Beam', MEMBER_COLOR.beam], ['Column', MEMBER_COLOR.column], ['Wall', MEMBER_COLOR.wall]].map(([t, c]) => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                <span style={{ fontSize: 10, color: '#9ca3af' }}>{t}</span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <header id="app-header" style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          {/* View tabs */}
          <div style={{ display: 'flex', gap: 4 }}>
            {([['dashboard', 'Dashboard'], ['map', 'Map'], ['member', 'Member']] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: tab === key ? '#2563eb' : 'transparent',
                  color: tab === key ? 'white' : '#6b7280',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          {/* Member selector */}
          {tab === 'member' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Member:</span>
              <Dropdown
                value={activeMemberId}
                options={project.members.map(m => ({ value: m.id, label: `${m.id} — ${m.label}` }))}
                onChange={setActiveMemberId}
                style={{ background: 'white', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 8px', fontSize: 12, color: '#111827' }}
              />
            </div>
          )}

          {/* Separator */}
          <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />

          {/* B5: Dirty indicator */}
          <span style={{ fontSize: 11, color: isDirty ? '#dc2626' : '#9ca3af', fontWeight: 600, minWidth: 70 }}>
            {isDirty ? '● Unsaved' : '✓ Saved'}
          </span>

          {/* B4: Undo/Redo */}
          <button onClick={undo} style={{ ...hdrBtn, fontSize: 14, padding: '3px 8px' }} title="Undo (Ctrl+Z)">↩</button>
          <button onClick={redo} style={{ ...hdrBtn, fontSize: 14, padding: '3px 8px' }} title="Redo (Ctrl+Y)">↪</button>

          <div style={{ width: 1, height: 20, background: '#e5e7eb' }} />

          {/* File actions */}
          <button onClick={handleNewProject} style={hdrBtn} title="New project (Ctrl+N)">New</button>
          <button onClick={handleOpen}       style={hdrBtn} title="Open project (Ctrl+O)">Open</button>
          <button onClick={handleSave}       style={hdrBtn} title="Save project (Ctrl+S)">Save</button>
          <button
            onClick={() => setShowEtabsImport(true)}
            style={{ ...hdrBtn, borderColor: '#7c3aed', color: '#7c3aed' }}
            title="Import beams from an ETABS model (CSI API or tables file)"
          >
            ⇪ ETABS
          </button>

          {/* E1: Export dropdown */}
          <div data-popover="" style={{ position: 'relative' }}>
            <button
              onClick={() => { setShowExport(v => !v); setShowPrefs(false); }}
              style={{ ...hdrBtn, background: showExport ? '#eff6ff' : 'white', color: showExport ? '#2563eb' : '#374151' }}
            >
              Export ▾
            </button>
            {showExport && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200,
                background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.1)', padding: '6px', minWidth: 160,
              }}>
                <button
                  onClick={() => { setShowReport(true); setShowExport(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#374151', borderRadius: 6, fontWeight: 600 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  PDF Report…
                </button>
                <button
                  onClick={() => { exportExcel(project); setShowExport(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#374151', borderRadius: 6, fontWeight: 600 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Excel Summary
                </button>
                <button
                  onClick={async () => {
                    setShowExport(false);
                    const bytes = await buildSchedulePDF(project, { mode: 'group' });
                    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${(project.name ?? 'schedule').replace(/\s+/g, '_')}_group_schedule.pdf`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#374151', borderRadius: 6, fontWeight: 600 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Group Schedule PDF
                </button>
                <button
                  onClick={async () => {
                    setShowExport(false);
                    const bytes = await buildSchedulePDF(project, { mode: 'beam' });
                    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${(project.name ?? 'schedule').replace(/\s+/g, '_')}_beam_schedule.pdf`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#374151', borderRadius: 6 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Beam Schedule PDF <span style={{ fontSize: 10, color: '#9ca3af' }}>(full)</span>
                </button>
                <button
                  onClick={() => { window.print(); setShowExport(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#374151', borderRadius: 6, fontWeight: 600 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Print Preview
                </button>
              </div>
            )}
          </div>

          {/* Preferences */}
          <div data-popover="" style={{ position: 'relative' }}>
            <button
              onClick={() => { setShowPrefs(v => !v); setShowExport(false); }}
              style={{ ...hdrBtn, background: showPrefs ? '#eff6ff' : 'white', color: showPrefs ? '#2563eb' : '#374151' }}
              title="Preferences"
            >
              ⚙
            </button>
            {showPrefs && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200,
                background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.1)', padding: '12px 8px', minWidth: 190,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, padding: '0 8px', marginBottom: 8 }}>
                  Display Scale
                </div>
                {[0.75, 0.9, 1.0, 1.1, 1.25, 1.5].map(z => (
                  <button
                    key={z}
                    onClick={() => changeZoom(z)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      width: '100%', padding: '6px 10px', border: 'none', borderRadius: 6,
                      cursor: 'pointer', fontSize: 13, textAlign: 'left',
                      background: zoom === z ? '#eff6ff' : 'none',
                      color: zoom === z ? '#2563eb' : '#374151',
                      fontWeight: zoom === z ? 700 : 400,
                    }}
                  >
                    <span>{z === 1.0 ? '100%  (default)' : `${Math.round(z * 100)}%`}</span>
                    {zoom === z && <span style={{ fontSize: 11 }}>✓</span>}
                  </button>
                ))}
                <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, padding: '0 8px', margin: '12px 0 8px', borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
                  Units
                </div>
                {([['imperial', 'US (in, psi, kips)'], ['si', 'SI (mm, MPa, kN)']] as const).map(([u, label]) => (
                  <button
                    key={u}
                    onClick={() => setUnits(u)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      width: '100%', padding: '6px 10px', border: 'none', borderRadius: 6,
                      cursor: 'pointer', fontSize: 13, textAlign: 'left',
                      background: units === u ? '#eff6ff' : 'none',
                      color: units === u ? '#2563eb' : '#374151',
                      fontWeight: units === u ? 700 : 400,
                    }}
                  >
                    <span>{label}</span>
                    {units === u && <span style={{ fontSize: 11 }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Project info */}
          <div style={{ fontSize: 11, color: '#6b7280' }}>{project.name}</div>
          <Dropdown
            value={project.code}
            options={(['ACI318-19', 'ACI318-14', 'ACI318-25', 'EN1992-1-1'] as import('./types').DesignCode[]).map(c => ({ value: c, label: c }))}
            onChange={v => {
              const newCode = v as import('./types').DesignCode;
              if (newCode === 'EN1992-1-1' && project.code !== 'EN1992-1-1') setUnits('si');
              setProject(p => ({ ...p, code: newCode }));
            }}
            style={{ fontSize: 11, background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 6, padding: '2px 6px', fontWeight: 700, cursor: 'pointer', outline: 'none' }}
          />
        </header>

        {/* Content */}
        <main id="app-main" style={{ flex: 1, overflowY: tab === 'map' ? 'hidden' : 'auto', overflowX: 'hidden' }}>
          <div style={{
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
            width: `${100 / zoom}%`,
            minHeight: `${100 / zoom}%`,
            // map tab needs a definite height so the canvas can fill it
            height: tab === 'map' ? `${100 / zoom}%` : undefined,
            padding: tab === 'map' ? 0 : 16,
          }}>
            {tab === 'dashboard' && (
              <Dashboard
                project={project}
                onSelectMember={handleSelectMember}
                onProjectUpdate={p => setProject(p)}
                collapsedGroups={collapsedGroups}
                setCollapsedGroups={setCollapsedGroups}
              />
            )}
            {tab === 'map' && (
              <div style={{ height: '100%', display: 'flex' }}>
                <ErrorBoundary area="the model map">
                  <ModelMapView
                    project={project}
                    onProjectChange={p => setProject(p)}
                    onOpenEtabsImport={() => setShowEtabsImport(true)}
                    onPickMember={id => { setActiveMemberId(id); setTab('member'); }}
                    onDeleteMember={id => deleteMember(id)}
                    onDeleteMembers={ids => deleteMembers(ids)}
                  />
                </ErrorBoundary>
              </div>
            )}
            {tab === 'member' && (
              <div id="app-split" style={{ display: 'flex', gap: 0, alignItems: 'flex-start' }}>
                {/* Left: Input editor */}
                <div style={{ width: splitPos, flexShrink: 0, minWidth: 0, paddingRight: 8 }}>
                  <div style={{ marginBottom: 10 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#111827' }}>Input</h2>
                    <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 0' }}>Edit geometry, materials, reinforcement, loads</p>
                  </div>
                  <MemberEditor
                    key={activeMember.id}
                    member={activeMember}
                    onUpdate={handleUpdateMember}
                    code={project.code}
                  />
                </div>

                {/* A1: Drag divider */}
                <div
                  onMouseDown={onSplitMouseDown}
                  style={{
                    width: 8, flexShrink: 0, cursor: 'col-resize',
                    background: 'transparent', position: 'relative',
                    alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <div style={{ width: 3, borderRadius: 2, height: '40px', background: '#d1d5db' }} />
                </div>

                {/* Right: Results */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ marginBottom: 10 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#111827' }}>{activeMember.label}</h2>
                    <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 0' }}>
                      {activeMember.section.type.replace(/_/g, ' ')} &bull; {sectionLabel(activeMember)} &bull;
                      f'c = {fmt(activeMember.material.fc, 'stress')} &bull; fy = {fmt(activeMember.material.fy / 1000, 'stressKsi')}
                    </p>
                  </div>
                  <ErrorBoundary key={activeMember.id} area="the results view">
                    <MemberResults
                      member={activeMember}
                      code={project.code}
                      slsCombo={project.slsCombo}
                      onRebarChange={handleUpdateMember}
                    />
                  </ErrorBoundary>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
