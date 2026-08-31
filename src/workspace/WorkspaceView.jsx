import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { breakdownFor, chartsFor, comboNames, designMemberAllRows, forceSeries, modelSignatureOf, NEAR_CAPACITY, regionsFor, stationEnvelope, suggestAllGroupsChunked, summaryMaps } from './design'
import StatusBar from './StatusBar'
import { beginActivity } from '../utils/activity'
import { track, trackTiming } from '../utils/usage'
import { togglePerf } from '../utils/perfProbe'
import { PANEL_ORDER, PANELS, canDetach } from './popoutBus'
import { loadLayout, saveLayout, clearLayout, DEFAULT_LAYOUT } from './layout'
import { exportMenuItems } from './exportMenu'
import PreferencesDialog from './PreferencesDialog'
import ReportModal from '../components/ReportModal.tsx'
import usePopoutHost from './usePopoutHost'
import Portal from './Portal'
import Workspace from './Workspace'
import useDockDrag from './useDockDrag'
import { defaultLayout, placePanel, reconcile } from './dockLayout'
import {
  DOCK, closeWindowPanels, mergeWindows, movePanelToWindow, newWinId, panelsInWindow, windowIds, windowLabel,
} from './windowDock'
// The app's own header chips, not lookalikes. `hdrBtn` below is the app's chip style
// (src/App.tsx:32) and Icon is the app's icon set, so a chip here is the same object
// the product ships — same 12px/600 label, same 1px #d1d5db border, same
// ACCENT.softBg/ACCENT.primary "on" convention.
import { Icon } from '../components/common/Icon.tsx'
import ProjectSettingsDialog from '../components/Settings/ProjectSettingsDialog.tsx'
import { defaultSettings } from '../utils/projectSettings.ts'
import { ACCENT, BORDER, INK } from '../theme.ts'
import Menu from './Menu'
import GroupRail from './GroupRail'
import RailDock from './RailDock'
import UnitsSync from './UnitsBridge'
import { useFmt } from './format'
import SectionPanel from './panels/SectionPanel'
import SconcretePanel from './panels/SconcretePanel'
import CalcPanel from './panels/CalcPanel'
import LoadsPanel from './panels/LoadsPanel'
import ForcePanel from './panels/ForcePanel'
import ElevationPanel from './panels/ElevationPanel'
import EditorPanel from './panels/EditorPanel'
import DashboardPanel from './panels/DashboardPanel'
import PlanPanel from './panels/PlanPanel'
import GroupsPanel from './panels/GroupsPanel'
import { buildDashboardPayload } from '../utils/dashboardPayload.ts'
import HelpView from '../components/Help/HelpView.tsx'
import MenuBar from './MenuBar'
import PushToEtabsDialog from './PushToEtabsDialog'
// The write half of the ETABS round trip: plan builder, runner, summary.
import { SECTION_PUSH_STEPS, canPushSections, emptyPushOutcome, runSectionPush, summarizeSectionPush } from '../adapters/etabs/pushSections'
import { stationLoadCases } from '../adapters/etabs'
import { ComConnection } from '../adapters/etabs/comClient'
import { resizedGroups, defaultModelName } from './etabsPush'
// The plan's colour schemes are the APP's, not a demo subset — same modes, same metrics,
// same palettes, computed by the same functions. A mode that looked right here and
// different in the app would be worse than not having it.
import { METRIC_MODES, concGradeLabel, steelGradeLabel } from '../components/ModelMap/frameColor.ts'
import { flexSteelRatioPct, stirrupAvPerFt, steelWeightPerFt } from '../utils/autoGroup.ts'
import { beamMarkEnd } from '../utils/curtailment.ts'
import { CATEGORICAL } from '../theme.ts'
import {
  IconCalc, IconDashboard, IconDiagram, IconEditor, IconElevation, IconGroups,
  IconPlan, IconSection, IconTable, IconVerify,
} from './icons'

// Stable empties, so a project with no model map or no groups yet does not hand the
// panels a fresh [] on every render and re-run every memo that depends on one.
const EMPTY_MAP = { frames: [], grids: [], columns: [], walls: [], stories: [] }
const EMPTY_GROUPS = []

const PANEL_ICON = {
  section: IconSection, calc: IconCalc, loads: IconTable, force: IconDiagram,
  elevation: IconElevation, editor: IconEditor, dashboard: IconDashboard, plan: IconPlan,
  groups: IconGroups, sconcrete: IconVerify,
}

// The app's header-chip style, value-for-value from src/App.tsx:32. Copied rather than
// imported because it is a module-local const over there, not an export — but it is the
// same six declarations, and the "on" state follows the app's convention too: background
// ACCENT.softBg, colour ACCENT.primary. Icon-only chips shrink the padding to 5px 8px.
const hdrBtn = {
  padding: '5px 10px', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
  background: 'white', fontSize: 12, cursor: 'pointer', color: INK.base, fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
// A floating panel opens over the WORKSPACE, never over the rail: the rail is 258px, so
// starting left of that would cover the group tree the panel is describing — and cover
// the only control that changes what it shows. Staggered per panel too, so floating two
// of them does not put one exactly on top of the other with its header, and its close
// button, unreachable underneath.
const RAIL_W = 258
const DEFAULT_GEOM = kind => {
  const i = PANEL_ORDER.indexOf(kind)
  return { x: RAIL_W + 28 + i * 34, y: 116 + i * 30, w: 560, h: 400 }
}

// The main window.
//
// It owns ALL the state. Panels are handed props and hand back events — they never reach
// for app state, and they never know whether they are tiled in the workspace, floating
// over it, or living in their own window. That single rule is what makes the attach /
// detach story work at all, and it is worth keeping even if nothing is ever detached,
// because it is also what makes the panels testable.
export default function WorkspaceView({
  project, setProject,
  // The product's own flows, owned by App because they touch disk, ETABS and the
  // Electron menu. The workspace only offers the affordance; App does the work.
  onSettingsSave, onSaveProject, onSaveProjectAs, onOpenProject, onNewProject, onImportEtabs,
  /** {tab} or {section} pushed in from App - the native Help menu, F1, a panel's "?". */
  helpTarget: externalHelp,
}) {
  const saved = useMemo(loadLayout, [])

  // ── the model this workspace edits ──────────────────────────────────────────
  // The demo read a frozen MEMBERS array from data.js and layered edits over it in a
  // `memberEdits` map. The product has no such baseline: `project.members` IS the model,
  // it is what the ETABS import writes, what .scdb save/open round-trips, and what the
  // S-Concrete batch reads. So an edit here is a write to the project, and the overlay
  // is gone — which is the whole reason import, save and S-Concrete work in this shell
  // without any of them being ported.
  const baseMembers = project.members
  const MODEL_MAP = project.modelMap ?? EMPTY_MAP

  /** Edit the project's members. Every writer in this file goes through here. */
  const setMembers = useCallback(
    up => setProject(p => ({ ...p, members: typeof up === 'function' ? up(p.members) : up })),
    [setProject],
  )
  /** Patch specific members by id — what the demo's `memberEdits` overlay did, done
   *  against the project's own array so the change is saved, exported and re-designed
   *  like any other. `patch` receives the current member and returns the fields to
   *  merge. */
  const patchMembers = useCallback((ids, patch) => {
    const want = ids instanceof Set ? ids : new Set(ids)
    setMembers(ms => ms.map(m => (want.has(m.id) ? { ...m, ...patch(m) } : m)))
  }, [setMembers])

  /** Edit the project's design groups. */
  const setProjectGroups = useCallback(
    up => setProject(p => ({ ...p, designGroups: typeof up === 'function' ? up(p.designGroups ?? []) : up })),
    [setProject],
  )

  // The model as it was when this project was OPENED — the "as imported" baseline the
  // Push dialog diffs against to decide which groups were resized. A ref, not state:
  // it must not move when the project does, and re-deriving it from the current members
  // would make every group look unchanged.
  const baselineRef = useRef(project.members)
  // Re-baseline when a NEW model arrives. Captured once at mount it described whatever
  // project was open then — after an ETABS import that is the old sample, so every
  // imported beam compared against nothing and Push reported no resized groups at all.
  const baselineKeyRef = useRef(project.modelMap)
  if (baselineKeyRef.current !== project.modelMap) {
    baselineKeyRef.current = project.modelMap
    baselineRef.current = project.members
  }
  const [memberId, setMemberId] = useState(saved.memberId)
  const [groupId, setGroupId] = useState(saved.groupId)
  // Design code, settings and units live on the PROJECT, not here. They were local in
  // the demo because there was no project to hold them; keeping them local now would
  // give the app two answers to "what code is this job?" — and the one the engine reads
  // would be whichever the last dialog happened to write.
  const code = project.code
  // Memoised: the ?? fallback builds a NEW object each render, and this feeds the
  // members memo, so an unmemoised fallback re-ran the entire design pass on every
  // render of a project that had no settings yet.
  const settings = useMemo(
    () => project.settings ?? defaultSettings(project.code),
    [project.settings, project.code],
  )
  const units = settings.units ?? 'imperial'
  // No longer switchable from the toolbar — the Inter/Segoe chip was a Template-era
  // control the app has no equivalent for. The state stays because every panel payload
  // carries it across the popout bus (a detached window inherits no <html> attribute).
  const [font] = useState(saved.font)
  const [hosts, setHosts] = useState(saved.hosts)
  const [geom, setGeom] = useState(saved.geom)
  const [openGroups, setOpenGroups] = useState(saved.openGroups)
  const [railOpen, setRailOpen] = useState(saved.railOpen)
  const [railPinned, setRailPinned] = useState(saved.railPinned)
  const [railW, setRailW] = useState(saved.railW)
  const [dock, setDock] = useState(saved.dock)          // null until first reconcile
  // Detached windows are CONTAINERS: `winOf` says which window holds each detached panel
  // and `winDock` is that window's own column layout. Together with `hosts` and `dock`
  // they are the whole "where is everything" model — see windowDock.js, which owns the
  // operations on them so no reducer here has to reason about two levels at once.
  const [winOf, setWinOf] = useState(saved.winOf || {})
  const [winDock, setWinDock] = useState(saved.winDock || {})
  const [maximized, setMaximized] = useState(saved.maximized)
  // Storeys are now a HIDE set rather than a single choice: the Filter lets several be
  // on at once, and "hidden" is the shape MapCanvas already takes.
  const [hiddenStories, setHiddenStories] = useState(saved.hiddenStories)
  const [planElements, setPlanElements] = useState(saved.planElements)
  const [planColorMode, setPlanColorMode] = useState(saved.planColorMode)
  // Which face the ρ ramp measures. Only meaningful in the 'flexSteel' mode, but it is a
  // view preference like any other, so it persists rather than resetting every time you
  // pass through that mode.
  const [flexFace, setFlexFace] = useState(saved.flexFace)
  const [lineWeightScale, setLineWeightScale] = useState(saved.lineWeightScale ?? 0.35)
  const [planDiagram, setPlanDiagram] = useState(saved.planDiagram)
  // Which load combination the M / V overlay draws. '' = the envelope across all of them.
  // A view preference like the projection, so it persists with the rest of the layout.
  const [planCombo, setPlanCombo] = useState(saved.planCombo ?? '')
  // The DCR colour scale — where the four bands cut, and what colour each one is. A view
  // preference like the projection and the overlay, so it rides in the saved layout
  // rather than resetting every reload: a scale you have to re-tune each time is a scale
  // nobody tunes.
  const [dcrThresholds, setDcrThresholds] = useState(saved.dcrThresholds)
  const [dcrColors, setDcrColors] = useState(saved.dcrColors)
  const [view3d, setView3d] = useState(saved.view3d)
  const [storyBefore3d, setStoryBefore3d] = useState(saved.storyBefore3d)
  const [selectedFrames, setSelectedFrames] = useState([])
  // ── grouping ────────────────────────────────────────────────────────────────
  // The grouping is MODEL, not layout, so it lives here and is deliberately NOT
  // persisted: a demo that boots with yesterday's half-finished grouping makes it
  // impossible to tell what data.js actually ships from what you did to it last time.
  // Reset puts it back.
  const liveGroups = project.designGroups ?? EMPTY_GROUPS
  const setGroups = setProjectGroups
  const [activeGroupId, setActiveGroupId] = useState(null)
  const [groupsTab, setGroupsTab] = useState(saved.groupsTab)
  // The auto-group wizard's live proposal. It is a PREVIEW — it colours the plan and
  // nothing else — until Commit turns it into real groups through the same setter a
  // hand-made group goes through.
  const [autoOverlay, setAutoOverlay] = useState([])
  const [highlightFrames, setHighlightFrames] = useState([])
  // Deleting a member DELETES it from the project now — there is no pristine array to
  // hide it from, and a save that still carried a beam the engineer removed would be
  // wrong on disk as well as on screen.
  // What the last click selected. A GROUP and a MEMBER are different things to look at,
  // and the Section panel shows a different component for each — the group's template
  // cage with the set's envelope on it, or one beam's own dimensioned section.
  const [selectionKind, setSelectionKind] = useState(saved.selectionKind || 'member')
  const [liveGroupRebar, setGroupRebar] = useState({})   // groupId -> RebarLayout (the template)
  const [rowSel, setRowSel] = useState({})           // memberId -> load row id
  const [menu, setMenu] = useState(null)             // {x, y, items}
  // S-Concrete verification results, as they come back from a batch run. Held here
  // rather than in the panel because two other things read them: the plan's "S-Concrete
  // pass/fail" colour mode (which stays hidden until there is something to colour), and
  // the panel itself after it has been detached and re-docked. `null` = never run.
  const [sco, setSco] = useState({ results: null, ranAt: null, slsCombo: null })
  // ── project settings ────────────────────────────────────────────────────────
  // The app's real ProjectSettingsDialog, behind the app's real gear chip. This is where
  // the demo's units and design code now live, because it is where the PRODUCT keeps
  // them: there is no unit toggle and no code selector in the app's header — the gear is
  // the only door to either (plus materials, cover, moduli and bar family). A demo that
  // toggled units from a chip the app does not have was demonstrating a control that
  // does not exist.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [prefsOpen, setPrefsOpen] = useState(false)
  // How the map draws each element kind. A MACHINE preference, not project data — it
  // rides with the layout for the same reason the panel arrangement does.
  const [elementStyles, setElementStyles] = useState(saved.elementStyles)

  // The NATIVE Preferences menu, in the packaged app. The in-page menu bar is hidden in
  // the desktop build, so without this the entry exists only in the browser — which is
  // exactly how it shipped in 0.1.16. Subscribed here rather than in App because this is
  // where the dialog's state lives; `off` on unmount so a re-mount cannot double-fire.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.onOpenPreferences) return undefined
    api.onOpenPreferences(() => setPrefsOpen(true))
    return () => api.offOpenPreferences?.()
  }, [])
  // A one-line status beside the Export button: "Building …", or why a build failed.
  // The PDF builders fetch and embed fonts, so they take a visible moment and can fail
  // — without this, a click on a PDF entry looks like a control that does nothing.
  const [exportNote, setExportNote] = useState(null)
  const [query, setQuery] = useState('')
  const [failsOnly, setFailsOnly] = useState(false)
  // ✨ Suggest: the one-line outcome the sweep reports. The size-floor DIALOG is not
  // here — it belongs to the Group Dashboard panel, so it opens in whichever window the
  // button was pressed in. Only the floors it collects come back.
  const [suggestNote, setSuggestNote] = useState(null)
  // The sweep is long enough to click twice. The status bar narrates it, but the button
  // that started it is on the Group Dashboard — which may be on another screen with the
  // strip nowhere in sight — so it reports its own state as well.
  const [suggestBusy, setSuggestBusy] = useState(false)
  // What a DETACHED panel is told when its button opened a dialog over here — see
  // `revealHere`. Separate from `suggestNote` so it can be cleared the moment the dialog
  // closes without taking a real outcome ("12 groups resized") down with it.
  const [awayNote, setAwayNote] = useState(null)
  // ── model versions ──────────────────────────────────────────────────────────
  // Each push freezes the working model under a name and keeps its designs, so the
  // dashboard can be pointed at "what the model said before I resized anything" and at
  // "what it says after", and the difference is the answer to the question that made
  // someone resize a group in the first place.
  //
  // Frozen deliberately: a version holds its OWN members and designs, not a recipe for
  // re-deriving them. A recipe would silently follow later edits and the comparison —
  // the entire point — would quietly stop being one.
  // Held in the PROJECT, not in local state, so they go into the one `.scdb` and a past
  // design survives closing the app — which is the whole reason to keep one. `designs`
  // are re-derived below rather than stored: they follow deterministically from the
  // frozen members, code and prefs, and storing them would double the file to hold
  // numbers the engine can reproduce.
  const versions = useMemo(() => {
    const raw = project.modelVersions ?? []
    return raw.map(v => ({
      ...v,
      groups: v.groups ?? [],
      groupRebar: v.groupRebar ?? {},
      designs: v.members.map(m => designMemberAllRows(m, v.code, v.prefs ?? {})),
    }))
  }, [project.modelVersions])
  const [modelVersion, setModelVersion] = useState('live')
  const [pushOpen, setPushOpen] = useState(false)
  const [pushBusy, setPushBusy] = useState(null)   // the live push step, or null
  // The prompt lives exactly as long as the dialog it points at. Cleared on close rather
  // than by whoever closed it, so cancel, confirm, Escape and a click on the backdrop all
  // retire it — a note still saying "confirm in the main window" over a dialog that is
  // no longer open would be worse than no note at all.
  useEffect(() => { if (!pushOpen) setAwayNote(null) }, [pushOpen])
  // Which Help sub-tab the menu asked for; null = closed. 'about' is the app's native
  // dialog, which a web page has no equivalent of, so it gets a panel of its own.
  const [helpTarget, setHelpTarget] = useState(null)
  /**
   * Help opened from OUTSIDE this component: the native Electron menu, F1, and every
   * panel's "?" deep-link. All three land in App.tsx, which kept a `helpTarget` and a
   * `setTab('help')` for the old tabbed shell and rendered `HelpView` in neither. The
   * workspace is the only shell now, so those three routes did nothing at all - and in
   * the packaged app the native menu is the ONLY Help menu, so every entry under it
   * opened an empty screen. Mirroring the prop into local state is what connects them.
   */
  useEffect(() => {
    if (!externalHelp) return
    setHelpTarget(externalHelp.section ? { section: externalHelp.section } : (externalHelp.tab ?? 'guide'))
  }, [externalHelp])
  // STABLE object for HelpView. Built inline as `{{ tab }}` it is a new reference every
  // render, so HelpView's deep-link effect re-runs and forces its sub-tab back - which
  // would fight the reader clicking tabs inside the guide.
  const helpView = useMemo(
    () => (helpTarget && typeof helpTarget === 'object' ? helpTarget : { tab: helpTarget }),
    [helpTarget],
  )
  // `label` and `toDisplay` are for the plan's metric colour ramps — the only numbers
  // the main window formats itself now that the header strip is gone; everything else a
  // panel renders, it formats.
  const { label, toDisplay, barFamily } = useFmt()

  // The font toggle is a document-level attribute rather than a prop drilled into every
  // component, because it has to reach portalled popups too — they mount on <body>,
  // outside the app tree, and inherit nothing from it.
  useEffect(() => { document.documentElement.dataset.font = font }, [font])

  // Persist the layout, not the model. Rebar edits and row selections are deliberately
  // NOT saved: this is a demo of a shell, and a stale edit surviving a reload would make
  // it impossible to tell what the engine actually produces from a clean start.
  useEffect(() => {
    saveLayout({ memberId, groupId, code, font, units, hosts, winOf, winDock, geom, elementStyles, openGroups, hiddenStories, planElements, planColorMode, planDiagram, planCombo, flexFace, lineWeightScale, dcrThresholds, dcrColors, view3d, storyBefore3d, groupsTab, selectionKind, dock, maximized, railOpen, railPinned, railW })
  }, [memberId, groupId, code, font, units, hosts, winOf, winDock, geom, elementStyles, openGroups, hiddenStories, planElements, planColorMode, planDiagram, planCombo, flexFace, lineWeightScale, view3d, storyBefore3d, groupsTab, selectionKind, dock, maximized, railOpen, railPinned, railW])

  // ── model ───────────────────────────────────────────────────────────────────
  // Edits are whole MEMBERS, not just cages: the Editor panel can change geometry and
  // materials too, and one override shape keeps every writer — section drawing, editor,
  // group apply — landing in the same place.
  const liveMembers = useMemo(() => {
    const base = baseMembers
    // ── Imported grades vs the project grade ──────────────────────────────────
    // This is applyProjectSettings' rule (projectSettings.ts:192) —
    //
    //     keepImported = !!project.modelMap && !s.overrideImportedMaterials
    //     material: keepImported ? m.material : { ...m.material, ...material }
    //
    // — applied here rather than in the save handler. Every member in this model carries
    // its own ETABS grade (data.js gives the girders 5 ksi and the fillers 4), and
    // writing the project-wide number over the top would silently flatten a mixed-grade
    // frame to one figure. So it only happens when the engineer ticks the box.
    //
    // DERIVED, not written into memberEdits, which is the one place this improves on the
    // app: the app mutates project.members, so unticking cannot restore what it
    // overwrote. Here the override is a lens over the model — tick and every beam reads
    // the project grade, untick and each one is back on the grade its own ETABS section
    // defined, with any Editor edit or group-move adoption underneath still intact.
    if (!settings.overrideImportedMaterials) return base
    return base.map(m => ({
      ...m,
      material: {
        ...m.material,
        fc: settings.fc, fy: settings.fy, fyt: settings.fyt,
        lambdaConcrete: settings.lambdaConcrete,
      },
    }))
  }, [baseMembers, settings])
  // The plan has to lose a deleted beam too, or the model and the map disagree about
  // what exists — and clicking the ghost line would select a member that is gone.
  const frames = useMemo(() => {
    // Set, not .some(). A linear scan per frame makes this O(frames x members), which is
    // invisible on the 174-beam demo and quadratic on an ETABS import.
    const live = new Set(baseMembers.map(m => m.id))
    return (MODEL_MAP.frames ?? []).filter(f => !f.memberId || live.has(f.memberId))
  }, [MODEL_MAP, baseMembers])
  /** memberId → frameName. One map, because every "show me these members on the plan"
   *  path — the active group, an auto-group bin, the rail's selection — needs it. */
  const frameOf = useMemo(() => {
    const m = new Map()
    for (const f of frames) if (f.memberId) m.set(f.memberId, f.frameName)
    return m
  }, [frames])
  // Every member, every load row, through the real engine — ~7,000 rows, under 40 ms.
  // Eager because it is what lets the rail carry live DCRs; if it ever stops being
  // affordable the fix is a cache keyed on member identity, not a cheaper number.
  /**
   * The project's design preferences, in one object.
   *
   * Bundled rather than passed one at a time because `runDesign` takes them
   * POSITIONALLY, and a call site that stops short of an argument silently designs under
   * different rules with no type error. That is exactly how "Neglect torsion" ended up
   * honoured in the member panel, the dashboard and the .SCO writers — but NOT in this
   * shell, which is the UI most of the work actually happens in.
   */
  const designPrefs = useMemo(() => ({
    cotTheta: project.cotTheta,
    ignoreTorsion: project.ignoreTorsion,
    // The EC2 crack check reads its quasi-permanent moments from this combo's station
    // forces. Omitted, every EC2 crack DCR in the shell falls back to `qpFactor × Mu`
    // while the member screen and the .SCO writers use the real Mqp — the same beam,
    // two different SLS demands.
    slsCombo: project.slsCombo,
  }), [project.cotTheta, project.ignoreTorsion, project.slsCombo])

  const liveDesigns = useMemo(
    () => liveMembers.map(m => designMemberAllRows(m, code, designPrefs)),
    [liveMembers, code, designPrefs],
  )

  /**
   * Is the working model still exactly the newest frozen one?
   *
   * Immediately after a push it is — the push freezes what you have, so "Working model"
   * and the model you just made are the same thing under two names. Listing both turns a
   * two-model job (the one you opened, the one you pushed) into a three-entry picker
   * where two entries are identical, which is what made the list confusing.
   *
   * A cheap structural signature rather than a deep compare: what distinguishes one
   * revision from the next is the sections, the cages and the demand, so those are what
   * it reads. It is only deciding whether to show a row — a false "changed" costs a
   * redundant entry, not a wrong number.
   */
  const modelSignature = useCallback(ms => modelSignatureOf(ms), [])

  const workingIsNewest = useMemo(() => {
    const newest = versions[versions.length - 1]
    if (!newest) return false
    return modelSignature(liveMembers) === modelSignature(newest.members)
  }, [versions, liveMembers, modelSignature])

  // ── which model the workspace is showing ────────────────────────────────────
  // A pushed version is a FROZEN model: its own members, its own designs, the groups and
  // cages it had when it was made. Selecting one points the whole workspace at it — the
  // rail's DCRs, the plan's colours, the section, the calc sheet, the force diagram and
  // the dashboard all describe the same model, because a picker in the top bar beside
  // the project settings reads as global and a global-looking control with a local
  // effect is worse than either.
  //
  // And it is READ-ONLY, necessarily: a frozen snapshot has no future. Every mutator
  // below returns early rather than forking a version behind the user's back, and the
  // top bar says so beside the picker.
  const frozenModel = useMemo(() => {
    const v = versions.find(x => x.id === modelVersion) || null
    // Selecting the newest model while the working model still equals it is not
    // "viewing history" — it is the model you are working in, under its own name.
    // Treating it as frozen would lock the workspace the moment a push finished, so the
    // engineer could not resize again for the next revision.
    const newest = versions[versions.length - 1]
    if (v && newest && v.id === newest.id && workingIsNewest) return null
    return v
  }, [versions, modelVersion, workingIsNewest])
  const readOnly = !!frozenModel
  const members = frozenModel ? frozenModel.members : liveMembers
  const designs = frozenModel ? frozenModel.designs : liveDesigns
  const groups = frozenModel ? frozenModel.groups : liveGroups
  const groupRebar = frozenModel ? frozenModel.groupRebar : liveGroupRebar
  const designById = useMemo(() => new Map(designs.map(d => [d.member.id, d])), [designs])
  const design = designById.get(memberId) || designs[0]
  const member = design.member

  const totals = useMemo(() => ({
    members: designs.length,
    rows: designs.reduce((n, d) => n + d.rows.length, 0),
    fails: designs.filter(d => d.dcr > 1).length,
    warns: designs.filter(d => d.dcr > 0.9 && d.dcr <= 1).length,
  }), [designs])

  // The SELECTED row — what the Calc Sheet shows. Defaults to the row that produced the
  // member's worst check, so opening a red beam already shows you why.
  const selectedRow = useMemo(() => {
    const want = rowSel[memberId]
    const hit = want && design.rows.find(r => r.load.id === want)
    return hit || design.governing.row
  }, [design, rowSel, memberId])
  const selectRow = useCallback(id => setRowSel(s => ({ ...s, [memberId]: id })), [memberId])

  // Which panels are tiled right now. Everything else — floating, detached, closed — is
  // out of the layout, and coming back in is just another reconcile.
  const dockedKinds = useMemo(
    () => PANEL_ORDER.filter(k => hosts[k] === 'dock'),
    [hosts],
  )

  // One effect keeps the layout honest: whenever the set of docked panels changes, panels
  // that left are dropped and panels that arrived are placed. Normalising afterwards is
  // what makes "the rest adjust seamlessly" fall out for free — the survivors' fractions
  // are rescaled to fill, so closing a panel never leaves a hole.
  useEffect(() => {
    setDock(cur => {
      const base = cur && cur.cols.length ? cur : defaultLayout(dockedKinds)
      return reconcile(base, dockedKinds)
    })
  }, [dockedKinds])

  // A maximised panel that stops being docked must not keep the workspace hostage.
  useEffect(() => {
    if (maximized && hosts[maximized] !== 'dock') setMaximized(null)
  }, [maximized, hosts])

  // ── where panels live ───────────────────────────────────────────────────────
  //
  // The four pieces of "where is everything" are separate useState, but a move touches
  // all of them at once and each has to see the others' CURRENT value — a panel leaving
  // window w2 for w1 changes hosts, winOf, both window layouts and possibly the dock. A
  // ref gives the mover one coherent snapshot; functional setState could not, because
  // each updater only sees its own slice.
  const dockStateRef = useRef(null)
  dockStateRef.current = { hosts, winOf, winDock, dock }
  const hostRef = useRef(null)

  /**
   * Move a panel to a window. THE one way anything changes where a panel lives.
   *
   * `to` is a window id, `'dock'` for the main workspace, or `'new'` to allocate a fresh
   * window. Every route lands here — the header buttons, the context menu, a drag inside
   * this window, a drag from a detached window, a tear-off — so there is exactly one
   * place that has to be right, and the popout bus can express a move as data rather
   * than as a sequence of host changes that could interleave.
   */
  const movePanel = useCallback((kind, to, target) => {
    const cur = dockStateRef.current
    const winId = to === 'new' ? newWinId(cur.hosts, cur.winOf) : to
    const next = movePanelToWindow(cur, kind, winId, target || null)
    setHosts(next.hosts)
    setWinOf(next.winOf)
    setWinDock(next.winDock)
    setDock(next.dock)
    // A maximised panel and a move are incompatible: the panel being moved may be the
    // maximised one, and even if not, the workspace behind it has just changed shape.
    setMaximized(null)
    // Bring the destination forward, or the drop lands on a window still behind this one
    // and reads as nothing having happened.
    if (winId !== DOCK && hostRef.current) hostRef.current.focusWindow(winId)
  }, [])

  const setHost = useCallback((kind, host) => {
    // 'window' is no longer a place — it is a place PER WINDOW. Detaching means "into a
    // new window of its own", which is what it always meant when a window could only
    // hold one panel.
    if (host === 'window') { movePanel(kind, 'new'); return }
    setHosts(h => ({ ...h, [kind]: host }))
    setWinOf(w => { if (!w[kind]) return w; const n = { ...w }; delete n[kind]; return n })
  }, [movePanel])
  const closePanel = useCallback(kind => {
    setHosts(h => ({ ...h, [kind]: null }))
    setWinOf(w => { if (!w[kind]) return w; const n = { ...w }; delete n[kind]; return n })
  }, [])
  const togglePanel = useCallback(kind => setHosts(h => ({ ...h, [kind]: h[kind] ? null : 'dock' })), [])
  const setGeomFor = useCallback((kind, g) => setGeom(all => ({ ...all, [kind]: g })), [])

  const pickMember = useCallback((id, gid) => {
    setSelectionKind('member')
    setMemberId(id)
    if (gid) setGroupId(gid)
    // Keep the plan's selection and storey with the member, so picking a beam in the
    // rail highlights it on the plan instead of leaving the two views disagreeing.
    setSelectedFrames([id])
    // Picking a beam on a hidden storey would select something you cannot see, so
    // un-hide that storey rather than switching to it — the rest of the filter stands.
    const m = baseMembers.find(x => x.id === id)
    if (m && m.level) setHiddenStories(h => (h.includes(m.level) ? h.filter(x => x !== m.level) : h))
  }, [])

  /** Clicking a group HEADING selects the group itself; it does not reach in and pick a
   *  member. That is what lets the Section panel answer "what cage does this group
   *  carry?" instead of "what is the first beam in it?". */
  //
  //  One notion of "the group I am looking at", set from anywhere. The rail, the Group
  //  Dashboard's list and the Groups panel all land here, so the Section panel, the
  //  dashboard's beam list and the plan's focus can never end up describing three
  //  different groups — which is exactly what happened while the Groups panel kept its
  //  own `activeGroupId` and nothing else read it.
  /**
   * Select a group — or, with null, turn the selection OFF.
   *
   * The null branch is what makes clicking the already-active group in the Group
   * Dashboard deselect it. Selecting a group focuses the plan on its beams and
   * halftones everything else (see focusFrames), and without a way to undo that from
   * the same click that caused it, the plan stays filtered to one group and the rest of
   * the model is unreachable from the dashboard. The app's own GroupDashboard cards have
   * always toggled this way (`g.id === selectedGroupId ? null : g.id`); the demo's group
   * list was the thing that did not.
   *
   * Deselecting drops back to the MEMBER, rather than leaving every group-shaped panel
   * blank: emptying a panel is a worse answer to "deselect" than showing the beam you
   * already had selected. Same rule pickActiveGroup follows.
   */
  const pickGroup = useCallback(gid => {
    if (!gid) {
      setActiveGroupId(null)   // the plan drops its focus — the whole model is back
      setGroupId(null)
      setSelectionKind('member')
      return
    }
    setSelectionKind('group')
    setGroupId(gid)
    setActiveGroupId(gid)
  }, [])

  /** The Groups panel's selection. Null means "no active group" — that clears the plan's
   *  focus but deliberately leaves the Section on the last group, because emptying a
   *  panel is a worse answer to "deselect" than leaving it showing what it showed. */
  const pickActiveGroup = useCallback(gid => {
    setActiveGroupId(gid)
    if (gid) { setSelectionKind('group'); setGroupId(gid) }
  }, [])

  /** The plan's own selection. A single pick also moves the workspace to that beam —
   *  which is what makes the plan a navigator rather than a picture. */
  const onSelectFrames = useCallback(names => {
    setSelectedFrames(names)
    if (names.length === 1) {
      const id = frames.find(f => f.frameName === names[0])?.memberId
      if (!id) return                       // an unlinked frame selects nothing
      setSelectionKind('member')
      const g = groups.find(x => x.memberIds.includes(id))
      setMemberId(id)
      if (g) setGroupId(g.id)
    }
  }, [frames, groups])

  // ── grouping ────────────────────────────────────────────────────────────────
  // Every writer lands in ONE setter. A group made by lassoing the plan and a group
  // committed from the auto-group wizard are the same object afterwards — there is no
  // "auto" mode to be stuck in — so the rail, the plan, the Section panel and the Group
  // Dashboard all follow either without knowing which made it.
  const onGroupsChange = useCallback(next => {
    if (readOnly) return   // a frozen version has no future; see frozenModel

    setGroups(next)
    // The header, the rail and the Section panel all describe `groupId`. If the group it
    // names has just been dissolved they would be describing nothing, so move to a group
    // that still exists rather than rendering a blank.
    setGroupId(cur => (next.some(g => g.id === cur) ? cur : (next[0]?.id ?? null)))
  }, [readOnly])

  /**
   * Delete ONE beam. The member is removed and everything follows from that: the plan
   * filters frames to live members, the design memo re-runs, every rollup re-counts.
   *
   * No confirm — `setProject` in App pushes a 20-deep undo history, so Ctrl+Z is the
   * undo, and a modal on every delete is friction for an action that is already
   * reversible. It is a no-op on a frozen version, like every other writer here.
   */
  const deleteMember = useCallback(id => {
    if (readOnly) return
    const frameName = frameOf.get(id)
    setMembers(ms => ms.filter(m => m.id !== id))
    onGroupsChange(groups.map(g => (
      g.memberIds.includes(id) ? { ...g, memberIds: g.memberIds.filter(x => x !== id) } : g
    )))
    // selectedFrames is populated as frame NAMES by the plan (onSelectFrames) and as a
    // member ID by pickMember, so drop both rather than betting on which one put this
    // beam there.
    setSelectedFrames(names => names.filter(n => n !== id && n !== frameName))
    // Leaving every other panel describing a beam that no longer exists reads as a
    // frozen UI; move the selection to any survivor.
    setMemberId(cur => (cur === id ? (baseMembers.find(m => m.id !== id)?.id ?? cur) : cur))
  }, [readOnly, groups, onGroupsChange, frameOf, baseMembers])

  /** Delete a group AND its beams. The members go into a removal set; the design memo,
   *  the plan and every rollup follow from that one fact. */
  const onDeleteGroupWithMembers = useCallback(gid => {
    if (readOnly) return   // a frozen version has no future; see frozenModel

    const g = groups.find(x => x.id === gid)
    if (!g) return
    const gone = new Set(g.memberIds)
    setMembers(ms => ms.filter(m => !gone.has(m.id)))
    onGroupsChange(groups.filter(x => x.id !== gid).map(x => ({
      ...x, memberIds: x.memberIds.filter(id => !gone.has(id)),
    })))
    setSelectedFrames(names => names.filter(n => !gone.has(n)))
    // Deleting the beam every other panel is describing would leave them all on a
    // fallback member while the header still named the dead one.
    setMemberId(cur => (gone.has(cur) ? (baseMembers.find(m => !gone.has(m.id))?.id ?? cur) : cur))
    if (activeGroupId === gid) setActiveGroupId(null)
  }, [groups, onGroupsChange, activeGroupId, readOnly])

  /** Commit the auto-group proposal. The preview overlay is dropped at the same moment:
   *  leaving it up would paint the plan with bins that are now real groups, shown in a
   *  different palette from the groups they became. */
  const onApplySuggestion = useCallback(next => {
    if (readOnly) return   // a frozen version has no future; see frozenModel

    onGroupsChange(next)
    setAutoOverlay([])
    setHighlightFrames([])
    setActiveGroupId(null)
    setGroupsTab('groups')
  }, [onGroupsChange, readOnly])

  // Stable identity, deliberately. AutoGroupPanel pushes its overlay from an effect keyed
  // on this callback, so a fresh arrow per render would re-fire it every render — and
  // since the overlay lands in state up here, that is an infinite loop. (GroupsPanel pins
  // it a second time for the detached case, where the bus rebuilds callbacks per render.)
  const onOverlayChange = useCallback(bins => setAutoOverlay(bins), [])
  const onHighlightFrames = useCallback(names => setHighlightFrames(names), [])

  /**
   * What a group's beams are supposed to look like — the thing a member ADOPTS when it
   * is moved into one.
   *
   * The donor is the group's GOVERNING beam (worst DCR), not its first: a group is one
   * cage checked against the whole set's envelope, so the beam that drives the design is
   * the one whose section and cage the group is actually detailed for. Taking
   * `memberIds[0]` would hand the newcomer whichever beam happened to be imported first,
   * which on a mixed group is the lightest one — and the moved beam would then read as
   * failing against a group that passes.
   *
   * The cage an Apply has set on the group wins over the donor's own, because that IS
   * the group's template; the section still comes from the donor, since a DesignGroup
   * carries no geometry of its own.
   */
  const groupTemplate = useCallback(gid => {
    const g = groups.find(x => x.id === gid)
    if (!g || !g.memberIds.length) return null
    let donor = null, worst = -Infinity
    for (const id of g.memberIds) {
      const d = designById.get(id)
      if (d && d.dcr > worst) { worst = d.dcr; donor = d.member }
    }
    if (!donor) return null
    return { section: donor.section, rebar: groupRebar[gid] || donor.rebar, donorId: donor.id }
  }, [groups, designById, groupRebar])

  /**
   * Move one beam into a group and make it look like that group: its section, its
   * material and its cage.
   *
   * Everything is DEEP-COPIED out of the donor. Handing the moved member the donor's own
   * section/rebar objects would alias them — edit the newcomer's bar count afterwards and
   * the beam it was copied from changes too, silently, along with every other member
   * sharing that reference. data.js takes the same care for the same reason.
   *
   * What deliberately does NOT change: span, position, loads. The beam keeps being where
   * it is and carrying what it carries — that is the analysis, not the design, and a
   * grouping gesture has no business rewriting it. So the moved beam gets the group's
   * detailing checked against its OWN demands, which is exactly the question worth
   * asking: does this group's cage work here?
   *
   * Material travels with the section because the app's own definition of what may share
   * a group (familyKey in autoGroup.ts) is section + f'c + fy. Leaving f'c behind would
   * put a 4 ksi beam in a group whose cage was sized for 5 ksi, where it would read as an
   * outlier against group-mates it is supposed to match.
   */
  const moveMemberToGroup = useCallback((memberId, gid) => {
    if (readOnly) return   // a frozen version has no future; see frozenModel

    const g = groups.find(x => x.id === gid)
    if (!g) return
    // Exclusive membership — the same rule GroupPanel's own add/assign follows.
    onGroupsChange(groups.map(x => x.id === gid
      ? { ...x, memberIds: x.memberIds.includes(memberId) ? x.memberIds : [...x.memberIds, memberId] }
      : { ...x, memberIds: x.memberIds.filter(id => id !== memberId) }))

    const t = groupTemplate(gid)
    if (!t || t.donorId === memberId) return   // empty group, or it is already the donor
    const r = t.rebar
    patchMembers([memberId], base => ({
      section: { ...t.section },
      material: { ...(designById.get(t.donorId)?.member.material ?? base.material) },
      rebar: {
        ...r,
        topBars: (r.topBars || []).map(b => ({ ...b })),
        botBars: (r.botBars || []).map(b => ({ ...b })),
        ...(r.sideBars ? { sideBars: r.sideBars.map(b => ({ ...b })) } : {}),
        ...(r.ties ? { ties: { ...r.ties } } : {}),
        ...(r.tieZones ? { tieZones: r.tieZones.map(z => ({ ...z })) } : {}),
      },
    }))
    setGroupId(gid)
  }, [groups, onGroupsChange, groupTemplate, designById, readOnly])

  /** 2D ↔ 3D. Tilting forces the storey filter to 'All', for two reasons: one storey seen
   *  in 3D is just a plan at an angle, and the columns — which are what make the model
   *  read as a building rather than a raft of beams — span BETWEEN storeys, so a
   *  single-storey filter hides nearly all of them. Coming back restores the storey you
   *  were working on instead of dropping you on 'All'. */
  const onView3d = useCallback(next => {
    setView3d(next)
    if (next) {
      setStoryBefore3d(hiddenStories)
      setHiddenStories([])          // show the whole building
    } else {
      setHiddenStories(prev => (storyBefore3d && !prev.length ? storyBefore3d : prev))
      setStoryBefore3d(null)
    }
  }, [hiddenStories, storyBefore3d])

  // ── panel payloads ──────────────────────────────────────────────────────────
  // Each memoised separately so an unchanged panel keeps its prop identities: publish()
  // runs on every render and shallow-compares before posting, so switching member does
  // not broadcast the Loads table to a window showing the Section.
  const onMemberChange = useCallback(m => {
    if (readOnly) return
    setMembers(ms => ms.map(x => (x.id === m.id ? m : x)))
  }, [readOnly, setMembers])
  /** Resize every beam in a group from the group card's dimensions — the section
   *  equivalent of applyGroupRebar, and the same reason: a group is one detail, so its
   *  drawing edits the set, not a representative member. */
  const applyGroupSection = useCallback((gid, section) => {
    const g = groups.find(x => x.id === gid)
    if (!g) return
    // Carry each member's OWN flange/cover across; only the dimensioned values move.
    patchMembers(g.memberIds, base => ({
      section: { ...base.section, b: section.b, bw: section.bw, h: section.h },
    }))
  }, [groups, patchMembers])

  /** Resize the beam from the section drawing. Same override store as every other member
   *  edit, so the engine re-runs and every panel follows — the drawing is just another
   *  way in. */
  const onSectionChange = useCallback(
    next => patchMembers([memberId], () => ({ section: next })),
    [memberId, patchMembers],
  )

  const onRebarChange = useCallback(
    r => {
      if (readOnly) return
      patchMembers([memberId], () => ({ rebar: r }))
    },
    [memberId, readOnly, patchMembers],
  )
  /** Apply a cage to every beam in a group — what the Group Dashboard's Apply does. */
  const applyGroupRebar = useCallback((gid, rebar) => {
    if (readOnly) return   // a frozen version has no future; see frozenModel

    const g = groups.find(x => x.id === gid)
    if (!g) return
    setGroupRebar(t => ({ ...t, [gid]: rebar }))
    patchMembers(g.memberIds, () => ({ rebar }))
  }, [groups, readOnly, patchMembers])

  // ── the group cage's L/3 detailing flags ────────────────────────────────────
  // The ⚑ / ◨ affordances on the group card are all "set this, or clear it", so one
  // helper covers four of them: writing `undefined` REMOVES the key, which is what the
  // rest of the app tests for (`group.midThirdTopBars?.length`). Writing an empty array
  // instead would read as "an explicit cage of no bars" and quietly defeat every
  // fallback that asks whether the field is set at all.
  const setGroupField = useCallback((gid, key, value) => {
    setGroups(gs => gs.map(g => {
      if (g.id !== gid) return g
      if (value === undefined || value === null || (Array.isArray(value) && !value.length)) {
        const next = { ...g }
        delete next[key]
        return next
      }
      return { ...g, [key]: value }
    }))
  }, [])

  /** Pin/unpin a face's L/3 curtailment % to the beam-schedule notes. */
  const setCurtailmentNote = useCallback((gid, face, on) => {
    setGroups(gs => gs.map(g =>
      g.id === gid ? { ...g, curtailmentNotes: { ...g.curtailmentNotes, [face]: on } } : g))
  }, [])

  const setOppositeTop = useCallback((gid, bars) => setGroupField(gid, 'oppositeTopBars', bars), [setGroupField])
  const setMidThirdTop = useCallback((gid, bars) => setGroupField(gid, 'midThirdTopBars', bars), [setGroupField])
  const setEndThirdBot = useCallback((gid, bars) => setGroupField(gid, 'endThirdBotBars', bars), [setGroupField])
  /** Engineer sign-off — a DISPLAY-layer override. The engines still compute the true
   *  DCRs; the group simply stops being presented as failing. */
  const setGroupReviewed = useCallback((gid, on) => setGroupField(gid, 'reviewed', on || undefined), [setGroupField])

  /**
   * ✨ Suggest — auto-size EVERY group's cage, the app's own sweep.
   *
   * Resolve all of them first, then apply in a single state update. Doing it group by
   * group would re-run the engine over all ~5,700 load rows once per group, and would
   * half-apply the sweep if one group could not be resolved.
   */
  const runSuggestAll = useCallback(async floors => {
    // Chunked, so the status bar can narrate it and the user can hold it at a group
    // boundary. Nothing below runs until every group has resolved, so a pause — or a
    // sweep abandoned while paused — leaves the model exactly as it was.
    const task = beginActivity({
      label: 'Suggest — preparing…',
      total: groups.length,
      pausable: true,
    })
    let rebarByGroup, note, stats
    setSuggestBusy(true)
    // Counted, not narrated. The status-bar sentence spends its length listing the groups
    // that failed and drops the REASON off the end — which is exactly the half needed to
    // answer "why did 10 of 12 not resolve". See createSweep.finish in design.js.
    // `from` separates this from the map's own sweep (ModelMapView.runSuggestAllGroups),
    // which is a second implementation of the same operation — without it the two are
    // indistinguishable in the log and neither can be compared against the other.
    const doneSweep = trackTiming('suggest.sweep', { from: 'workspace', groups: groups.length, code })
    try {
      ({ rebarByGroup, note, stats } = await suggestAllGroupsChunked(
        groups, members, code, barFamily, floors, undefined, designPrefs,
        {
          gate: () => task.gate(),
          onProgress: (done, total, label) => task.update({
            done,
            total,
            label: label
              ? `Sizing ${label} — group ${done + 1} of ${total}`
              : 'Applying suggested cages…',
          }),
        },
      ))
    } finally {
      // Both end on the throw path too: a bar — or a button — left saying "Sizing…"
      // after the sweep died is the one state that would make them liars.
      task.end(note ?? 'Suggest stopped')
      setSuggestBusy(false)
      // In the finally so an abandoned or thrown sweep is recorded as one. A sweep that
      // vanishes from the log is indistinguishable from a sweep nobody ran.
      doneSweep(stats ? { ...stats, applied: rebarByGroup?.size ?? 0 } : { aborted: true })
    }
    setSuggestNote(note)
    if (!rebarByGroup.size) return
    setGroupRebar(t => {
      const next = { ...t }
      for (const [gid, rebar] of rebarByGroup) next[gid] = rebar
      return next
    })
    setMembers(ms => {
      const byId = new Map()
      for (const g of groups) {
        const rebar = rebarByGroup.get(g.id)
        if (!rebar) continue
        for (const id of g.memberIds) byId.set(id, rebar)
      }
      return ms.map(m => (byId.has(m.id) ? { ...m, rebar: byId.get(m.id) } : m))
    })
  }, [groups, members, code, barFamily, setMembers, designPrefs])

  // `font` and `units` ride along in every payload because a detached window is a
  // separate document: it inherits neither the <html> attribute nor the React context.
  // Built once and shared: the Group Dashboard needs it, and so does the Section panel
  // in group mode. Memoised on the model, so an unchanged model costs nothing.
  // The governing result and worst DCR per member, built once. Three consumers want
  // them — the Group Dashboard payload, the Groups panel's per-group statistics, and the
  // plan's colouring — and rebuilding the same reduction three times over ~7,000 rows is
  // the one place in this app where that would actually be felt.
  const { resultById, dcrById, modeById } = useMemo(() => summaryMaps(designs), [designs])

  /**
   * The state of the model, as numbers — the one thing the log was missing entirely.
   *
   * Everything recorded up to now describes what the user DID. This records what the app
   * produced: how many members pass, how many are over capacity, which check is driving
   * each one. Without it a session reads "imported 123 members, ran Suggest" and stops
   * exactly where the interesting question starts — 123 members in what state, failing on
   * what? The per-mode counts are the part that generalises: shear governing 80% of a
   * model is a different product problem from flexure governing it.
   *
   * DEBOUNCED, and deliberately not memoised on every keystroke: this fires after imports,
   * sweeps and cage edits settle, not while a number is being typed into a spinner. Engine
   * truth, not the display layer — an engineer's "Reviewed" override belongs to their
   * judgement and is counted separately (`override.apply`), never folded in here.
   */
  useEffect(() => {
    if (!designs.length) return
    const t = setTimeout(() => {
      let ok = 0, warn = 0, ng = 0, worst = 0
      const governing = {}
      for (const d of designs) {
        const dcr = dcrById[d.member.id] ?? 0
        if (dcr > worst) worst = dcr
        if (dcr > 1) ng++; else if (dcr > NEAR_CAPACITY) warn++; else ok++
        const modes = modeById[d.member.id]
        if (modes) {
          // Which check is actually driving this member — the max across its modes.
          let key = null, top = 0
          for (const [k, v] of Object.entries(modes)) {
            if (typeof v === 'number' && v > top) { top = v; key = k }
          }
          if (key) governing[key] = (governing[key] || 0) + 1
        }
      }
      track('design.summary', {
        members: designs.length,
        ok, warn, ng,
        worstDcr: Math.round(worst * 100) / 100,
        governing,
        code,
        frozen: !!frozenModel,
      })
    }, 2000)
    return () => clearTimeout(t)
  }, [designs, dcrById, modeById, code, frozenModel])

  // The baseline: the model exactly as data.js describes it, which is what an ETABS
  // import would have handed over. Compared against the live model to decide what has
  // been resized, so a beam edited back to its original size correctly stops counting.
  /** A live push needs a bridge that can write AND members that are real ETABS frames —
   *  see the note on the demo's copy. An unlinked model simulates, automatically. */
  const canPushLive = useMemo(() => {
    const bridged = typeof window !== 'undefined' && !!window.electronAPI?.etabs
    if (!bridged || !canPushSections(new ComConnection())) return false
    return members.length > 0 && members.every(m => !!m.etabs?.frameName)
  }, [members])

  const resizedRows = useMemo(
    () => resizedGroups(groups.map(g => ({ ...g, dcrById })), members, baselineRef.current),
    [groups, members, dcrById],
  )

  /**
   * Freeze the working model under a new name and re-run it.
   *
   * The ETABS round trip: define one frame-section property per resized group, assign
   * the group's frames to it, File→Save As under the new name, then Analyze→Run.
   *  owns that sequence; this decides whether it can be run at all.
   *
   * Without a live model to write to, the same plan is built and the app's own engine
   * produces what the re-run would return, under a new version name. The dialog says
   * which of the two is about to happen.
   */
  /**
   * Run ONE step of the live push, keeping the connection open between calls.
   *
   * The dialog drives the sequence a button at a time, so the connection has to outlive
   * a single call — reconnecting per step would be four attaches, and worse, a step
   * could land on a different ETABS instance than the one before it. Held in a ref
   * rather than state because nothing renders from it and a re-render mid-push must not
   * drop it.
   */
  /**
   * Freeze the working model under a name and keep it.
   *
   * Called by BOTH push paths. The live one used to skip this entirely — it wrote to
   * ETABS and returned — so a real push produced a new .EDB and nothing to come back to
   * in the app, which is the opposite of what the history is for. The simulated path is
   * the one that always froze, so for a while the only revisitable designs were the ones
   * that never touched ETABS.
   */
  /**
   * Write re-analysed forces onto the members they came from.
   *
   * Shared by both push paths. The one-click path already ASKED for the forces — it runs
   * the same step list — and then dropped them on the floor, so a one-click push
   * re-analysed the model and went on designing against the old demand. Same bug as the
   * stepped path had, one level up.
   */
  const applyReimportedForces = useCallback((byFrame, combos) => {
    if (!byFrame) return { count: 0, members: null }
    const label = `ETABS env (${(combos ?? []).join(', ')})`
    const patch = (m) => {
      const fn = m.etabs?.frameName
      const next = fn ? byFrame[fn] : undefined
      if (!next || !next.length) return m
      return { ...m, stationForces: next, loads: stationLoadCases(next, label, m.span) }
    }
    setProject(p2 => ({ ...p2, members: p2.members.map(patch) }))
    // The same patch applied to the DERIVED members, returned for a caller that needs
    // them in this tick. `setProject` is async, so a caller freezing a version
    // immediately after would otherwise snapshot the state from BEFORE the re-import —
    // and keep the design against the old demand, which is the bug this whole step
    // exists to close. The patch only touches loads / stationForces, which the
    // derivation passes straight through, so patching either end gives the same array.
    const patched = members.map(patch)
    return { count: patched.filter((m, i) => m !== members[i]).length, members: patched }
  }, [setProject, members])

  /**
   * The model AS IMPORTED, frozen so the first push has something to be different from.
   *
   * Without it the picker was useless on the run that matters most. The engineer imports,
   * resizes, pushes — and the only two entries are "Working model" and rev 1, which by
   * then hold the same members, because rev 1 was frozen FROM the working model. The
   * state they actually want to compare against — original sections, original forces —
   * had been overwritten by the resize and then by the re-import, and was never kept.
   *
   * `baselineRef` already holds exactly those members: it is captured when a model
   * arrives and left alone through every edit, because "what resized" is measured
   * against it. This just stops it being thrown away.
   *
   * The groups are today's, which is an approximation: a group created after the import
   * did not exist at the baseline. The MEMBERS are the honest part — each carries its own
   * as-imported cage, and `groupRebar` is left empty so nothing overrides it.
   */
  const baselineVersion = useCallback(() => ({
    id: 'v-imported',
    name: `${MODEL_MAP.modelName || 'Model'} — as imported`,
    savedAt: new Date().toISOString(),
    code,
    prefs: designPrefs,
    members: baselineRef.current.map(m => ({ ...m })),
    groups: groups.map(g => ({ ...g, memberIds: g.memberIds.slice() })),
    groupRebar: {},
    properties: [],
  }), [MODEL_MAP.modelName, code, designPrefs, groups])

  const freezeVersion = useCallback(({ modelName, rows, membersOverride }) => {
    const snapshot = (membersOverride ?? members).map(m => ({ ...m }))
    const v = {
      id: `v${Date.now().toString(36)}`,
      name: modelName,
      savedAt: new Date().toISOString(),
      code,
      prefs: designPrefs,
      members: snapshot,
      groups: groups.map(g => ({ ...g, memberIds: g.memberIds.slice() })),
      groupRebar: { ...groupRebar },
      properties: (rows ?? []).map(r => ({ label: r.label, name: r.propertyName, b: r.to.b, h: r.to.h, fc: r.to.fc })),
    }
    setProject(p => {
      const existing = p.modelVersions ?? []
      // The baseline goes in ahead of the first pushed version, once, so the list reads
      // "as imported → rev 1 → rev 2" rather than starting at the first thing that
      // changed. Keyed off emptiness rather than a flag: a project that already has
      // versions has already had one.
      const withBase = existing.length || !baselineRef.current?.length
        ? existing
        : [baselineVersion(), ...existing]
      return { ...p, modelVersions: [...withBase, v] }
    })
    setModelVersion(v.id)
    return v.id
  }, [members, code, groups, groupRebar, designPrefs, setProject, baselineVersion])

  const pushConnRef = useRef(null)
  const pushOutRef = useRef(null)
  const onPushStep = useCallback(async (stepId, plan) => {
    // `setProject` is used by the re-import branch below; declared in the dep list so a
    // stale closure cannot write to a project that has since been replaced.
    try {
      if (!pushConnRef.current) {
        const conn = new ComConnection()
        await conn.connect()
        pushConnRef.current = conn
        pushOutRef.current = emptyPushOutcome(plan)
      }
      const step = SECTION_PUSH_STEPS.find(x => x.id === stepId)
      if (!step) return { ok: false, error: `Unknown push step "${stepId}".` }
      await step.run(pushConnRef.current, plan, pushOutRef.current)

      // The re-import is the one step whose result belongs to the MODEL rather than to
      // the push report, so it lands here: forces come back keyed by ETABS frame name,
      // and every member linked to one of those frames takes the new set.
      //
      // Written to the LIVE model, not just to the frozen version. The whole point is
      // that the beams you just enlarged are now carrying more moment; leaving the
      // working model on the old forces would keep showing the DCR that made you resize
      // them in the first place.
      if (stepId === 'reimport' && pushOutRef.current.forces) {
        // BOTH fields, and that is the whole fix. `stationForces` is the raw analysis
        // output — it draws the force diagram and nothing else. Every DCR, every
        // applied-force readout and the calc sheet run off `loads`, the expansion of
        // those stations into one LoadCase per station per combo. Writing only the raw
        // forces left the design on the demand from before the resize: the diagram
        // moved, the numbers did not, and the screen disagreed with itself.
        const { count } = applyReimportedForces(pushOutRef.current.forces, plan.combos)
        pushOutRef.current.reimported = count
        // Kept for the Finish button: by then React has re-rendered and `members` is
        // fresh, but carrying it costs nothing and removes the dependence on that.
        pushOutRef.current.patchedMembers = null
        return { ok: true, note: `${count} member${count === 1 ? '' : 's'} updated` }
      }
      // Per-step failures come back in the outcome rather than as a throw — a define
      // that skipped two properties is a partial success, and the button has to say so.
      const failed = pushOutRef.current.failures.length
      return { ok: true, note: failed ? `${failed} item${failed === 1 ? '' : 's'} failed` : undefined }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }, [applyReimportedForces])

  /** The stepped run finished — report it the way the one-click path does, and drop the
   *  connection so the next push starts clean. */
  const onPushDone = useCallback(({ modelName, rows } = {}) => {
    if (pushOutRef.current) setSuggestNote(summarizeSectionPush(pushOutRef.current))
    // Same reason as the one-click path: the run made a model, so the app keeps its
    // design. Done on FINISH rather than per step — a push abandoned half way produced
    // a copy but not a design worth naming.
    if (modelName) freezeVersion({ modelName, rows })
    pushConnRef.current = null
    pushOutRef.current = null
    setPushOpen(false)
  }, [freezeVersion])

  const onPush = useCallback(async ({ rows, modelName, plan, live }) => {
    void plan;
    if (live) {
      setPushBusy('Connecting to ETABS…')
      try {
        const conn = new ComConnection()
        await conn.connect()
        const out = await runSectionPush(conn, plan, step => setPushBusy(step))
        // The forces the last step read back — applied before freezing, so the version
        // that gets kept is the design against the NEW demand, not the old one.
        const { members: patched } = applyReimportedForces(out.forces, plan.combos)
        // Freeze it here too. The push produced a NEW ETABS model; the app has to keep
        // the design that went with it, or the picker never learns about the models the
        // engineer actually made. Frozen from the PATCHED members — see above.
        freezeVersion({ modelName, rows, membersOverride: patched })
        setSuggestNote(summarizeSectionPush(out))
        setPushBusy(null)
        setPushOpen(false)
        return
      } catch (e) {
        setPushBusy(null)
        setSuggestNote(`ETABS push failed: ${e?.message || e}`)
        return
      }
    }
    freezeVersion({ modelName, rows })
    setPushOpen(false)
  }, [freezeVersion])

  const versionOptions = useMemo(() => ([
    // "Working model" only appears once it has actually diverged from the newest pushed
    // one. Straight after a push there is nothing to diverge — the two are the same
    // model — so the list is just the ETABS models: the one you opened and the one you
    // pushed to.
    ...(workingIsNewest ? [] : [{ value: 'live', label: 'Working model (edited)' }]),
    // Newest first: the model you want is nearly always the one you just made, and a
    // list that grows downward puts it further away every push.
    ...[...versions].reverse().map(v => ({
      value: v.id,
      // The name is the ETABS file; the date is what tells two revisions apart when
      // someone has called them both "Tower-rev2".
      label: v.savedAt ? `${v.name} · ${new Date(v.savedAt).toLocaleDateString()}` : v.name,
    })),
  ]), [versions, workingIsNewest])

  // If the working model is the newest one and the picker is pointing at 'live', move the
  // selection onto that model's own entry — otherwise the control would show a value it
  // no longer offers, and render blank.
  useEffect(() => {
    if (workingIsNewest && modelVersion === 'live') setModelVersion(versions[versions.length - 1].id)
  }, [workingIsNewest, modelVersion, versions])

  const dashPayload = useMemo(() => {
    const withRebar = groups.map(g => ({ ...g, rebar: groupRebar[g.id] || g.rebar }))
    return buildDashboardPayload(withRebar, members, resultById, dcrById, modeById, code, units)
  }, [groups, members, groupRebar, resultById, dcrById, modeById, code, units])

  const sectionProps = useMemo(() => {
    // Which dimensions have been overridden, decided by comparing against the model as
    // it shipped rather than by tracking a flag. Derived state cannot drift: undo the
    // edit back to the original number and the * goes away on its own, which a flag
    // would need to be told about.
    const dimsChanged = (nowSec, wasSec) => {
      if (!nowSec || !wasSec) return undefined
      const isT = nowSec.type !== 'rectangular_beam'
      const wOf = sec => (isT ? (sec.bw ?? sec.b) : sec.b)
      return {
        b: Math.abs(wOf(nowSec) - wOf(wasSec)) > 1e-9,
        h: Math.abs((nowSec.h ?? 0) - (wasSec.h ?? 0)) > 1e-9,
      }
    }
    const orig = baseMembers.find(m => m.id === memberId)
    // In group mode the comparison is the same question asked of the group's own beams:
    // any member will do, since a resize applies to all of them at once.
    const gsel = selectionKind === 'group' ? groups.find(g => g.id === groupId) : null
    const gRef = gsel && gsel.memberIds[0]
    const editedDims = selectionKind === 'group'
      ? dimsChanged(
          (members.find(m => m.id === gRef) || {}).section,
          (baseMembers.find(m => m.id === gRef) || {}).section,
        )
      : dimsChanged(member.section, orig && orig.section)
    return {
      font, units, mode: selectionKind, memberId,
      section: member.section, rebar: member.rebar,
      result: design.governing.row.result,
      editedDims,
      group: selectionKind === 'group' ? dashPayload.groups.find(g => g.id === groupId) : undefined,
    }
  }, [font, units, selectionKind, memberId, member.section, member.rebar, design, dashPayload, groupId, members])

  const rowChecks = useMemo(() => design.checks.map(c => ({
    key: c.key, label: c.label, rowId: c.row.load.id, rowDcr: c.of(selectedRow.result),
  })), [design, selectedRow])

  const calcProps = useMemo(() => ({
    font, units, memberId, code, row: selectedRow.load, checks: rowChecks,
    sections: breakdownFor(design, selectedRow.load),
    // The N-vs-M window is laid out like S-Concrete's: the section as words down one
    // side and as a drawing down the other, so it has to carry the section, the cage and
    // the materials as well as the surface. All plain data — it crosses the popout bus
    // like everything else, and a detached Calc Sheet opens the same window.
    section: member.section, rebar: member.rebar, material: member.material,
    ...chartsFor(design, selectedRow.load),
  }), [font, units, memberId, code, design, selectedRow, rowChecks, member.section, member.rebar, member.material])

  const loadsProps = useMemo(() => {
    // Which check(s) each row governs — the table's most useful column, and the one that
    // makes "governing ≠ selected" visible rather than a rule to remember.
    const TAG = { flex: 'FLEX', shear: 'SHEAR', torsion: 'TORS', crack: 'CRACK' }
    const gov = new Map()
    for (const c of design.checks) {
      const list = gov.get(c.row.load.id) || []
      list.push(TAG[c.key] || c.label.toUpperCase())
      gov.set(c.row.load.id, list)
    }
    return {
      font, units, memberId,
      selectedId: selectedRow.load.id,
      rows: design.rows.map(({ load, result }) => ({
        id: load.id,
        combo: load.label.replace(/\s*@.*$/, ''),
        x: load.x,
        Mu_pos: load.Mu_pos, Mu_neg: load.Mu_neg, Vu: load.Vu, Tu: load.Tu,
        flex: Math.max(result.DCR_flex_pos, result.DCR_flex_neg),
        shear: result.DCR_shear,
        torsion: result.DCR_torsion,
        governs: gov.get(load.id) || [],
      })),
    }
  }, [font, units, design, memberId, selectedRow])

  const forceProps = useMemo(() => ({
    font, units, memberId, series: forceSeries(design), marker: selectedRow.load.x,
  }), [font, units, design, memberId, selectedRow])

  /** What the plan halftones AROUND. A transient auto-group highlight wins over the
   *  active group, because it answers a question you are asking right now ("which beams
   *  are in this bin?") over one you asked earlier. Empty means no focus at all — not
   *  "focus nothing", which would dim the whole model. */
  const focusFrames = useMemo(() => {
    if (highlightFrames.length) return highlightFrames
    const g = groups.find(x => x.id === activeGroupId)
    if (!g) return []
    return g.memberIds.map(id => frameOf.get(id)).filter(Boolean)
  }, [highlightFrames, groups, activeGroupId, frameOf])

  // ── what each colour mode needs ─────────────────────────────────────────────
  // The five METRIC modes (ρ, stirrups, weight, height, width) colour a continuous
  // value on the shared blue→red ramp, so each needs a value per member AND the range
  // to normalise against. Computed only for the ACTIVE mode: this is a pass over every
  // member, and four of the five results would be thrown away.
  //
  // Dimensions go through toDisplay() and the label through the app's unit labels — a
  // ramp legend reading "24.00" with no unit, or worse "in" while the toolbar says mm,
  // is exactly the hand-formatting this demo is not allowed to do.
  const { metricById, metricRange, metricLabel } = useMemo(() => {
    if (!METRIC_MODES.includes(planColorMode)) return {}
    const isDim = planColorMode === 'height' || planColorMode === 'width'
    const out = {}
    let min = Infinity, max = -Infinity
    for (const m of members) {
      if (!isDim && m.memberType !== 'beam') continue
      const s = m.section
      const v = planColorMode === 'flexSteel' ? flexSteelRatioPct(m, flexFace)
        : planColorMode === 'stirrups' ? stirrupAvPerFt(m)
          : planColorMode === 'weight' ? steelWeightPerFt(m).totalLbFt
            : planColorMode === 'height' ? toDisplay(s.h, 'length')
              : toDisplay(s.b, 'length')
      out[m.id] = v
      if (v < min) min = v
      if (v > max) max = v
    }
    if (min === Infinity) return {}
    return {
      metricById: out,
      metricRange: { min, max },
      metricLabel: planColorMode === 'flexSteel' ? `ρ${flexFace === 'bot' ? '⁺' : '⁻'} (%)`
        : planColorMode === 'stirrups' ? `Av/s (${label('areaPerLength')})`
          : planColorMode === 'weight' ? `Steel (${label('steelWeightPerLength')})`
            : planColorMode === 'height' ? `h (${label('length')})`
              : `b (${label('length')})`,
    }
  }, [members, planColorMode, flexFace, label, toDisplay])


  // Concrete / steel GRADE is categorical, not a ramp: distinct strengths get distinct
  // colours off the categorical palette (which carries no status hues, so a grade can
  // never be misread as a pass/fail). A Map, and it crosses the bus as one — structured
  // clone carries Maps natively and cloneable() passes them through whole.
  const gradeColorMap = useMemo(() => {
    if (planColorMode !== 'concGrade' && planColorMode !== 'steelGrade') return undefined
    const valOf = m => (planColorMode === 'concGrade' ? m.material.fc : m.material.fy)
    const distinct = [...new Set(members.map(valOf))].sort((a, b) => a - b)
    const byVal = new Map(distinct.map((v, i) => [v, CATEGORICAL[i % CATEGORICAL.length]]))
    return new Map(members.map(m => [m.id, byVal.get(valOf(m))]))
  }, [planColorMode, members])

  /** memberId → section width (in), for the plan's proportional line weight. The web
   *  width where there is one: a T-beam's flange is not what the line represents. */
  const widthById = useMemo(() => {
    const out = {}
    for (const m of members) out[m.id] = m.section.bw ?? m.section.b
    return out
  }, [members])

  /** Which end carries a beam's mark, so 'Group + tags' parks the tag near the governing
   *  support instead of at midspan where several beams' tags would collide. */
  const markEndById = useMemo(() => {
    if (planColorMode !== 'groupTags') return undefined
    const out = {}
    for (const m of members) {
      if (m.memberType && m.memberType !== 'beam') continue
      const me = beamMarkEnd(m)
      if (me) out[m.id] = me
    }
    return out
  }, [planColorMode, members])

  /** The legend for the two categorical GRADE modes. MapCanvas draws its own ramp for
   *  the metric modes but has nothing to say about grades, so the panel shows this. */
  const gradeLegend = useMemo(() => {
    if (!gradeColorMap) return []
    const si = units === 'si'
    const valOf = m => (planColorMode === 'concGrade' ? m.material.fc : m.material.fy)
    const labelOf = v => (planColorMode === 'concGrade' ? concGradeLabel(v, si) : steelGradeLabel(v, si))
    const distinct = [...new Set(members.map(valOf))].sort((a, b) => a - b)
    return distinct.map(v => ({
      key: String(v), label: labelOf(v),
      color: gradeColorMap.get(members.find(m => valOf(m) === v).id),
      count: members.filter(m => valOf(m) === v).length,
    }))
  }, [gradeColorMap, planColorMode, members, units])

  /** memberId → 'OK' | 'NG' from the last S-Concrete batch (see planProps). */
  const scoStatusById = useMemo(() => {
    const out = {}
    for (const r of sco.results ?? []) {
      const util = Math.max(r.nmUtil ?? 0, r.vtUtil ?? 0)
      const s = ((r.status != null && r.status !== 'OK') || util > 1) ? 'NG' : 'OK'
      for (const mid of r.memberIds ?? []) if (out[mid] !== 'NG') out[mid] = s
    }
    return out
  }, [sco.results])

  /** memberId → S-Concrete's worst utilisation, max(N-M, V&T).
   *
   *  A batch can cover one member with several results — a ULS run and a crack run, or a
   *  group result plus a single — so the worst across them wins, the same rule the app's
   *  own chips use for load rows. Members with no result stay ABSENT rather than 0: the
   *  map draws a missing key as "not run", and a 0 would paint them green, which is the
   *  one thing an unrun beam must not look like. */
  const scoDcrById = useMemo(() => {
    const out = {}
    for (const r of sco.results ?? []) {
      const util = Math.max(r.nmUtil ?? 0, r.vtUtil ?? 0)
      if (!(util > 0)) continue          // a result that reported no utilisation says nothing
      for (const mid of r.memberIds ?? []) out[mid] = Math.max(out[mid] ?? 0, util)
    }
    return out
  }, [sco.results])

  /** Every combo ETABS gave us, for the overlay's picker. */
  const combos = useMemo(() => comboNames(members), [members])

  /**
   * What the histogram bins — the SAME quantity the map is coloured by.
   *
   * One series, chosen by `planColorMode`, already in display units with its label and
   * unit, because the component draws numbers and cannot format them. Returns null for
   * the categorical modes (group, group+tags, section, auto-group overlay, S-Concrete
   * pass/fail): they have no numeric axis, and the panel is then not rendered at all
   * rather than shown empty.
   *
   * This replaced a histogram with its own axis picker, deliberately built independent
   * of the colour mode. Independent meant the chart and the picture could be answering
   * two different questions at once, which is not a comparison — reading a DCR spread
   * beside a map coloured by group tells you nothing about either.
   */
  const histSeries = useMemo(() => {
    const beams = members.filter(m => m.memberType === 'beam' || !m.memberType)
    if (!beams.length) return null
    const si = units === 'si'
    const spec = {
      dcr:          { pick: m => dcrById[m.id],                       label: 'DCR', unit: '', decimals: 2 },
      sconcreteDcr: { pick: m => scoDcrById?.[m.id],                  label: 'S-Concrete DCR', unit: '', decimals: 2 },
      flexSteel:    { pick: m => flexSteelRatioPct(m, flexFace),
                      label: `Steel ρ${flexFace === 'bot' ? '⁺ (bottom)' : '⁻ (top)'}`, unit: '%', decimals: 2 },
      stirrups:     { pick: m => stirrupAvPerFt(m),                   label: 'Stirrups Av/s', unit: label('areaPerLength'), decimals: 2 },
      weight:       { pick: m => steelWeightPerFt(m).totalLbFt,       label: 'Steel weight', unit: label('steelWeightPerLength'), decimals: 1 },
      height:       { pick: m => toDisplay(m.section.h, 'length'),    label: 'Height', unit: label('length'), decimals: si ? 0 : 1 },
      width:        { pick: m => toDisplay(m.section.bw ?? m.section.b, 'length'), label: 'Width', unit: label('length'), decimals: si ? 0 : 1 },
      concGrade:    { pick: m => toDisplay(m.material.fc, 'stress'),  label: 'Concrete f′c', unit: label('stress'), decimals: 0 },
      steelGrade:   { pick: m => toDisplay(m.material.fy, 'stress'),  label: 'Steel f_y', unit: label('stress'), decimals: 0 },
    }[planColorMode]
    if (!spec) return null
    // {id, v} rather than a bare number, so a bar can point back at the beams inside it —
    // hovering one draws them heavy on the map, which is the only way to answer "where
    // are these?" for a bar holding nine beams out of a hundred and seventy.
    const items = beams
      .map(m => ({ id: m.id, v: spec.pick(m) }))
      .filter(it => typeof it.v === 'number' && Number.isFinite(it.v))
    if (!items.length) return null
    return { items, label: spec.label, unit: spec.unit, decimals: spec.decimals }
  }, [members, planColorMode, flexFace, dcrById, scoDcrById, label, toDisplay, units])

  const planProps = useMemo(() => {
    const infoById = {}, errorFrames = []
    for (const d of designs) {
      const id = d.member.id
      if (d.dcr > 1) errorFrames.push(id)
      const flex = d.checks.find(c => c.key === 'flex')
      const shear = d.checks.find(c => c.key === 'shear')
      infoById[id] = {
        dcr: d.dcr,
        dcrFlex: flex ? flex.dcr : 0,
        dcrShear: shear ? shear.dcr : 0,
        top: barText(d.member.rebar.topBars),
        bot: barText(d.member.rebar.botBars),
        stirrups: tieText(d.member.rebar),
        status: d.dcr > 1 ? 'NG' : d.warnings.length ? 'Warning' : 'OK',
        warnings: d.warnings.map(w => ({ code: w.code, message: w.message, severity: w.severity })),
      }
    }
    // The M / V overlay's data: per-beam station envelopes, straight off the SAME
    // stationForces the design ran on — so a fat polygon and a red frame are two
    // readings of one set of numbers, not a demand picture drawn beside a capacity
    // verdict that came from somewhere else. Skipped entirely when the overlay is off:
    // this is a pass over every combo at every station of every frame in the model,
    // and it is pure waste while nothing draws it.
    const diagramDataById = {}
    if (planDiagram !== 'off') {
      // A combo saved from a previous model may not exist in this one. Falling back to
      // the envelope beats drawing nothing: an empty overlay looks like a member with no
      // forces rather than like a stale selection.
      const combo = planCombo && combos.includes(planCombo) ? planCombo : ''
      for (const d of designs) {
        if (!d.member.stationForces) continue
        diagramDataById[d.member.id] =
          stationEnvelope(d.member.stationForces, planDiagram === 'moment' ? 'M' : 'V', combo)
      }
    }
    return {
      font, units,
      frames, grids: MODEL_MAP.grids, columns: MODEL_MAP.columns, walls: MODEL_MAP.walls,
      stories: MODEL_MAP.stories,
      hiddenStories, elements: planElements, colorMode: planColorMode, view3d,
      diagramMode: planDiagram, diagramDataById,
      combos, planCombo,
      dcrById, infoById, errorFrames,
      designGroups: groups,
      autoGroupOverlay: autoOverlay,
      metricById, metricRange, metricLabel, flexFace, elementStyles,
      histSeries,
      widthById, lineWeightScale,
      dcrThresholds, dcrColors,
      gradeColorMap, gradeLegend, markEndById,
      // S-Concrete pass/fail per member, from the last batch. Derived exactly as the app
      // derives it (ModelMapView): a result is NG if it carries a non-OK status OR either
      // utilisation is over 1, and the WORST verdict wins for a member that appears in
      // more than one file (EC2 writes a ULS and a crack file per group). Empty until a
      // batch has run, which is what keeps the colour mode hidden rather than offering a
      // scheme that paints the model one flat grey.
      scoStatusById, scoDcrById,
      focusFrames,
      selectedFrames,
    }
  }, [font, units, designs, frames, dcrById, hiddenStories, planElements, planColorMode, planDiagram, planCombo, combos, view3d, groups, autoOverlay,
    metricById, metricRange, metricLabel, flexFace, histSeries, elementStyles, widthById, lineWeightScale,
    dcrThresholds, dcrColors, gradeColorMap, gradeLegend, markEndById, scoStatusById, scoDcrById, focusFrames, selectedFrames])

  const groupsProps = useMemo(() => ({
    font, units, memberId,
    groups, frames, members, selectedFrames, activeGroupId,
    dcrById, resultById, tab: groupsTab,
  }), [font, units, memberId, groups, frames, members, selectedFrames, activeGroupId, dcrById, resultById, groupsTab])

  const elevationProps = useMemo(() => ({
    font, units, memberId, member,
    // The member's own group supplies any explicit per-region cages; without one the
    // fallback in regionsFor() still gives the honest ~continuous bottom cage.
    regions: regionsFor(design, dashPayload.groups.find(g => g.memberIds.includes(memberId))),
  }), [font, units, memberId, member, design, dashPayload])

  const editorProps = useMemo(() => ({ font, units, memberId, code, member }), [font, units, memberId, code, member])

  // The Group Dashboard payload, from the app's own builder. It wants the governing
  // result per member plus the worst-per-MODE DCRs — worst across ALL rows, not the
  // governing row's, or a chip reads green while a different row pushes that mode over.

  const dashboardProps = useMemo(
    () => ({
      font, units, selectedGroupId: groupId, payload: dashPayload,
      // The "confirm in the main window" prompt outranks the last outcome while a
      // dialog is actually open — it is the line that answers "did my click do
      // anything?", which is the question being asked at that moment.
      suggestNote: awayNote ?? suggestNote, suggestBusy,
      // The size-floor dialog's inputs. They travel as data because the dialog is raised
      // in the PANEL's window, which has its own UnitsProvider and no idea what the
      // project chose.
      code, barFamily,
      // The push button stays on the dashboard — it acts on the GROUPS shown there. The
      // version picker moved to the top bar beside the project settings, because which
      // model you are reading is workspace-wide context, not a dashboard setting.
      resizedCount: resizedRows.length, readOnly,
    }),
    [font, units, code, barFamily, groupId, dashPayload, awayNote, suggestNote, suggestBusy, resizedRows.length, readOnly],
  )

  /**
   * The S-Concrete panel's payload. `project` is SYNTHESISED: this workspace holds
   * members and groups, the app holds a Project, and the batch wants the latter — it
   * writes one .SCO per design group and needs the group's cage, its members and the
   * code that produced them. Only the fields the batch and its dashboard actually read
   * are built (grep `project.` in useSconcreteBatch and scoBatch: members, designGroups,
   * code, slsCombo, ignoreTorsion, sconcreteResults, sconcreteRanAt), so this cannot
   * drift into a half-copy of a Project that looks complete and is not.
   *
   * Groups carry their EDITED cage (`groupRebar`), the same one the dashboard and the
   * plan use — verifying the cage as imported while the screen shows the cage you just
   * applied would make the whole round trip meaningless.
   *
   * The same rule applies to the DESIGN PREFERENCES, which is why `ignoreTorsion` and
   * `slsCombo` are read off the real project here:
   *  • `ignoreTorsion` drives scoBatch's stripTorsion. Omitting it meant "Neglect
   *    torsion" zeroed Tu in the app's own DCRs but still wrote Tu into the .SCO, so
   *    S-Concrete checked a load case the app had deliberately dropped.
   *  • `slsCombo` seeds the EC2 crack-width file. Defaulting it to the panel's local
   *    null meant the combo picked in project settings never reached the batch and NO
   *    crack file was generated until the user re-picked it inside the panel.
   * A run-local override (set in the panel) still wins over the project value.
   */
  const scoProject = useMemo(() => ({
    name: 'S-Dash demo model',
    code,
    members,
    designGroups: groups.map(g => ({ ...g, rebar: groupRebar[g.id] || g.rebar })),
    slsCombo: sco.slsCombo ?? project.slsCombo ?? undefined,
    ignoreTorsion: project.ignoreTorsion,
    sconcreteResults: sco.results ?? undefined,
    sconcreteRanAt: sco.ranAt ?? undefined,
  }), [code, members, groups, groupRebar, sco, project.slsCombo, project.ignoreTorsion])

  const sconcreteProps = useMemo(
    // frameOf is a Map; the bus takes pairs. The panel rebuilds it.
    () => ({ font, units, project: scoProject, payload: dashPayload, frameOf: [...frameOf], selectedGroupId: groupId }),
    [font, units, scoProject, dashPayload, frameOf, groupId],
  )

  /** Results (and the EC2 SLS combo) coming back from a run — in either window. */
  const onProjectPatch = useCallback(patch => {
    setSco(cur => ({
      results: patch.sconcreteResults ?? null,
      ranAt: patch.sconcreteRanAt ?? null,
      slsCombo: patch.slsCombo ?? cur.slsCombo,
    }))
  }, [])

  // Dragging a panel by its header. The workspace publishes the hit test into this ref;
  // the controller reads it to decide what a release means.
  const resolverRef = useRef(null)
  const onDragResult = useCallback((kind, res) => {
    // Released over ANOTHER window — dock into it. This is the drop that makes several
    // detached windows a workspace rather than a set of islands.
    if (res.type === 'window') { movePanel(kind, res.winId); return }
    if (res.type === 'tear') { movePanel(kind, 'new'); return }
    if (res.type === 'dock') {
      setMaximized(null)
      setHosts(h => (h[kind] === 'dock' ? h : { ...h, [kind]: 'dock' }))
      setWinOf(w => { if (!w[kind]) return w; const n = { ...w }; delete n[kind]; return n })
      setDock(cur => placePanel(cur || { cols: [] }, kind, res.target))
      return
    }
    // Floated where it was dropped. The offset puts the cursor on the header rather than
    // in the corner, so the panel appears under the hand that dragged it.
    setGeom(all => ({ ...all, [kind]: { ...(all[kind] || DEFAULT_GEOM(kind)), x: Math.max(0, res.x - 90), y: Math.max(0, res.y - 14) } }))
    setHost(kind, 'float')
  }, [setHost, movePanel])
  const dockDrag = useDockDrag({
    resolverRef,
    onResult: onDragResult,
    // The main window can answer "where is everyone" directly; a detached one has to ask
    // over the bus. Same hit test either way.
    getBounds: () => (hostRef.current ? hostRef.current.bounds() : Promise.resolve([])),
    selfWinId: DOCK,
  })

  const toggleMax = useCallback(kind => setMaximized(m => (m === kind ? null : kind)), [])

  // ── context menu ────────────────────────────────────────────────────────────
  // Items are built HERE, with closures over this window's state. Detached, only the
  // labels travel and the chosen index comes back — so a menu item does the same thing
  // wherever it was clicked, because it IS the same item.
  const menuItemsFor = useCallback(kind => ([
    // Always available, including from inside a detached window — that is how a panel is
    // split back OUT of a window holding several, which is the reverse of the drag that
    // put it there and the only route when the two windows overlap on one screen.
    {
      label: hosts[kind] === 'window' ? 'Move to a new window' : `Detach ${PANELS[kind].title}`,
      disabled: !canDetach(),
      on: () => movePanel(kind, 'new'),
    },
    { label: hosts[kind] === 'float' ? 'Dock in workspace' : 'Float over workspace', disabled: hosts[kind] === 'window', on: () => setHost(kind, hosts[kind] === 'float' ? 'dock' : 'float') },
    { label: maximized === kind ? 'Restore' : 'Maximise', disabled: hosts[kind] !== 'dock', on: () => toggleMax(kind) },
    // Every OTHER open window, so a panel can be sent to one without dragging across
    // the desktop. The drag is the quick route; this is the one that always works —
    // including on a single screen where the target window is behind this one.
    ...windowIds(hosts, winOf)
      .filter(id => id !== winOf[kind])
      .map(id => ({
        label: `Move to ${windowLabel(id)} (${panelsInWindow(hosts, winOf, id).map(k => PANELS[k].title).join(', ')})`,
        on: () => movePanel(kind, id),
      })),
    ...(hosts[kind] === 'window'
      ? [{ label: 'Move to workspace', on: () => movePanel(kind, DOCK) }]
      : []),
    { sep: true },
    { label: 'Jump to governing row', on: () => selectRow(design.governing.row.load.id) },
    // Every open panel into ONE window, not one window each. A window per panel was what
    // this did when a window could only hold one, and on a 10-panel model it carpeted the
    // desktop; the point of the second screen is a second workspace, not ten windows.
    {
      label: 'Detach every panel to one window',
      disabled: !canDetach(),
      on: () => {
        const cur = dockStateRef.current
        const id = newWinId(cur.hosts, cur.winOf)
        let next = cur
        for (const k of PANEL_ORDER) if (cur.hosts[k]) next = movePanelToWindow(next, k, id)
        setHosts(next.hosts); setWinOf(next.winOf); setWinDock(next.winDock); setDock(next.dock)
        setMaximized(null)
      },
    },
    { sep: true },
    // Reset's home now that it has no toolbar chip. Deliberately NOT in the dep array:
    // resetAll is declared further down, so naming it there would be read at render time
    // and throw on the temporal dead zone. The body is only read when a menu item is
    // clicked, by which point the binding exists — and resetAll is useCallback([]), so
    // its identity never changes and there is no stale closure to worry about.
    { label: 'Reset workspace and edits', on: () => resetAll() },
    { label: `Close ${PANELS[kind].title}`, on: () => closePanel(kind) },
  ]), [hosts, winOf, design, setHost, movePanel, closePanel, selectRow, maximized, toggleMax])

  /**
   * Apply what the settings dialog hands back — the app's own handleSettingsSave
   * (src/App.tsx:217) minus the parts the demo has no object for: there is no Project to
   * persist and no saveStandards, because the demo's model is data.js and must read the
   * same on every reload.
   *
   * Code and units both land, and both matter: the code re-runs every design through the
   * other engine, and units re-render every panel through the app's UnitsContext (via
   * UnitsSync). Materials/cover DO change the design, so they are applied to the members
   * the same way an Editor edit is — through memberEdits, so one override shape still
   * covers every writer.
   */
  const handleSettingsSave = useCallback(payload => {
    // App applies it through applyProjectSettings, which is also what honours
    // overrideImportedMaterials against project.modelMap. Doing it here as well would
    // apply the rule twice, from two different snapshots of the same project.
    onSettingsSave?.(payload)
    setSettingsOpen(false)
    // Materials are NOT pushed into memberEdits here. They are derived in the `members`
    // memo from `settings.overrideImportedMaterials`, so the dialog's f'c / fy / fyt rows
    // reach every beam the moment the box is ticked and stop reaching them the moment it
    // is unticked — see the note there. Writing them down here instead would make the
    // tick a one-way door: untick would leave the flattened grades behind, because
    // nothing would remember what each member's ETABS section had said.
  }, [])

  /**
   * The model as it is ON SCREEN, for the exports.
   *
   * Not `project`. Two things differ, and both would make a report describe something
   * the user is not looking at:
   *
   *  · `members` / `groups` follow the MODEL VERSION picker — point the workspace at a
   *    pushed snapshot and the export has to be of that snapshot.
   *  · groups carry their EDITED cage (`groupRebar`), which `project.designGroups` can
   *    lag behind; a schedule of the cage as imported, printed from a screen showing the
   *    cage you just applied, is the same class of mistake the S-Concrete batch had.
   *
   * Everything else is spread from the real project, so title-block fields, settings,
   * the model map and the design preferences stay whatever they actually are — rather
   * than a hand-built object that quietly omits one.
   */
  const exportProject = useMemo(() => ({
    ...project,
    code,
    members,
    designGroups: groups.map(g => ({ ...g, rebar: groupRebar[g.id] || g.rebar })),
  }), [project, code, members, groups, groupRebar])

  const openMenu = useCallback((x, y, items) => setMenu({ x, y, items }), [])
  const menuOn = kind => e => { e.preventDefault(); openMenu(e.clientX, e.clientY, menuItemsFor(kind)) }

  /**
   * The BEAM context menu — right-click a line on the plan.
   *
   * Built here, in the main window, exactly like the panel-header menu, and for the same
   * reason: every item closes over this window's state. Detached, only the labels travel
   * and the chosen index comes back, so the item does the same thing wherever it was
   * clicked because it IS the same item.
   *
   * Flat, not a submenu. The app's BeamContextMenu nests "Move to group ▸", but this
   * demo's Menu is one list by design — that is what lets a menu survive the bus as an
   * array of labels — and the group list is the whole point of this menu rather than one
   * entry on it, so flattening costs nothing and spares a hover-to-open interaction that
   * is genuinely awkward in a detached window.
   */
  const beamMenuItems = useCallback((memberId, frameName) => {
    const current = groups.find(g => g.memberIds.includes(memberId))
    const groupItems = groups.map(g => {
      const isCurrent = g.id === current?.id
      const t = groupTemplate(g.id)
      return {
        // The donor is named in the label because this is a destructive edit and the
        // beam it copies from is the one fact that decides what you get.
        label: `${isCurrent ? '✓ ' : '→ '}${g.label}${t && !isCurrent ? `  (as ${t.donorId})` : ''}`,
        disabled: isCurrent || !t,
        on: () => moveMemberToGroup(memberId, g.id),
      }
    })
    return [
      { label: frameName || memberId, disabled: true },
      { label: 'Open in the workspace', on: () => pickMember(memberId) },
      {
        // A SUBMENU, not an inline list: the group count is unbounded, and inlining it
        // turned a short menu into a wall on any real model. The nested list scrolls.
        label: 'Change group',
        title: 'Adopts the target group’s section, material and cage',
        children: groupItems.length
          ? groupItems
          : [{ label: 'No groups yet — make one in the Groups panel', disabled: true }],
      },
      { sep: true },
      {
        label: 'Delete beam',
        title: readOnly
          ? 'This is a frozen version — it cannot be edited'
          : 'Removes it from the model and from its group. Ctrl+Z undoes it.',
        danger: true,
        disabled: readOnly,
        on: () => deleteMember(memberId),
      },
    ]
  }, [groups, groupTemplate, moveMemberToGroup, pickMember, deleteMember, readOnly])

  /** Docked / floating: the menu opens in this window, from these very items. */
  const onBeamMenu = useCallback(
    (memberId, frameName, x, y) => openMenu(x, y, beamMenuItems(memberId, frameName)),
    [openMenu, beamMenuItems],
  )

  // ── where each panel mounts ─────────────────────────────────────────────────
  //
  // The host is told about WINDOWS (open these, close those, here is what each holds)
  // and about PANELS (here are this one's props). Everything a detached window asks of
  // the model — move a panel, persist a rearranged layout, report that the OS closed it
  // — comes back through these three callbacks and is applied here, because this window
  // owns the model.
  const host = usePopoutHost({
    onMove: movePanel,
    /**
     * Fold one whole window into another — three windows become two.
     *
     * A window-level verb, not a loop of panel moves at the call site: doing it in one
     * transition means the emptied window is closed once, and a four-panel window is one
     * action rather than four trips through a menu with a half-emptied window in between.
     */
    onMerge: (from, to) => {
      const cur = dockStateRef.current
      const next = mergeWindows(cur, from, to)
      if (next === cur) return
      setHosts(next.hosts); setWinOf(next.winOf); setWinDock(next.winDock); setDock(next.dock)
      setMaximized(null)
      if (to !== DOCK && hostRef.current) hostRef.current.focusWindow(to)
    },
    onWinDock: (winId, next) => setWinDock(w => ({ ...w, [winId]: next })),
    /**
     * A closed window takes its panels with it — CLOSED, not sent home.
     *
     * Closing a window is how you get rid of a view, so the panels in it end up closed
     * (`hosts[kind] = null`) exactly as if each had been dismissed with its own ✕.
     * Re-docking them into the main workspace instead would mean the ✕ on a second
     * monitor silently rearranged the first one — you shut a window and the panels you
     * were trying to be rid of reappear behind it.
     *
     * Getting a panel back is one click on its toolbar chip, and the deliberate route
     * home is still there: the ⇤ button on each panel inside a detached window, or
     * "Move to workspace" in its menu. Those SAY they move the panel; the window's ✕
     * says close.
     */
    onWindowClosed: winId => {
      const cur = dockStateRef.current
      const next = closeWindowPanels(cur, winId)
      if (next === cur) return           // already emptied by a move — nothing to close
      setHosts(next.hosts); setWinOf(next.winOf); setWinDock(next.winDock)
    },
  })
  hostRef.current = host

  // What each detached window is holding, DERIVED rather than stored — so a window's
  // layout can never claim a panel that has moved on, and reconciling here means the
  // stored layout is only ever a hint about arrangement, never the source of truth about
  // membership.
  const windows = useMemo(() => windowIds(hosts, winOf).map(id => {
    const kinds = panelsInWindow(hosts, winOf, id)
    return { id, kinds, dock: reconcile(winDock[id] || { cols: [] }, kinds) }
  }), [hosts, winOf, winDock])

  // Opening and closing OS windows is a side effect, so it happens after the render that
  // decided there should be one — never during it.
  useEffect(() => { host.syncWindows(windows) }, [windows])   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A panel button that opens a MODAL over here, pressed from a detached window.
   *
   * The dialog stays in this window — it is app state, and the rule this whole bus is
   * built on is that the main window owns the state. But from the second monitor, "press
   * the button, a dialog appears on the OTHER screen, possibly behind something" is
   * indistinguishable from a button that does nothing. That is the Group Dashboard's
   * ✨ Suggest, and it is why this exists.
   *
   * Two things, because neither is sufficient alone. RAISE this window, which is the
   * real fix and works properly on the desktop host (`popout:focus` with the dock id).
   * And leave a line in the panel that asked — the only feedback that lands on the
   * screen the user is actually looking at, and the whole of it in a browser, where a
   * window cannot reliably focus itself without a gesture of its own.
   *
   * A no-op for a docked panel: the dialog is already in front of you.
   */
  const revealHere = (kind, note) => {
    if (hosts[kind] !== 'window') return
    if (hostRef.current) hostRef.current.focusWindow(DOCK)
    setAwayNote(note)
  }

  const fns = kind => ({
    onClose: () => closePanel(kind),
    onSelectRow: selectRow,
    onRebarChange,
    onSectionChange,
    onUpdate: onMemberChange,
    onSelectGroup: pickGroup,
    onHiddenStories: setHiddenStories,
    onElements: setPlanElements,
    onColorMode: setPlanColorMode,
    onDiagramMode: setPlanDiagram,
    onPlanCombo: setPlanCombo,
    onDcrThresholds: setDcrThresholds,
    onDcrColors: setDcrColors,
    onFlexFace: setFlexFace,
    onLineWeight: setLineWeightScale,
    onView3d,
    // A req, not a fn: the caller needs the items back. Detached, only their labels
    // travel and the chosen index returns, so the closure runs here either way.
    beamMenuFor: (memberId, frameName) => beamMenuItems(memberId, frameName),
    onSelectFrames,
    onApplyRebar: applyGroupRebar,
    onApplySection: applyGroupSection,
    onOpenMember: pickMember,
    onGroupsChange,
    onActiveGroupChange: pickActiveGroup,
    onDeleteGroupWithMembers,
    onApplySuggestion,
    onOverlayChange,
    onHighlightFrames,
    onTab: setGroupsTab,
    // Suggest arrives with its floors already chosen — the dialog ran in the panel's own
    // window. Push still opens a dialog HERE: it drives a live ETABS connection and
    // narrates its progress, neither of which a detached document can hold, so that one
    // gets `revealHere` instead.
    onSuggestAll: runSuggestAll,
    onPushToEtabs: () => { revealHere(kind, '⇪ Push — confirm in the main window'); setPushOpen(true) },
    onToggleCurtailmentNote: setCurtailmentNote,
    onSetOppositeTop: setOppositeTop,
    onSetMidThirdTop: setMidThirdTop,
    onSetEndThirdBot: setEndThirdBot,
    onSetReviewed: setGroupReviewed,
    onProjectPatch,
    menuItemsFor: () => menuItemsFor(kind),
  })
  const payload = {
    plan: planProps, groups: groupsProps,
    section: sectionProps, calc: calcProps, loads: loadsProps, force: forceProps,
    elevation: elevationProps, editor: editorProps, dashboard: dashboardProps,
    sconcrete: sconcreteProps,
  }
  const here = {}
  for (const kind of PANEL_ORDER) {
    // The second argument is WHICH WINDOW holds it — null meaning this one. A panel that
    // is docked, floating or closed renders here; a detached one is published to its
    // window instead and `publish` returns false so it is not also rendered in-page.
    here[kind] = hosts[kind]
      ? host.publish(kind, hosts[kind] === 'window' ? winOf[kind] : null, payload[kind], fns(kind))
      : false
  }

  const panelNode = kind => {
    const common = {
      host: hosts[kind], onHost: h => setHost(kind, h), onClose: () => closePanel(kind),
      onMenu: menuOn(kind),
      geom: geom[kind] || DEFAULT_GEOM(kind), onGeom: g => setGeomFor(kind, g),
      maximized: maximized === kind,
      onMaximize: () => toggleMax(kind),
      onDrag: {
        begin: (x, y) => dockDrag.begin(kind, x, y),
        move: dockDrag.move,
        end: dockDrag.end,
      },
    }
    if (kind === 'plan') {
      return (
        <PlanPanel key="plan" {...planProps} {...common}
          onHiddenStories={setHiddenStories} onElements={setPlanElements}
          onColorMode={setPlanColorMode} onView3d={onView3d}
          onDiagramMode={setPlanDiagram}
          onPlanCombo={setPlanCombo}
          onDcrThresholds={setDcrThresholds} onDcrColors={setDcrColors} onFlexFace={setFlexFace}
          onLineWeight={setLineWeightScale}
          onSelectFrames={onSelectFrames} onOpenMember={pickMember}
          onBeamMenu={onBeamMenu} />
      )
    }
    if (kind === 'groups') {
      return (
        <GroupsPanel key="groups" {...groupsProps} {...common}
          onGroupsChange={onGroupsChange}
          onActiveGroupChange={pickActiveGroup}
          onSelectFrames={onSelectFrames}
          onDeleteGroupWithMembers={onDeleteGroupWithMembers}
          onApplySuggestion={onApplySuggestion}
          onOverlayChange={onOverlayChange}
          onHighlightFrames={onHighlightFrames}
          onTab={setGroupsTab} />
      )
    }
    if (kind === 'sconcrete') {
      return (
        <SconcretePanel key="sconcrete" {...sconcreteProps} {...common}
          onSelectGroup={pickGroup}
          onOpenMember={pickMember}
          onProjectPatch={onProjectPatch} />
      )
    }
    if (kind === 'section') {
      return (
        <SectionPanel key="section" {...sectionProps} {...common}
          onRebarChange={onRebarChange} onSectionChange={onSectionChange}
          onApplyRebar={applyGroupRebar} onApplySection={applyGroupSection}
          onToggleCurtailmentNote={setCurtailmentNote}
          onSetOppositeTop={setOppositeTop}
          onSetMidThirdTop={setMidThirdTop}
          onSetEndThirdBot={setEndThirdBot}
          onSetReviewed={setGroupReviewed} />
      )
    }
    if (kind === 'calc') return <CalcPanel key="calc" {...calcProps} onSelectRow={selectRow} {...common} />
    if (kind === 'loads') return <LoadsPanel key="loads" {...loadsProps} onSelectRow={selectRow} {...common} />
    if (kind === 'force') return <ForcePanel key="force" {...forceProps} {...common} />
    if (kind === 'elevation') return <ElevationPanel key="elevation" {...elevationProps} {...common} />
    if (kind === 'editor') return <EditorPanel key="editor" {...editorProps} onUpdate={onMemberChange} {...common} />
    return (
      <DashboardPanel key="dashboard" {...dashboardProps} {...common}
        onSelectGroup={pickGroup} onApplyRebar={applyGroupRebar} onOpenMember={pickMember}
        onSetReviewed={setGroupReviewed}
        onSuggestAll={runSuggestAll}
        onPushToEtabs={() => setPushOpen(true)} />
    )
  }

  // Desktop = the native menu bar exists, so the in-page one stands down. Read once at
  // module scope of this render rather than per-click: `window.electronAPI` is injected
  // by the preload before any React runs, so it cannot appear later.
  const isDesktopBuild = typeof window !== 'undefined' && !!window.electronAPI

  const docked = PANEL_ORDER.filter(k => here[k] && hosts[k] === 'dock')   // for the toolbar count
  const floating = PANEL_ORDER.filter(k => here[k] && hosts[k] === 'float')
  const detached = PANEL_ORDER.filter(k => hosts[k] === 'window')

  // Reset puts BOTH back: the layout, and the model you have been editing. The grouping
  // belongs in the second half — a demo whose Reset left yesterday's groups behind would
  // make it impossible to tell what data.js ships from what you did to it.
  //
  // It lost its toolbar chip (the app has no Reset chip, so neither does this) but NOT
  // its reachability: it is on every panel's right-click menu. Deleting the only route
  // back to a clean workspace would mean a mis-dragged layout could only be undone by
  // clearing localStorage by hand.
  const resetAll = useCallback(() => {
    clearLayout()
    setHosts({ ...DEFAULT_LAYOUT.hosts })
    setGeom({}); setGroupRebar({}); setRowSel({}); setQuery(''); setFailsOnly(false)
    setDock(null); setMaximized(null); setRailOpen(false); setRailPinned(false); setRailW(258)
    setActiveGroupId(null)
    setAutoOverlay([]); setHighlightFrames([]); setGroupsTab(DEFAULT_LAYOUT.groupsTab)
    setSelectedFrames([])
    setView3d(false); setStoryBefore3d(null)
    setHiddenStories(DEFAULT_LAYOUT.hiddenStories); setPlanElements(DEFAULT_LAYOUT.planElements)
    setPlanColorMode(DEFAULT_LAYOUT.planColorMode)
    setPlanDiagram(DEFAULT_LAYOUT.planDiagram); setPlanCombo(''); setFlexFace(DEFAULT_LAYOUT.flexFace)
    setLineWeightScale(DEFAULT_LAYOUT.lineWeightScale)
    // Pushed model versions go with the rest of the model. A "new project" that kept
    // three revisions of a frame it no longer has would be describing nothing.
    // The versions live in the project now, so a new project drops them with everything
    // else — nothing to clear here beyond the selection.
    setModelVersion('live'); setPushOpen(false); setSuggestNote(null)
    setDcrThresholds(DEFAULT_LAYOUT.dcrThresholds); setDcrColors(DEFAULT_LAYOUT.dcrColors)
  }, [])

  // File → Reset the workspace, from the NATIVE menu. It is wired here rather than in
  // App because resetAll is this component's state, all of it — hoisting a dozen
  // setters just to let the parent relay one menu click would be the wrong trade.
  // Optional-chained: a renderer running against an older preload simply has no
  // listener rather than throwing on load.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.onResetWorkspace) return
    api.onResetWorkspace(resetAll)
    return () => api.offResetWorkspace?.()
  }, [resetAll])

  // View -> Performance meter, from the native menu. See utils/perfProbe.ts: the meter
  // is off by default and costs nothing until it is asked for.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.onTogglePerf) return
    api.onTogglePerf(togglePerf)
    return () => api.offTogglePerf?.()
  }, [])

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="sdash-root demo-shell" onMouseDown={() => setMenu(null)}>
      {/* Pushes `units` into the app's real UnitsContext, which is what SectionView and
          every formatter read. Rendered, not called, because it owns an effect. */}
      <UnitsSync units={units} />
      {/* The report dialog lives HERE rather than in App because it needs the model as
          displayed — the same `exportProject` every other entry in the menu uses. */}
      {reportOpen && <ReportModal project={exportProject} onClose={() => setReportOpen(false)} />}
      {prefsOpen && (
        <Portal>
          <PreferencesDialog
            styles={elementStyles}
            onChange={setElementStyles}
            onClose={() => setPrefsOpen(false)}
          />
        </Portal>
      )}
      {settingsOpen && (
        <ProjectSettingsDialog
          mode="settings"
          projectName="S-Dash beam demo"
          code={code}
          settings={{ ...settings, units }}
          // This model IS an import: every member carries an `etabs` link (frame name,
          // storey, I/J nodes, section name) and its own grade off that section — the
          // girders are 5 ksi, the fillers 4. `imported` is what puts the "Override the
          // imported material properties" checkbox on the Materials section and locks the
          // f'c / fy / fyt rows behind it, which is exactly the behaviour a mixed-grade
          // frame needs: the project value must not silently flatten it.
          imported
          onCancel={() => setSettingsOpen(false)}
          onSave={handleSettingsSave}
        />
      )}
      <div className="sdash-topbar">
        <div className="sdash-topbar-side">
          <span className="demo-brandwrap">
            <span className="sdash-brand">S-DASH</span>
            <span className="sdash-pill">BEAM</span>
          </span>
          {/* The application menu, in the page — BROWSER ONLY. The desktop build has the
              real one at the OS level (electron/main.cjs), and two identical menu bars
              stacked one above the other is worse than either alone: it doubles the
              places to look and halves the confidence that they agree. Served over
              http:// there is no native menu to defer to, so this renders instead —
              same labels, same order, same accelerators.

              Everything this offers is on the native menu too, Import from ETABS and
              Reset the workspace included, so the desktop app loses no command by
              hiding it. */}
          {!isDesktopBuild && (
            <MenuBar
              onNewProject={onNewProject}
              onOpenProject={onOpenProject}
              onSaveProject={onSaveProject}
              onSaveProjectAs={onSaveProjectAs}
              onImportEtabs={onImportEtabs}
              onReset={resetAll}
              onPreferences={() => setPrefsOpen(true)}
              onTogglePerf={togglePerf}
              onOpenHelp={tab => setHelpTarget(tab)}
            />
          )}
        </div>

        {/* Panel toggles. A pill group, as the Template does its tool clusters. */}
        <div className="sdash-pillgroup">
          {PANEL_ORDER.map(kind => {
            const Icon = PANEL_ICON[kind]
            return (
              <button key={kind}
                      className={'sdash-toolbtn' + (hosts[kind] ? ' on' : '')}
                      title={`${PANELS[kind].title}${hosts[kind] === 'window' ? ' (detached)' : ''}`}
                      onClick={() => togglePanel(kind)}
                      onContextMenu={menuOn(kind)}>
                <Icon size={16} />
                {hosts[kind] === 'window' ? <span className="demo-detached-dot" /> : null}
              </button>
            )
          })}
        </div>

        <div className="sdash-topbar-side sdash-topbar-right">
          <span className="demo-tb-note">
            {detached.length ? <><b>{detached.length}</b> detached</> : null}
          </span>
          {/* Which MODEL the workspace is reading. Beside the project settings because
              that is what it is — context for everything to its left, not a setting of
              any one panel. Appears only once a push has produced a second model: a
              picker with one entry is a label pretending to be a control.

              A frozen version is read-only, and says so rather than letting an edit
              silently fork it. */}
          {/* Always shown once anything has been pushed. It used to appear only at two
              entries, which meant the FIRST push produced a history the engineer could
              not see — the one moment they most want to know it was kept. */}
          {versionOptions.length > 1 && (
            <>
              <select
                className="demo-modelsel"
                value={modelVersion}
                onChange={e => setModelVersion(e.target.value)}
                title={`Which model the workspace is reading. ${versions.length} saved `
                  + `design${versions.length === 1 ? '' : 's'} in this project — switching shows that `
                  + `model's groups and their DCRs.`}
              >
                {versionOptions.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
              {readOnly && (
                <span className="demo-rolock" title="A pushed model is a snapshot — switch back to the working model to edit">
                  read-only
                </span>
              )}
            </>
          )}
          {/* No design-code chip here. The code is set in Project settings and nowhere
              else, so a disabled select in the top bar was a dead control: a second
              place to look for a setting that lives behind the gear, and one you could
              not actually set. The panels that depend on the code still name it — the
              Editor's CodeBadge and the Calc sheet's clause references. */}
          {/* Export — the app's output formats, beside the gear because both are
              project-wide actions rather than anything to do with the selected member.
              It opens the shell's OWN menu (portalled, dismiss-on-outside-click) rather
              than an absolutely-positioned div: App.tsx wraps the workspace in a zoom
              transform, which makes it the containing block for fixed descendants, and a
              hand-rolled popover lands in the wrong place at non-100% Display Scale. */}
          {exportNote && (
            <span className="demo-tb-note" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={exportNote}>{exportNote}</span>
          )}
          <button
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect()
              openMenu(r.left, r.bottom + 6, exportMenuItems(exportProject, {
                onOpenReport: () => setReportOpen(true),
                onNote: setExportNote,
              }))
            }}
            style={{ ...hdrBtn, padding: '5px 8px' }}
            title="Export — PDF report, schedules and spreadsheets"
          >
            <Icon name="export" title="Export" />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            style={{ ...hdrBtn, padding: '5px 8px', background: settingsOpen ? ACCENT.softBg : 'white', color: settingsOpen ? ACCENT.primary : INK.base }}
            title="Project settings — code, units, materials, cover, moduli, display scale"
          >
            <Icon name="settings" title="Project settings" />
          </button>
        </div>
      </div>

      <div className="demo-body">
        <RailDock
          open={railOpen} pinned={railPinned} width={railW} fails={totals.fails}
          onOpen={() => setRailOpen(true)}
          onClose={() => setRailOpen(false)}
          onWidth={setRailW}
          onTogglePin={() => setRailPinned(v => {
            // Unpinning leaves it open as an overlay rather than snapping shut, so the
            // click that unpinned it does not also hide what you were reading.
            if (v) setRailOpen(true)
            return !v
          })}
        >
          <GroupRail
            groups={groups} designById={designById} totals={totals}
            memberId={memberId} groupId={groupId} onPick={pickMember}
            selectionKind={selectionKind} onPickGroup={pickGroup}
            openGroups={openGroups} onToggleGroup={id => setOpenGroups(o => ({ ...o, [id]: !o[id] }))}
            query={query} onQuery={setQuery}
            failsOnly={failsOnly} onFailsOnly={setFailsOnly}
          />
        </RailDock>

        {/* No header strip. It described whatever was selected — the member's section,
            span and materials with its check chips, or the selected group's ρ and worst
            DCRs — and every one of those numbers is already on screen in a panel that
            owns it: the rail carries the DCR rollup, the Section panel the geometry and
            materials, the Group Dashboard the group's envelope. A row that only restates
            its neighbours is the first thing that should give up its height, and here it
            was ~40px of every window at every size. */}
        <div className="demo-main">
          <Workspace
            layout={dock || { cols: [] }}
            onLayout={setDock}
            renderPanel={panelNode}
            drag={dockDrag.drag}
            resolverRef={resolverRef}
            maximized={maximized && hosts[maximized] === 'dock' ? maximized : null}
            empty={(
              <div className="demo-empty">
                <b>{detached.length ? 'Every panel is in its own window.' : 'Nothing docked.'}</b>
                <span>{detached.length
                  ? 'Close one of those windows and it comes back here.'
                  : 'Open a panel from the toolbar, or drag a floating one back in.'}</span>
              </div>
            )}
          />
          {/* The status strip that used to sit here is gone, and the workspace has its
              height. Nothing was lost that is not still said closer to where it matters:
              the DCR bands are in the plan's own legend, the counts are in the rail's
              footer, and which row a panel is showing is in that panel's subtitle. */}
        </div>
      </div>

      {/* Floating panels are portalled to <body> so no transformed or layered ancestor
          can bury them — the real app's zoom wrapper is exactly such an ancestor. */}
      {floating.map(kind => <Portal key={kind}>{panelNode(kind)}</Portal>)}

      {/* The ghost follows the cursor and says what releasing will do. Portalled, because
          during a tear-off drag the pointer is outside the app entirely. */}
      {dockDrag.drag && (
        <Portal>
          <div className={'demo-dragghost' + (dockDrag.drag.tear ? ' tear' : '')}
               style={{ left: dockDrag.drag.x, top: dockDrag.drag.y }}>
            {PANELS[dockDrag.drag.kind].title}
            <em>{dockDrag.drag.tear ? 'release to detach' : dockDrag.drag.target ? 'release to dock' : 'release to float'}</em>
          </div>
        </Portal>
      )}

      {/* The app's own size-floor dialog — "use this bar size or larger" — asked before
          Suggest runs, so the sweep is not a black box. Portalled for the same reason
          every other popup here is. */}
      {pushOpen && (
        <PushToEtabsDialog
          rows={resizedRows}
          modelName={defaultModelName(MODEL_MAP.modelName, versions.length + 1)}
          live={canPushLive}
          busy={pushBusy}
          combos={combos}
          onCancel={() => {
            // Drop the held connection too — a dialog closed half way through a stepped
            // push must not leave one attached for the next one to inherit.
            pushConnRef.current = null; pushOutRef.current = null
            setPushBusy(null); setPushOpen(false)
          }}
          onPush={onPush}
          onPushStep={onPushStep}
          onPushDone={onPushDone}
        />
      )}

      {/* Help — the app's own HelpView, in a modal. The product gives it a tab; a
          workspace of panels has no tab strip to give it, and Help is something you open,
          read and close rather than a place you work. 'about' is the app's native dialog,
          which a web page cannot have, so it gets its own small panel. */}
      {helpTarget && (
        <Portal>
          <div className="demo-modal-back" onMouseDown={() => setHelpTarget(null)}>
            <div className="demo-modal demo-help" onMouseDown={e => e.stopPropagation()}>
              <div className="demo-modal-head">
                <span className="demo-modal-title">
                  {helpTarget === 'about' ? 'About S-Dashboard' : 'Help'}
                </span>
                <span style={{ flex: 1 }} />
                <button className="demo-winbtn x" onClick={() => setHelpTarget(null)} title="Close">✕</button>
              </div>
              <div className="demo-modal-body">
                {helpTarget === 'about' ? (
                  <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                    <b>S-Dashboard</b> — beam demo
                    <div style={{ marginTop: 8 }}>
                      ETABS → design → group dashboard → S-Concrete verification, for
                      reinforced-concrete frames.
                    </div>
                    <div style={{ marginTop: 8, color: '#64748b' }}>
                      This workspace runs the app&rsquo;s own engine and its own components over
                      the project's {baseMembers.length} designed member(s).
                    </div>
                  </div>
                ) : (
                  <HelpView target={helpView} />
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}

      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}

      {/* The last line of the shell. Outside .demo-body so it spans the full width
          under BOTH the rail and the workspace, and so the panels keep their own
          height rather than each carrying a slice of it. */}
      <StatusBar />
    </div>
  )
}

// Short cage text for the plan's hover card — the app's FrameInfo wants strings, not
// bar groups, so the formatting belongs here and not in the panel.
function barText(groups) {
  return (groups || []).map(g => `${g.numBars}-#${Math.abs(g.barSize)}`).join(' + ') || '—'
}
function tieText(rebar) {
  const t = rebar.ties
  if (!t) return '—'
  return rebar.tieZones
    ? `#${Math.abs(t.barSize)} @ ${rebar.tieZones.map(z => z.spacing).join('/')}"`
    : `#${Math.abs(t.barSize)} @ ${t.spacing}"`
}
