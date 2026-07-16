import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Project, Member, ModelMap, DesignGroup, DesignCode } from './types';
import { defaultProject } from './utils/sampleData';
import { runDesign } from './engines';
import { resolveCrack } from './utils/resolveCrack';
import { effectiveStatus } from './utils/overrides';
import { saveProject, openProject } from './utils/electronBridge';
import { exportExcel } from './utils/export/excelExport';
import { buildSchedulePDF } from './utils/export/schedulePdfExport';
import { exportGroupScheduleExcel } from './utils/export/groupScheduleExcel';
import ReportModal from './components/ReportModal';
import Dashboard from './components/Dashboard/Dashboard';
import HelpView from './components/Help/HelpView';
import MemberResults from './components/Results/MemberResults';
import MemberEditor from './components/SectionInput/MemberEditor';
import EtabsImportWizard from './components/EtabsImport/EtabsImportWizard';
import ModelMapView from './components/ModelMap/ModelMapView';
import ErrorBoundary from './components/common/ErrorBoundary';
import Dropdown from './components/common/Dropdown';
import { useUnits } from './contexts/UnitsContext';
import { MEMBER_COLOR, FONT, SURFACE, STATUS, INK, BORDER, ACCENT, LABEL_STYLE } from './theme';

type Tab = 'dashboard' | 'map' | 'member' | 'help';

const hdrBtn: React.CSSProperties = {
  padding: '5px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
  background: 'white', fontSize: 12, cursor: 'pointer', color: INK.base, fontWeight: 600,
};

/** Governing status for a member (respecting engineer overrides), used for the
 *  sidebar group NG/warn badges. 'Warning' → near-capacity, 'NG' → inadequate. */
function memberBadge(m: Member, code: DesignCode, slsCombo?: string): 'OK' | 'warn' | 'NG' {
  let sawNG = false, sawWarn = false;
  for (const l of m.loads) {
    const r = runDesign(m.section, m.material, m.rebar, l, m.span, code, resolveCrack(m, code, slsCombo));
    const st = effectiveStatus(r, m.overrides);
    if (st === 'NG') sawNG = true;
    else if (st !== 'OK') sawWarn = true;
  }
  return sawNG ? 'NG' : sawWarn ? 'warn' : 'OK';
}

export default function App() {
  // ── Core state ────────────────────────────────────────────────────────────
  const [project, setProjectRaw] = useState<Project>(defaultProject);
  const [activeMemberId, setActiveMemberId] = useState<string>(project.members[0].id);
  const [tab, setTab] = useState<Tab>('map');
  // The member list is a pull-down overlay (a "Members" button in the header) rather
  // than a docked column, so no view loses canvas width to it. Closed by default;
  // opened on demand and dismissed by clicking outside.
  const [membersOpen, setMembersOpen] = useState(false);
  const [zoom, setZoom] = useState<number>(() => {
    const s = localStorage.getItem('sc-zoom');
    return s ? parseFloat(s) : 1.0;
  });
  const [showPrefs, setShowPrefs] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [helpTarget, setHelpTarget] = useState<{ tab?: string; section?: string } | null>(null);
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
  // The design group the active member belongs to (first match) — supplies the
  // per-region top cages that step the moment diagram's hogging capacity.
  const activeGroup = (project.designGroups ?? []).find(g => g.memberIds.includes(activeMember.id));

  // Per-member governing status → sidebar group NG/warn badges (memoized so the
  // design engine only re-runs when members / code / SLS combo actually change).
  const badgeById = useMemo(() => {
    const out: Record<string, 'OK' | 'warn' | 'NG'> = {};
    for (const m of project.members) out[m.id] = memberBadge(m, project.code, project.slsCombo);
    return out;
  }, [project.members, project.code, project.slsCombo]);

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
    if (!showPrefs && !showExport && !membersOpen) return;
    function close(e: MouseEvent) {
      if (!(e.target as Element).closest('[data-popover]')) {
        setShowPrefs(false);
        setShowExport(false);
        setMembersOpen(false);
      }
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showPrefs, showExport, membersOpen]);

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

  // Open the Help tab, closing any open dialog first so the guide is visible.
  // Two entry points funnel here: a panel's "?" (HelpLink → window `open-help`
  // event, carries a doc section) and the native Help menu (Electron IPC, carries
  // a sub-tab). HelpView reads `target` to pick the sub-tab / scroll to a section.
  const openHelpTarget = useCallback((t: { tab?: string; section?: string }) => {
    setShowEtabsImport(false); setShowReport(false); setShowExport(false); setShowPrefs(false);
    setHelpTarget(t);
    setTab('help');
  }, []);

  useEffect(() => {
    const onOpenHelp = (e: Event) => {
      const section = (e as CustomEvent).detail as string | undefined;
      openHelpTarget(section ? { section } : {});
    };
    window.addEventListener('open-help', onOpenHelp);
    return () => window.removeEventListener('open-help', onOpenHelp);
  }, [openHelpTarget]);

  // Native Help menu (desktop) → open the matching Help sub-tab.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onOpenHelp) return;
    api.onOpenHelp(tab => openHelpTarget({ tab }));
    return () => api.offOpenHelp?.();
  }, [openHelpTarget]);

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
      // Fresh import: the imported members/groups fully REPLACE whatever was in
      // the project (the default sample members and any prior import). This is
      // why importing one group no longer drags in unrelated frames like the
      // sample C1/C2 columns.
      return {
        ...p,
        members,
        designGroups: groups,
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
    setProject(p => {
      const prev = p.members.find(m => m.id === updated.id);
      const members = p.members.map(m => m.id === updated.id ? updated : m);
      // A member's cage IS its group's cage. When the member designer changes the
      // rebar (inline edit or Optimize), fan it back to the group and its siblings
      // so the Group Dashboard card always matches the member designer. Non-rebar
      // edits (section/span/loads) stay member-local (reference check on rebar).
      const rebarChanged = !!prev && prev.rebar !== updated.rebar;
      const groups = p.designGroups ?? [];
      const owning = groups.filter(g => g.memberIds.includes(updated.id));
      if (!rebarChanged || !owning.length) return { ...p, members };
      const owningIds = new Set(owning.map(g => g.id));
      const siblingIds = new Set(owning.flatMap(g => g.memberIds));
      return {
        ...p,
        designGroups: groups.map(g => owningIds.has(g.id) ? { ...g, rebar: updated.rebar } : g),
        members: members.map(m => (m.id !== updated.id && siblingIds.has(m.id)) ? { ...m, rebar: updated.rebar } : m),
      };
    });
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
    const frameName = m.etabs?.frameName;
    setProject(p => {
      const members = p.members.filter(mm => mm.id !== id);
      // Clean dangling group references; drop groups that become empty
      const designGroups = (p.designGroups ?? [])
        .map(g => ({ ...g, memberIds: g.memberIds.filter(mid => mid !== id) }))
        .filter(g => g.memberIds.length > 0);
      // Drop the beam's frame from the connectivity snapshot so its line
      // disappears from the map view.
      const modelMap = p.modelMap
        ? { ...p.modelMap, frames: p.modelMap.frames.filter(f => f.memberId !== id && f.frameName !== frameName) }
        : p.modelMap;
      return { ...p, members, designGroups, modelMap };
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
    const frameNames = new Set(
      project.members.filter(mm => idSet.has(mm.id)).map(mm => mm.etabs?.frameName).filter(Boolean) as string[],
    );
    setProject(p => {
      const members = p.members.filter(mm => !idSet.has(mm.id));
      const designGroups = (p.designGroups ?? [])
        .map(g => ({ ...g, memberIds: g.memberIds.filter(mid => !idSet.has(mid)) }))
        .filter(g => g.memberIds.length > 0);
      const modelMap = p.modelMap
        ? { ...p.modelMap, frames: p.modelMap.frames.filter(f => !idSet.has(f.memberId ?? '') && !frameNames.has(f.frameName)) }
        : p.modelMap;
      return { ...p, members, designGroups, modelMap };
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
    <div id="app-root" style={{ display: 'flex', height: '100vh', background: SURFACE.app, fontFamily: FONT.ui, overflow: 'hidden' }}>
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
      {/* Members pull-down overlay — opened from the header "Members" button; a
          floating panel (not a docked column) so no view loses canvas width. */}
      {membersOpen && (
        <aside id="app-sidebar" data-popover="" style={{ position: 'fixed', top: 52, left: 12, bottom: 12, width: 288, zIndex: 300, background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 12, boxShadow: '0 16px 40px rgba(15,23,42,0.20)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Heading */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: `1px solid ${BORDER.default}` }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: INK.strong }}>Members</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={addMember} style={{ color: ACCENT.primary, fontSize: 18, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }} title="Add member">+</button>
            <button onClick={() => setMembersOpen(false)} style={{ color: INK.muted, fontSize: 15, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }} title="Close">✕</button>
          </div>
        </div>

        {/* Members list — grouped sections */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {buildSidebarSections().map(section => {
            const collapsed = section.groupId ? collapsedGroups.has(section.groupId) : false;
            const ngCount = section.members.filter(m => badgeById[m.id] === 'NG').length;
            const warnCount = section.members.filter(m => badgeById[m.id] === 'warn').length;
            return (
              <div key={section.groupId ?? '__ungrouped'}>
                {/* Section header */}
                <div
                  onClick={() => section.groupId && toggleGroupCollapse(section.groupId)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 10px',
                    background: SURFACE.subtle, borderTop: '1px solid #f3f4f6',
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
                      style={{ flex: 1, fontSize: 11, fontWeight: 700, border: `1px solid ${ACCENT.primary}`, borderRadius: 3, padding: '1px 4px', minWidth: 0 }}
                    />
                  ) : (
                    <span
                      onDoubleClick={e => { e.stopPropagation(); const g = (project.designGroups ?? []).find(g => g.id === section.groupId); if (g) renameGroupStart(g); }}
                      style={{ flex: 1, fontSize: 11, fontWeight: 700, color: INK.base, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={section.groupId ? 'Double-click to rename' : undefined}
                    >
                      {section.label}
                    </span>
                  )}
                  {ngCount > 0 && <span title={`${ngCount} inadequate`} style={{ fontSize: 10, fontWeight: 700, color: STATUS.fail, background: STATUS.failBg, borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>{ngCount} NG</span>}
                  {warnCount > 0 && <span title={`${warnCount} near capacity`} style={{ fontSize: 10, fontWeight: 700, color: STATUS.warn, background: STATUS.warnBg, borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>{warnCount}⚠</span>}
                  <span style={{ fontSize: 10, color: INK.muted, flexShrink: 0 }}>{section.members.length}</span>
                  {section.groupId && <span style={{ fontSize: 10, color: INK.muted }}>{collapsed ? '▸' : '▾'}</span>}
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
                      borderTop: dragOverId === m.id && dragSrcId !== m.id ? `2px solid ${ACCENT.primary}` : '2px solid transparent',
                      opacity: dragSrcId === m.id ? 0.5 : 1,
                      paddingLeft: section.groupId ? 8 : 0,
                    }}
                  >
                    <span style={{ fontSize: 14, color: BORDER.strong, cursor: 'grab', padding: '0 4px 0 4px', flexShrink: 0 }}>⠿</span>
                    <button
                      onClick={() => handleSelectMember(m.id)}
                      style={{
                        flex: 1, textAlign: 'left', padding: '6px 6px', display: 'flex', alignItems: 'center', gap: 5,
                        background: activeMemberId === m.id ? ACCENT.softBg : 'none',
                        borderRight: `3px solid ${activeMemberId === m.id ? ACCENT.primary : 'transparent'}`,
                        border: 'none', borderLeft: 'none', borderTop: 'none', borderBottom: 'none',
                        cursor: 'pointer', minWidth: 0,
                      }}
                    >
                      <span style={{ fontSize: 10, fontWeight: 700, flexShrink: 0, color: MEMBER_COLOR[m.memberType] ?? MEMBER_COLOR.beam }}>{m.id}</span>
                      <span style={{ fontSize: 11, color: INK.base, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {m.label}
                      </span>
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); duplicateMember(m.id); }}
                      title="Duplicate member"
                      style={{ fontSize: 12, color: INK.muted, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}
                    >⧉</button>
                    <button
                      onClick={e => { e.stopPropagation(); deleteMember(m.id); }}
                      title="Delete member"
                      style={{ fontSize: 12, color: INK.muted, background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px 0 2px', flexShrink: 0 }}
                      onMouseEnter={e => { (e.target as HTMLElement).style.color = STATUS.fail; }}
                      onMouseLeave={e => { (e.target as HTMLElement).style.color = INK.muted; }}
                    >🗑</button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* Legend footer */}
        <div style={{ padding: '10px 14px', borderTop: `1px solid ${BORDER.default}` }}>
          {[['Beam', MEMBER_COLOR.beam], ['Column', MEMBER_COLOR.column]].map(([t, c]) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
              <span style={{ fontSize: 10, color: INK.muted }}>{t}</span>
            </div>
          ))}
        </div>
        </aside>
      )}

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <header id="app-header" style={{ background: 'white', borderBottom: `1px solid ${BORDER.default}`, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          {/* Brand */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 2 }}>
            <div style={{ width: 28, height: 28, background: ACCENT.primary, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'white', flexShrink: 0 }}>
              SD
            </div>
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', color: INK.strong, lineHeight: 1.15 }}>S-Dashboard</div>
              <div style={{ color: INK.muted, fontSize: 11, whiteSpace: 'nowrap' }}>{project.code}</div>
            </div>
          </div>

          {/* Members pull-down toggle (replaces the old docked member column) */}
          <div data-popover="" style={{ position: 'relative' }}>
            <button
              onClick={() => { setMembersOpen(v => !v); setShowExport(false); setShowPrefs(false); }}
              style={{ ...hdrBtn, background: membersOpen ? ACCENT.softBg : 'white', color: membersOpen ? ACCENT.primary : INK.base }}
              title="Show the member list"
            >
              ☰ Members
            </button>
          </div>

          <div style={{ width: 1, height: 20, background: BORDER.default }} />

          {/* View tabs */}
          <div style={{ display: 'flex', gap: 4 }}>
            {([['map', '🗺 Viewer'], ['dashboard', 'Dashboard'], ['member', 'Member'], ['help', 'Help']] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: tab === key ? ACCENT.primary : 'transparent',
                  color: tab === key ? 'white' : INK.secondary,
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
              <span style={{ fontSize: 11, color: INK.secondary }}>Member:</span>
              <Dropdown
                value={activeMemberId}
                options={project.members.map(m => ({ value: m.id, label: `${m.id} — ${m.label}` }))}
                onChange={setActiveMemberId}
                style={{ background: 'white', border: `1px solid ${BORDER.strong}`, borderRadius: 6, padding: '4px 8px', fontSize: 12, color: INK.strong }}
              />
            </div>
          )}

          {/* Separator */}
          <div style={{ width: 1, height: 20, background: BORDER.default }} />

          {/* B5: Dirty indicator */}
          <span style={{ fontSize: 11, color: isDirty ? STATUS.fail : INK.muted, fontWeight: 600, minWidth: 70 }}>
            {isDirty ? '● Unsaved' : '✓ Saved'}
          </span>

          {/* B4: Undo/Redo */}
          <button onClick={undo} style={{ ...hdrBtn, fontSize: 14, padding: '3px 8px' }} title="Undo (Ctrl+Z)">↩</button>
          <button onClick={redo} style={{ ...hdrBtn, fontSize: 14, padding: '3px 8px' }} title="Redo (Ctrl+Y)">↪</button>

          <div style={{ width: 1, height: 20, background: BORDER.default }} />

          {/* File actions (New / Open / Save) live in the native File menu and the
              Ctrl+N/O/S shortcuts — no header buttons. */}
          <button
            onClick={() => setShowEtabsImport(true)}
            style={{ ...hdrBtn, borderColor: ACCENT.primary, color: ACCENT.primary }}
            title="Import beams from an ETABS model (CSI API or tables file)"
          >
            ⇪ ETABS
          </button>

          {/* E1: Export dropdown */}
          <div data-popover="" style={{ position: 'relative' }}>
            <button
              onClick={() => { setShowExport(v => !v); setShowPrefs(false); }}
              style={{ ...hdrBtn, background: showExport ? ACCENT.softBg : 'white', color: showExport ? ACCENT.primary : INK.base }}
            >
              Export ▾
            </button>
            {showExport && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200,
                background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.1)', padding: '6px', minWidth: 160,
              }}>
                <button
                  onClick={() => { setShowReport(true); setShowExport(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: INK.base, borderRadius: 6, fontWeight: 600 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  PDF Report…
                </button>
                <button
                  onClick={() => { exportExcel(project); setShowExport(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: INK.base, borderRadius: 6, fontWeight: 600 }}
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
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: INK.base, borderRadius: 6, fontWeight: 600 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Group Schedule PDF
                </button>
                <button
                  onClick={() => { exportGroupScheduleExcel(project); setShowExport(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: INK.base, borderRadius: 6, fontWeight: 600 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Group Schedule (Spreadsheet)
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
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: INK.base, borderRadius: 6 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Beam Schedule PDF <span style={{ fontSize: 10, color: INK.muted }}>(full)</span>
                </button>
                <button
                  onClick={() => { window.print(); setShowExport(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: INK.base, borderRadius: 6, fontWeight: 600 }}
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
              style={{ ...hdrBtn, background: showPrefs ? ACCENT.softBg : 'white', color: showPrefs ? ACCENT.primary : INK.base }}
              title="Preferences"
            >
              ⚙
            </button>
            {showPrefs && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200,
                background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.1)', padding: '12px 8px', minWidth: 190,
              }}>
                <div style={{ ...LABEL_STYLE, padding: '0 8px', marginBottom: 8 }}>
                  Design code
                </div>
                {(['ACI318-19', 'ACI318-14', 'EN1992-1-1'] as DesignCode[]).map(c => (
                  <button
                    key={c}
                    onClick={() => {
                      // Follow the code's native unit system: EC2 → SI, ACI → imperial.
                      if (c === 'EN1992-1-1' && project.code !== 'EN1992-1-1') setUnits('si');
                      else if (c !== 'EN1992-1-1' && project.code === 'EN1992-1-1') setUnits('imperial');
                      setProject(p => ({ ...p, code: c }));
                    }}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      width: '100%', padding: '6px 10px', border: 'none', borderRadius: 6,
                      cursor: 'pointer', fontSize: 13, textAlign: 'left',
                      background: project.code === c ? ACCENT.softBg : 'none',
                      color: project.code === c ? ACCENT.primary : INK.base,
                      fontWeight: project.code === c ? 700 : 400,
                    }}
                  >
                    <span>{c}</span>
                    {project.code === c && <span style={{ fontSize: 11 }}>✓</span>}
                  </button>
                ))}
                <div style={{ ...LABEL_STYLE, padding: '0 8px', margin: '12px 0 8px', borderTop: `1px solid ${BORDER.subtle}`, paddingTop: 12 }}>
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
                      background: zoom === z ? ACCENT.softBg : 'none',
                      color: zoom === z ? ACCENT.primary : INK.base,
                      fontWeight: zoom === z ? 700 : 400,
                    }}
                  >
                    <span>{z === 1.0 ? '100%  (default)' : `${Math.round(z * 100)}%`}</span>
                    {zoom === z && <span style={{ fontSize: 11 }}>✓</span>}
                  </button>
                ))}
                <div style={{ ...LABEL_STYLE, padding: '0 8px', margin: '12px 0 8px', borderTop: `1px solid ${BORDER.subtle}`, paddingTop: 12 }}>
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
                      background: units === u ? ACCENT.softBg : 'none',
                      color: units === u ? ACCENT.primary : INK.base,
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
          <div style={{ fontSize: 11, color: INK.secondary }}>{project.name}</div>
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
                onProjectUpdate={setProject}
                collapsedGroups={collapsedGroups}
                setCollapsedGroups={setCollapsedGroups}
              />
            )}
            {tab === 'map' && (
              <div style={{ height: '100%', display: 'flex' }}>
                <ErrorBoundary area="the model map">
                  <ModelMapView
                    project={project}
                    onProjectChange={setProject}
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
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: INK.strong }}>Input</h2>
                    <p style={{ fontSize: 11, color: INK.secondary, margin: '2px 0 0' }}>Edit geometry, materials, reinforcement, loads</p>
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
                  <div style={{ width: 3, borderRadius: 2, height: '40px', background: BORDER.strong }} />
                </div>

                {/* Right: Results */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ marginBottom: 10 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: INK.strong }}>{activeMember.label}</h2>
                    <p style={{ fontSize: 11, color: INK.secondary, margin: '2px 0 0' }}>
                      {activeMember.section.type.replace(/_/g, ' ')} &bull; {sectionLabel(activeMember)} &bull;
                      f'c = {fmt(activeMember.material.fc, 'stress')} &bull; fy = {fmt(activeMember.material.fy / 1000, 'stressKsi')}
                    </p>
                  </div>
                  <ErrorBoundary key={activeMember.id} area="the results view">
                    <MemberResults
                      member={activeMember}
                      code={project.code}
                      slsCombo={project.slsCombo}
                      engineer={project.engineer}
                      sconcreteResults={project.sconcreteResults}
                      sconcreteRanAt={project.sconcreteRanAt}
                      onRebarChange={handleUpdateMember}
                      midThirdTopBars={activeGroup?.midThirdTopBars}
                      oppositeTopBars={activeGroup?.oppositeTopBars}
                    />
                  </ErrorBoundary>
                </div>
              </div>
            )}
            {tab === 'help' && <HelpView target={helpTarget} />}
          </div>
        </main>
      </div>
    </div>
  );
}
