import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Project, Member, ModelMap, DesignGroup, DesignCode, ProjectSettings } from './types';
import { defaultProject } from './utils/sampleData';
import {
  applyProjectSettings, coversFromSettings, loadStandards, materialFromSettings,
  saveStandards, settingsFromProject,
} from './utils/projectSettings';
import { runDesign } from './engines';
import { resolveCrack } from './utils/resolveCrack';
import { effectiveStatus } from './utils/overrides';
import { saveProject, openProject } from './utils/electronBridge';
import { exportExcel, exportDcrList } from './utils/export/excelExport';
import { buildSchedulePDF, buildDcrListPDF } from './utils/export/schedulePdfExport';
import { exportGroupScheduleExcel } from './utils/export/groupScheduleExcel';
import ReportModal from './components/ReportModal';
import Dashboard from './components/Dashboard/Dashboard';
import HelpView from './components/Help/HelpView';
import MemberResults from './components/Results/MemberResults';
import MemberEditor from './components/SectionInput/MemberEditor';
import EtabsImportWizard from './components/EtabsImport/EtabsImportWizard';
// The panel workspace IS the shell now: Plan, Groups, Section, Calc, Loads, Force,
// Elevation, Editor, Group Dashboard and S-Concrete, each dockable, floatable and
// detachable into its own window. App keeps what only App can do — the project object,
// disk, the ETABS wizard — and hands the workspace the project plus those actions.
import WorkspaceView from './workspace/WorkspaceView.jsx';
import './workspace/ui.css';
import './workspace/shell.css';
import ModelMapView from './components/ModelMap/ModelMapView';
import ErrorBoundary from './components/common/ErrorBoundary';
import ProjectSettingsDialog from './components/Settings/ProjectSettingsDialog';
import Dropdown from './components/common/Dropdown';
import { Icon } from './components/common/Icon';
import type { IconName } from './components/common/Icon';
import { useUnits } from './contexts/UnitsContext';
import { MEMBER_COLOR, FONT, SURFACE, STATUS, INK, BORDER, ACCENT, ICON } from './theme';

type Tab = 'dashboard' | 'map' | 'member' | 'help';

const hdrBtn: React.CSSProperties = {
  padding: '5px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
  background: 'white', fontSize: 12, cursor: 'pointer', color: INK.base, fontWeight: 600,
  // inline-flex so an <Icon> and its label share one baseline
  display: 'inline-flex', alignItems: 'center', gap: 6,
};

/** Governing status for a member (respecting engineer overrides), used for the
 *  sidebar group NG/warn badges. 'Warning' → near-capacity, 'NG' → inadequate. */
function memberBadge(m: Member, code: DesignCode, slsCombo?: string, cotTheta?: number, ignoreTorsion?: boolean): 'OK' | 'warn' | 'NG' {
  let sawNG = false, sawWarn = false;
  for (const l of m.loads) {
    const r = runDesign(m.section, m.material, m.rebar, l, m.span, code, resolveCrack(m, code, slsCombo), cotTheta, ignoreTorsion);
    const st = effectiveStatus(r, m.overrides);
    if (st === 'NG') sawNG = true;
    else if (st !== 'OK') sawWarn = true;
  }
  return sawNG ? 'NG' : sawWarn ? 'warn' : 'OK';
}

/**
 * The project the app opens with. When standards were confirmed in a previous
 * session they are re-applied to the sample project, so a returning engineer
 * lands on their own materials, cover and code rather than the ACI defaults.
 */
function initialProject(): Project {
  const stored = loadStandards();
  if (!stored) return defaultProject;
  return applyProjectSettings({ ...defaultProject, code: stored.code }, stored.settings);
}

export default function App() {
  // ── Core state ────────────────────────────────────────────────────────────
  const [project, setProjectRaw] = useState<Project>(initialProject);
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
  // Project standards dialog: 'setup' on a first run (no way out — the project
  // needs standards), 'settings' whenever the header gear is used.
  const [settingsMode, setSettingsMode] = useState<'setup' | 'settings' | null>(
    () => (loadStandards() ? null : 'setup'),
  );
  const [showExport, setShowExport] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [helpTarget, setHelpTarget] = useState<{ tab?: string; section?: string } | null>(null);
  const { units, setUnits, setBarFamily, fmt } = useUnits();

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
    for (const m of project.members) out[m.id] = memberBadge(m, project.code, project.slsCombo, project.cotTheta, project.ignoreTorsion);
    return out;
  }, [project.members, project.code, project.slsCombo, project.cotTheta, project.ignoreTorsion]);

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
      // A project carries its own standards — adopt its unit system and scale so
      // the screens read in the units it was designed in.
      if (loaded.settings) {
        setUnits(loaded.settings.units);
        setBarFamily(loaded.settings.barFamily);
        setZoom(loaded.settings.displayScale);
        localStorage.setItem('sc-zoom', String(loaded.settings.displayScale));
      }
    } catch (e) {
      alert(`Could not open the project file:\n${(e as Error).message}`);
    }
  }, [setUnits, setBarFamily]);

  function handleNewProject() {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
    // Native confirm() can steal keyboard focus from the window in Electron
    window.focus();
    // Carry the office standards forward — a new project should not silently
    // revert to the stock ACI defaults once the engineer has set their own.
    const stored = loadStandards();
    const fresh = stored
      ? applyProjectSettings({ ...defaultProject, code: stored.code }, stored.settings)
      : defaultProject;
    setProjectRaw(fresh);
    historyRef.current = [fresh];
    historyIndexRef.current = 0;
    setActiveMemberId(fresh.members[0].id);
    setTab('dashboard');
    setIsDirty(false);
  }

  function changeZoom(z: number) {
    setZoom(z);
    localStorage.setItem('sc-zoom', String(z));
  }

  // ── Project standards ──────────────────────────────────────────────────────
  // Projects saved before the setup dialog existed have no `settings`; derive a
  // set from their first member so the dialog opens on their real values.
  // Units and scale come from the LIVE state rather than the stored settings —
  // the ETABS import wizard can switch display units on its own, and the dialog
  // must open showing what is actually on screen.
  const activeSettings: ProjectSettings = useMemo(
    () => ({ ...(project.settings ?? settingsFromProject(project)), units, displayScale: zoom }),
    [project, units, zoom],
  );

  /**
   * Commit the standards: they are written onto every member (so the engines,
   * screens and exports all see them), mirrored into the live unit system and
   * display scale, and remembered for the next session.
   */
  function handleSettingsSave(next: { name: string; code: DesignCode; settings: ProjectSettings }) {
    setProject(p => applyProjectSettings({ ...p, name: next.name, code: next.code }, next.settings));
    setUnits(next.settings.units);
    setBarFamily(next.settings.barFamily);
    changeZoom(next.settings.displayScale);
    saveStandards(next.code, next.settings);
    setSettingsMode(null);
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
    if (!showExport && !membersOpen) return;
    function close(e: MouseEvent) {
      if (!(e.target as Element).closest('[data-popover]')) {
        setShowExport(false);
        setMembersOpen(false);
      }
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showExport, membersOpen]);

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
    setShowEtabsImport(false); setShowReport(false); setShowExport(false);
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
    // Seeded from the project standards, so a new member starts on the same
    // materials and cover as everything else in the project.
    const newMember: Member = {
      id,
      label: `New Member ${id}`,
      memberType: 'beam',
      span: 20,
      material: materialFromSettings(activeSettings),
      section: { type: 'rectangular_beam', b: 14, h: 22, stirrupDia: 4, ...coversFromSettings(activeSettings) },
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
    <div id="app-root" style={{ height: '100vh', overflow: 'hidden', fontFamily: FONT.ui }}>
      <WorkspaceView
        project={project}
        setProject={setProject}
        onSettingsSave={handleSettingsSave}
        onSaveProject={handleSave}
        onOpenProject={handleOpen}
        onNewProject={handleNewProject}
        onImportEtabs={() => setShowEtabsImport(true)}
      />

      {/* App-owned modals. They outlive any one panel, and two of them (the ETABS
          wizard and the first-run setup) can rewrite the whole project — so they stay
          here rather than inside a workspace that is only ever a view of it. */}
      {showEtabsImport && (
        <EtabsImportWizard
          code={project.code}
          onClose={() => setShowEtabsImport(false)}
          onImport={handleEtabsImport}
        />
      )}
      {showReport && <ReportModal project={project} onClose={() => setShowReport(false)} />}
      {settingsMode === 'setup' && (
        <ProjectSettingsDialog
          mode="setup"
          projectName={project.name}
          code={project.code}
          settings={activeSettings}
          imported={!!project.modelMap}
          onSave={handleSettingsSave}
        />
      )}
    </div>
  );
}
