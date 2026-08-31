import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Project, Member, ModelMap, DesignGroup, DesignCode, ProjectSettings } from './types';
import { defaultProject } from './utils/sampleData';
import { buildDemoProject } from './utils/demoProject';
import { logActivity } from './utils/activity';
import { track, trackOnce, setUsageContext } from './utils/usage';
import {
  applyProjectSettings, coversFromSettings, loadStandards, materialFromSettings,
  saveStandards, settingsFromProject,
} from './utils/projectSettings';
import { runDesign } from './engines';
import { resolveCrack } from './utils/resolveCrack';
import { effectiveStatus } from './utils/overrides';
import { saveProject, openProject } from './utils/electronBridge';
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
import WelcomeScreen from './components/Welcome/WelcomeScreen';
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
  /**
   * The launch gate. Every start shows the welcome screen until a model is chosen
   * — imported from ETABS, opened from disk, or the demo taken deliberately. It is
   * session state, not persisted: "where is this model coming from" is a question
   * worth asking each time, and answering it is one click.
   */
  const [launched, setLaunched] = useState(false);
  // Project standards dialog: 'settings' whenever the header gear is used, and
  // 'setup' once — but only AFTER a model is in, so the dialog can pre-fill from
  // what was imported instead of asking for materials against a blank project.
  const [settingsMode, setSettingsMode] = useState<'setup' | 'settings' | null>(null);
  /** Pass the gate, and ask for standards on the way through if none are stored. */
  const enterWorkspace = useCallback(() => {
    setLaunched(true);
    if (!loadStandards()) setSettingsMode('setup');
  }, []);

  /**
   * "Explore the demo model" — load the built-in two-storey frame, then pass the gate.
   *
   * It is a real model, not the two-beam seed the app boots on: 34 beams over two
   * levels, columns, slabs, a core wall and grid lines, with design groups and station
   * forces, assembled by `buildDemoProject` through the same adapter path an ETABS
   * import walks. That matters because the panels this button exists to show — Model,
   * Groups, the group dashboard — have nothing to draw without a modelMap and groups,
   * which is exactly what the seed project lacks and why this used to open on an empty
   * plan.
   *
   * Standards stored from an earlier session are re-applied, same as on a normal start.
   * The per-section grades (4000 / 5000 psi) survive that: `applyProjectSettings` keeps
   * imported materials whenever a modelMap is present and the override is off.
   */
  const handleUseDemo = useCallback(async () => {
    // The launch gate is the app's first fork, and which way people go is the first
    // thing worth knowing: an install where everyone takes the demo and nobody ever
    // reaches an import is a very different problem from one where nobody gets past it.
    track('launch.choice', { choice: 'demo' });
    try {
      const demo = await buildDemoProject();
      const stored = loadStandards();
      const next = stored
        ? applyProjectSettings({ ...demo, code: stored.code }, stored.settings)
        : demo;
      setProjectRaw(next);
      // A fresh model is a fresh history, and it is not the file the last one lived in.
      historyRef.current = [next];
      historyIndexRef.current = 0;
      setActiveMemberId(next.members[0].id);
      setFilePath(null);
      setIsDirty(false);
      setTab('map');
      logActivity(`Demo model loaded — ${next.members.length} beams, `
        + `${next.designGroups?.length ?? 0} groups, ${next.modelMap?.stories.length ?? 0} storeys`);
    } catch (err) {
      logActivity(`Could not build the demo model: ${(err as Error).message}`, 'error');
    }
    enterWorkspace();
  }, [enterWorkspace]);
  const [helpTarget, setHelpTarget] = useState<{ tab?: string; section?: string } | null>(null);
  const { units, setUnits, setBarFamily, fmt } = useUnits();

  // B5: dirty indicator
  const [isDirty, setIsDirty] = useState(false);
  /**
   * The file this project is currently associated with, or null for one that has never
   * been written. It is what separates Save from Save As: with a path, Ctrl+S overwrites
   * silently; without one it has to ask, which is a Save As by another name.
   *
   * Always null in a browser — a page is handed file CONTENT, never a path it could
   * write back to — so there both commands download, and this stays null on purpose
   * rather than pretending to a location the page does not have.
   */
  const [filePath, setFilePath] = useState<string | null>(null);

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
  /**
   * Write the project. `asNew` forces the picker; otherwise it goes straight to the
   * file this project came from, and only asks when there isn't one yet.
   */
  const saveWith = useCallback(async (asNew: boolean) => {
    try {
      const { saved, filePath: written } = await saveProject(project, asNew ? null : filePath);
      track('project.save', { asNew, saved, members: project.members.length });
      // Only clear the dirty flag when the file was actually written
      // (not when the user cancelled the save dialog).
      if (!saved) return;
      if (written) setFilePath(written);
      setIsDirty(false);
    } catch (e) {
      track('project.save', { asNew, saved: false, error: (e as Error).message }, 'error');
      alert(`Could not save the project:
${(e as Error).message}`);
    }
  }, [project, filePath]);

  const handleSave = useCallback(() => saveWith(false), [saveWith]);
  const handleSaveAs = useCallback(() => saveWith(true), [saveWith]);

  const handleOpen = useCallback(async () => {
    try {
      const opened = await openProject();
      if (!opened) { track('project.open', { opened: false }); return false; } // cancelled
      const loaded = opened.project;
      // The file's own FILE_VERSION is recorded separately, by deserializeProject —
      // it is stripped before the project reaches here.
      track('project.open', {
        opened: true,
        code: loaded.code,
        members: loaded.members.length,
        groups: loaded.designGroups?.length ?? 0,
        hasModelMap: !!loaded.modelMap,
        hasSettings: !!loaded.settings,
      });
      // Adopt the file as this session's save target, so the next Ctrl+S writes back to
      // it instead of asking again. Undefined in a browser, which correctly leaves the
      // project pathless.
      setFilePath(opened.filePath ?? null);
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
      // A saved project carries its own standards, so this never needs the setup
      // dialog — but it does pass the launch gate.
      setLaunched(true);
      return true;
    } catch (e) {
      alert(`Could not open the project file:\n${(e as Error).message}`);
      return false;
    }
  }, [setUnits, setBarFamily]);

  /**
   * File → New Project. Returns to the LAUNCH SCREEN, not to a workspace holding the
   * sample beams.
   *
   * "New project" is the same question the app asks on a cold start — where is this
   * model coming from: ETABS, a saved file, or the demo? Dropping straight into the
   * workspace answered it silently with "the demo", which is the one option an engineer
   * starting real work never wants, and left them deleting sample beams to begin.
   *
   * The project is still reset behind the gate so whichever route they pick starts
   * clean, and the STANDARDS carry forward — a new project should not silently revert to
   * stock ACI defaults once the engineer has set their own. That is why this does not
   * re-open the setup dialog: `enterWorkspace` asks for standards only when none are
   * stored, so a first run still gets the dialog and a later New Project does not.
   */
  const handleNewProject = useCallback(() => {
    // Only ask when there is something to lose. A prompt that fires whether or not any
    // work would be destroyed carries no information, and the habit it trains — click
    // through it — is exactly what loses the one that mattered.
    //
    // Gating on `isDirty` is only safe because this is a useCallback that CLOSES OVER a
    // current one, and because it is in the Electron-menu effect's dependencies below.
    // As a plain function it was registered once with whatever `isDirty` happened to be
    // at the time, and a stale `false` there would skip the prompt and take unsaved work
    // with it. That it did not already misfire was luck: `handleSave` depends on
    // `project`, so the effect re-ran on every edit and re-registered this by accident.
    if (isDirty && !confirm('Start a new project? Unsaved changes will be lost.')) return;
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
    // A fresh project is not the file the last one lived in — forgetting the path is
    // what stops the first Ctrl+S from silently overwriting the project just closed.
    setFilePath(null);
    // Back through the launch gate, with nothing left open over it: a modal from the
    // project just closed, floating above the welcome screen, belongs to a model that no
    // longer exists.
    setShowEtabsImport(false);
    setSettingsMode(null);
    setLaunched(false);
  }, [isDirty]);

  function changeZoom(z: number) {
    setZoom(z);
    localStorage.setItem('sc-zoom', String(z));
  }

  // ── Usage log ──────────────────────────────────────────────────────────────
  // COUNTS AND CODES ONLY. Model size and design code are what make a report legible
  // ("EC2, 900 members" is a different app from "ACI, 12"); names and geometry are the
  // client's and never leave. Emitted only when one of them changes — see usage.ts.
  useEffect(() => {
    setUsageContext({
      code: project.code,
      members: project.members.length,
      groups: project.designGroups?.length ?? 0,
      stories: project.modelMap?.stories.length ?? 0,
      frames: project.modelMap?.frames.length ?? 0,
      units,
      zoom,
    });
  }, [project.code, project.members.length, project.designGroups?.length,
      project.modelMap?.stories.length, project.modelMap?.frames.length, units, zoom]);

  // Which screen, and how long they stayed. The dwell time between two `view` events is
  // the whole point: a Member panel opened and left inside two seconds, over and over,
  // is someone hunting for something they are not finding.
  useEffect(() => { track('view', { tab }); }, [tab]);

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
  // Undo is the app's clearest confession that something did not do what was expected —
  // an edit surprised someone, or a control was harder to aim than it looked. A run of
  // them in one place is worth more than any satisfaction survey, so the depth goes with
  // it: three in a row is a different story from one.
  function undo() {
    if (historyIndexRef.current <= 0) { track('edit.undo', { at: 0, blocked: true }); return; }
    historyIndexRef.current--;
    track('edit.undo', { at: historyIndexRef.current, tab });
    const prev = historyRef.current[historyIndexRef.current];
    setProjectRaw(prev);
    setIsDirty(historyIndexRef.current > 0);
  }

  function redo() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    track('edit.redo', { at: historyIndexRef.current, tab });
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
      // Shift+S first: with Shift held the browser reports 'S', so a lowercase-only
      // test would miss Save As and then fall through to Save — silently overwriting
      // the very file the user was trying to branch away from.
      if (e.key.toLowerCase() === 's' && !inElectron) {
        e.preventDefault();
        (e.shiftKey ? handleSaveAs : handleSave)();
      }
      if (e.key === 'o' && !inElectron) { e.preventDefault(); handleOpen(); }
      if (e.key === 'n') { e.preventDefault(); handleNewProject(); }
      if (e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (e.key === 'y') { e.preventDefault(); redo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, activeMemberId, tab, handleSave, handleSaveAs, handleOpen]);

  // ── Electron menu → renderer events ───────────────────────────────────────
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    api.onTriggerSave(handleSave);
    // Optional — a renderer running against an older preload simply has no Save As
    // accelerator rather than throwing on startup.
    api.onTriggerSaveAs?.(handleSaveAs);
    api.onTriggerOpen(handleOpen);
    api.onNewProject(handleNewProject);
    return () => {
      api.offTriggerSave();
      api.offTriggerSaveAs?.();
      api.offTriggerOpen();
      api.offNewProject();
    };
  }, [handleSave, handleSaveAs, handleOpen, handleNewProject]);

  // ── Click outside to close popovers ───────────────────────────────────────
  useEffect(() => {
    if (!membersOpen) return;
    function close(e: MouseEvent) {
      if (!(e.target as Element).closest('[data-popover]')) {
        setMembersOpen(false);
      }
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [membersOpen]);

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
  /**
   * The ETABS wizard, and HOW it was opened.
   *
   *   'com'  — from the launch gate's "Import from the running ETABS model". That
   *            button IS the source question, so the wizard connects on open and goes
   *            straight to Filter rather than asking the same thing again.
   *   'ask'  — from the File menu or the workspace, where nothing has been chosen yet
   *            and the source picker is the first ask, not a second one.
   */
  const [showEtabsImport, setShowEtabsImport] = useState<false | 'ask' | 'com'>(false);

  // File → Import from ETABS…, from the NATIVE menu — the only route to it in the
  // desktop app now that the in-page menu bar is the browser's fallback. Its own effect
  // beside the state it sets, rather than in the menu block above, which runs before
  // this line and so cannot reach the setter.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onImportEtabs) return;
    api.onImportEtabs(() => setShowEtabsImport('ask'));
    return () => api.offImportEtabs?.();
  }, []);

  // Open the Help tab, closing any open dialog first so the guide is visible.
  // Two entry points funnel here: a panel's "?" (HelpLink → window `open-help`
  // event, carries a doc section) and the native Help menu (Electron IPC, carries
  // a sub-tab). HelpView reads `target` to pick the sub-tab / scroll to a section.
  const openHelpTarget = useCallback((t: { tab?: string; section?: string }) => {
    setShowEtabsImport(false);
    // A NEW object every time, deliberately: asking for the same tab twice in a row must
    // re-open the modal, and the workspace syncs on this prop's identity. There is no
    // 'help' TAB any more - the workspace is the only shell, and it owns the modal.
    setHelpTarget({ ...t });
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
    // The end of the import funnel — the event every `wizard.*` before it is measured
    // against. Reaching it at all is the number that matters; the split between members
    // and groups says whether auto-grouping did anything useful.
    track('import.complete', {
      members: members.length,
      groups: groups.length,
      frames: modelMap?.frames.length ?? 0,
      stories: modelMap?.stories.length ?? 0,
      code: applyCode ?? project.code,
      units: applyUnits,
      hasSls: !!slsCombo,
    });
    trackOnce('milestone.imported');
    // The model is in — leave the launch gate. Standards are asked for now rather
    // than before, so the dialog pre-fills from what was just imported.
    enterWorkspace();
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
      {/* The launch gate. The workspace is not rendered until a model has been
          chosen; the modals below stay mounted either way, because the ETABS
          wizard is opened FROM this screen. */}
      {!launched && (
        <WelcomeScreen
          onImportEtabs={() => { track('launch.choice', { choice: 'import' }); setShowEtabsImport('com'); }}
          onOpenProject={() => { track('launch.choice', { choice: 'open' }); return handleOpen(); }}
          onUseDemo={handleUseDemo}
        />
      )}
      {launched && <WorkspaceView
        project={project}
        setProject={setProject}
        onSettingsSave={handleSettingsSave}
        onSaveProject={handleSave}
        onSaveProjectAs={handleSaveAs}
        onOpenProject={handleOpen}
        onNewProject={handleNewProject}
        onImportEtabs={() => setShowEtabsImport('ask')}
        helpTarget={helpTarget}
      />}

      {/* App-owned modals. They outlive any one panel, and two of them (the ETABS
          wizard and the first-run setup) can rewrite the whole project — so they stay
          here rather than inside a workspace that is only ever a view of it. */}
      {showEtabsImport && (
        <EtabsImportWizard
          code={project.code}
          autoSource={showEtabsImport === 'ask' ? undefined : showEtabsImport}
          onClose={() => setShowEtabsImport(false)}
          onImport={handleEtabsImport}
        />
      )}
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
