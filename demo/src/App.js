import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GROUPS, MEMBERS, MODEL_MAP } from './data.js'
import { breakdownFor, chartsFor, designMemberAllRows, forceSeries, regionsFor, stationEnvelope, suggestAllGroups, summaryMaps } from './design.js'
import { PANEL_ORDER, PANELS, canDetach } from './popoutBus.js'
import { loadLayout, saveLayout, clearLayout, DEFAULT_LAYOUT } from './layout.js'
import usePopoutHost from './usePopoutHost.js'
import Portal from './Portal.js'
import Workspace from './Workspace.js'
import useDockDrag from './useDockDrag.js'
import { defaultLayout, placePanel, reconcile } from './dockLayout.js'
// The app's own header chips, not lookalikes. `hdrBtn` below is the app's chip style
// (src/App.tsx:32) and Icon is the app's icon set, so a chip here is the same object
// the product ships — same 12px/600 label, same 1px #d1d5db border, same
// ACCENT.softBg/ACCENT.primary "on" convention.
import { Icon } from '../../src/components/common/Icon.tsx'
import ProjectSettingsDialog from '../../src/components/Settings/ProjectSettingsDialog.tsx'
import { defaultSettings } from '../../src/utils/projectSettings.ts'
import { ACCENT, BORDER, INK } from '../../src/theme.ts'
import Menu from './Menu.js'
import GroupRail from './GroupRail.js'
import RailDock from './RailDock.js'
import UnitsSync from './UnitsBridge.js'
import { useFmt } from './format.js'
import SectionPanel from './panels/SectionPanel.js'
import SconcretePanel from './panels/SconcretePanel.js'
import CalcPanel from './panels/CalcPanel.js'
import LoadsPanel from './panels/LoadsPanel.js'
import ForcePanel from './panels/ForcePanel.js'
import ElevationPanel from './panels/ElevationPanel.js'
import EditorPanel from './panels/EditorPanel.js'
import DashboardPanel from './panels/DashboardPanel.js'
import PlanPanel from './panels/PlanPanel.js'
import GroupsPanel from './panels/GroupsPanel.js'
import { buildDashboardPayload } from '../../src/utils/dashboardPayload.ts'
import HelpView from '../../src/components/Help/HelpView.tsx'
import MenuBar from './MenuBar.js'
import PushToEtabsDialog from './PushToEtabsDialog.js'
import { resizedGroups, defaultModelName } from './etabsPush.js'
import SuggestSizeDialog from '../../src/components/common/SuggestSizeDialog.tsx'
// The plan's colour schemes are the APP's, not a demo subset — same modes, same metrics,
// same palettes, computed by the same functions. A mode that looked right here and
// different in the app would be worse than not having it.
import { METRIC_MODES, concGradeLabel, steelGradeLabel } from '../../src/components/ModelMap/frameColor.ts'
import { flexSteelRatioPct, stirrupAvPerFt, steelWeightPerFt } from '../../src/utils/autoGroup.ts'
import { beamMarkEnd } from '../../src/utils/curtailment.ts'
import { CATEGORICAL } from '../../src/theme.ts'
import {
  IconCalc, IconDashboard, IconDiagram, IconEditor, IconElevation, IconGroups,
  IconPlan, IconSection, IconTable, IconVerify,
} from './icons.js'

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
export default function App() {
  const saved = useMemo(loadLayout, [])
  const [memberId, setMemberId] = useState(saved.memberId)
  const [groupId, setGroupId] = useState(saved.groupId)
  const [code, setCode] = useState(saved.code)
  // No longer switchable from the toolbar — the Inter/Segoe chip was a Template-era
  // control the app has no equivalent for. The state stays because every panel payload
  // carries it across the popout bus (a detached window inherits no <html> attribute).
  const [font] = useState(saved.font)
  const [units, setUnitsState] = useState(saved.units)
  const [hosts, setHosts] = useState(saved.hosts)
  const [geom, setGeom] = useState(saved.geom)
  const [openGroups, setOpenGroups] = useState(saved.openGroups)
  const [railOpen, setRailOpen] = useState(saved.railOpen)
  const [railPinned, setRailPinned] = useState(saved.railPinned)
  const [railW, setRailW] = useState(saved.railW)
  const [dock, setDock] = useState(saved.dock)          // null until first reconcile
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
  const [planDiagram, setPlanDiagram] = useState(saved.planDiagram)
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
  const [liveGroups, setGroups] = useState(GROUPS)
  const [activeGroupId, setActiveGroupId] = useState(null)
  const [groupsTab, setGroupsTab] = useState(saved.groupsTab)
  // The auto-group wizard's live proposal. It is a PREVIEW — it colours the plan and
  // nothing else — until Commit turns it into real groups through the same setter a
  // hand-made group goes through.
  const [autoOverlay, setAutoOverlay] = useState([])
  const [highlightFrames, setHighlightFrames] = useState([])
  // Members deleted with their group. Kept as a removal set rather than by editing
  // MEMBERS, so data.js stays the single description of the model and Reset is one
  // setter rather than a rebuild.
  const [removedIds, setRemovedIds] = useState(() => new Set())
  // What the last click selected. A GROUP and a MEMBER are different things to look at,
  // and the Section panel shows a different component for each — the group's template
  // cage with the set's envelope on it, or one beam's own dimensioned section.
  const [selectionKind, setSelectionKind] = useState(saved.selectionKind || 'member')
  const [memberEdits, setMemberEdits] = useState({})  // memberId -> Member (a whole one)
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
  const [settings, setSettings] = useState(() => ({ ...defaultSettings(saved.code), units: saved.units }))
  const [query, setQuery] = useState('')
  const [failsOnly, setFailsOnly] = useState(false)
  // ✨ Suggest: the size-floor dialog, and the one-line outcome it reports.
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestNote, setSuggestNote] = useState(null)
  // ── model versions ──────────────────────────────────────────────────────────
  // Each push freezes the working model under a name and keeps its designs, so the
  // dashboard can be pointed at "what the model said before I resized anything" and at
  // "what it says after", and the difference is the answer to the question that made
  // someone resize a group in the first place.
  //
  // Frozen deliberately: a version holds its OWN members and designs, not a recipe for
  // re-deriving them. A recipe would silently follow later edits and the comparison —
  // the entire point — would quietly stop being one.
  const [versions, setVersions] = useState([])
  const [modelVersion, setModelVersion] = useState('live')
  const [pushOpen, setPushOpen] = useState(false)
  // Which Help sub-tab the menu asked for; null = closed. 'about' is the app's native
  // dialog, which a web page has no equivalent of, so it gets a panel of its own.
  const [helpTarget, setHelpTarget] = useState(null)
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
    saveLayout({ memberId, groupId, code, font, units, hosts, geom, openGroups, hiddenStories, planElements, planColorMode, planDiagram, flexFace, dcrThresholds, dcrColors, view3d, storyBefore3d, groupsTab, selectionKind, dock, maximized, railOpen, railPinned, railW })
  }, [memberId, groupId, code, font, units, hosts, geom, openGroups, hiddenStories, planElements, planColorMode, planDiagram, flexFace, view3d, storyBefore3d, groupsTab, selectionKind, dock, maximized, railOpen, railPinned, railW])

  // ── model ───────────────────────────────────────────────────────────────────
  // Edits are whole MEMBERS, not just cages: the Editor panel can change geometry and
  // materials too, and one override shape keeps every writer — section drawing, editor,
  // group apply — landing in the same place.
  const liveMembers = useMemo(() => {
    const base = MEMBERS.filter(m => !removedIds.has(m.id)).map(m => memberEdits[m.id] || m)
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
  }, [memberEdits, removedIds, settings])
  // The plan has to lose a deleted beam too, or the model and the map disagree about
  // what exists — and clicking the ghost line would select a member that is gone.
  const frames = useMemo(
    () => MODEL_MAP.frames.filter(f => !f.memberId || !removedIds.has(f.memberId)),
    [removedIds],
  )
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
  const liveDesigns = useMemo(() => liveMembers.map(m => designMemberAllRows(m, code)), [liveMembers, code])

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
  const frozenModel = useMemo(
    () => versions.find(v => v.id === modelVersion) || null,
    [versions, modelVersion],
  )
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

  const setHost = useCallback((kind, host) => setHosts(h => ({ ...h, [kind]: host })), [])
  const closePanel = useCallback(kind => setHosts(h => ({ ...h, [kind]: null })), [])
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
    const m = MEMBERS.find(x => x.id === id)
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

  /** Delete a group AND its beams. The members go into a removal set; the design memo,
   *  the plan and every rollup follow from that one fact. */
  const onDeleteGroupWithMembers = useCallback(gid => {
    if (readOnly) return   // a frozen version has no future; see frozenModel

    const g = groups.find(x => x.id === gid)
    if (!g) return
    const gone = new Set(g.memberIds)
    setRemovedIds(prev => new Set([...prev, ...gone]))
    onGroupsChange(groups.filter(x => x.id !== gid).map(x => ({
      ...x, memberIds: x.memberIds.filter(id => !gone.has(id)),
    })))
    setSelectedFrames(names => names.filter(n => !gone.has(n)))
    // Deleting the beam every other panel is describing would leave them all on a
    // fallback member while the header still named the dead one.
    setMemberId(cur => (gone.has(cur) ? (MEMBERS.find(m => !gone.has(m.id))?.id ?? cur) : cur))
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
    setMemberEdits(e => {
      const base = e[memberId] || MEMBERS.find(m => m.id === memberId)
      if (!base) return e
      const r = t.rebar
      return {
        ...e,
        [memberId]: {
          ...base,
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
        },
      }
    })
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
  const onMemberChange = useCallback(m => { if (readOnly) return; setMemberEdits(e => ({ ...e, [m.id]: m })) }, [readOnly])
  /** Resize every beam in a group from the group card's dimensions — the section
   *  equivalent of applyGroupRebar, and the same reason: a group is one detail, so its
   *  drawing edits the set, not a representative member. */
  const applyGroupSection = useCallback((gid, section) => {
    const g = groups.find(x => x.id === gid)
    if (!g) return
    setMemberEdits(e => {
      const next = { ...e }
      for (const id of g.memberIds) {
        const base = next[id] || MEMBERS.find(m => m.id === id)
        // Carry each member's OWN flange/cover across; only the dimensioned values move.
        if (base) next[id] = { ...base, section: { ...base.section, b: section.b, bw: section.bw, h: section.h } }
      }
      return next
    })
  }, [groups])

  /** Resize the beam from the section drawing. Same override store as every other member
   *  edit, so the engine re-runs and every panel follows — the drawing is just another
   *  way in. */
  const onSectionChange = useCallback(
    next => setMemberEdits(e => ({
      ...e,
      [memberId]: { ...(e[memberId] || MEMBERS.find(m => m.id === memberId)), section: next },
    })),
    [memberId],
  )

  const onRebarChange = useCallback(
    r => {
      if (readOnly) return
      setMemberEdits(e => ({ ...e, [memberId]: { ...(e[memberId] || MEMBERS.find(m => m.id === memberId)), rebar: r } }))
    },
    [memberId, readOnly],
  )
  /** Apply a cage to every beam in a group — what the Group Dashboard's Apply does. */
  const applyGroupRebar = useCallback((gid, rebar) => {
    if (readOnly) return   // a frozen version has no future; see frozenModel

    const g = groups.find(x => x.id === gid)
    if (!g) return
    setGroupRebar(t => ({ ...t, [gid]: rebar }))
    setMemberEdits(e => {
      const next = { ...e }
      for (const id of g.memberIds) {
        const base = next[id] || MEMBERS.find(m => m.id === id)
        if (base) next[id] = { ...base, rebar }
      }
      return next
    })
  }, [groups, readOnly])

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
  const runSuggestAll = useCallback(floors => {
    setSuggestOpen(false)
    const { rebarByGroup, note } = suggestAllGroups(groups, members, code, barFamily, floors)
    setSuggestNote(note)
    if (!rebarByGroup.size) return
    setGroupRebar(t => {
      const next = { ...t }
      for (const [gid, rebar] of rebarByGroup) next[gid] = rebar
      return next
    })
    setMemberEdits(e => {
      const next = { ...e }
      for (const g of groups) {
        const rebar = rebarByGroup.get(g.id)
        if (!rebar) continue
        for (const id of g.memberIds) {
          const base = next[id] || MEMBERS.find(m => m.id === id)
          if (base) next[id] = { ...base, rebar }
        }
      }
      return next
    })
  }, [groups, members, code, barFamily])

  // `font` and `units` ride along in every payload because a detached window is a
  // separate document: it inherits neither the <html> attribute nor the React context.
  // Built once and shared: the Group Dashboard needs it, and so does the Section panel
  // in group mode. Memoised on the model, so an unchanged model costs nothing.
  // The governing result and worst DCR per member, built once. Three consumers want
  // them — the Group Dashboard payload, the Groups panel's per-group statistics, and the
  // plan's colouring — and rebuilding the same reduction three times over ~7,000 rows is
  // the one place in this app where that would actually be felt.
  const { resultById, dcrById, modeById } = useMemo(() => summaryMaps(designs), [designs])

  // The baseline: the model exactly as data.js describes it, which is what an ETABS
  // import would have handed over. Compared against the live model to decide what has
  // been resized, so a beam edited back to its original size correctly stops counting.
  const resizedRows = useMemo(
    () => resizedGroups(groups.map(g => ({ ...g, dcrById })), members, MEMBERS),
    [groups, members, dcrById],
  )

  /**
   * Freeze the working model under a new name and re-run it.
   *
   * This is where the ETABS round trip would go: define one frame-section property per
   * resized group, assign the group's frames to it, File→Save As under the new name, then
   * Analyze→Run and re-read the results. The connection is read-only today (no
   * DefineFrameSection / AssignSection / SaveAs / RunAnalysis anywhere in the adapters,
   * the Electron bridge or the C# sidecar), so the payload is built and the app's own
   * engine produces what the re-run would return. The dialog says as much on its face.
   */
  const onPush = useCallback(({ rows, modelName, payload }) => {
    const snapshot = members.map(m => ({ ...m }))
    const vDesigns = snapshot.map(m => designMemberAllRows(m, code))
    setVersions(vs => {
      const id = `v${vs.length + 1}`
      const next = [...vs, {
        id,
        name: modelName,
        members: snapshot,
        designs: vDesigns,
        groups: groups.map(g => ({ ...g, memberIds: g.memberIds.slice() })),
        groupRebar: { ...groupRebar },
        code,
        payload,
        properties: rows.map(r => ({ label: r.label, name: r.propertyName, b: r.to.b, h: r.to.h, fc: r.to.fc })),
      }]
      setModelVersion(id)
      return next
    })
    setPushOpen(false)
  }, [members, code, groups, groupRebar])

  const versionOptions = useMemo(() => ([
    { value: 'live', label: 'Working model' },
    ...versions.map(v => ({ value: v.id, label: v.name })),
  ]), [versions])

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
    const orig = MEMBERS.find(m => m.id === memberId)
    // In group mode the comparison is the same question asked of the group's own beams:
    // any member will do, since a resize applies to all of them at once.
    const gsel = selectionKind === 'group' ? GROUPS.find(g => g.id === groupId) : null
    const gRef = gsel && gsel.memberIds[0]
    const editedDims = selectionKind === 'group'
      ? dimsChanged(
          (members.find(m => m.id === gRef) || {}).section,
          (MEMBERS.find(m => m.id === gRef) || {}).section,
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
      for (const d of designs) {
        if (!d.member.stationForces) continue
        diagramDataById[d.member.id] = stationEnvelope(d.member.stationForces, planDiagram === 'moment' ? 'M' : 'V')
      }
    }
    return {
      font, units,
      frames, grids: MODEL_MAP.grids, columns: MODEL_MAP.columns, walls: MODEL_MAP.walls,
      stories: MODEL_MAP.stories,
      hiddenStories, elements: planElements, colorMode: planColorMode, view3d,
      diagramMode: planDiagram, diagramDataById,
      dcrById, infoById, errorFrames,
      designGroups: groups,
      autoGroupOverlay: autoOverlay,
      metricById, metricRange, metricLabel, flexFace,
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
  }, [font, units, designs, frames, dcrById, hiddenStories, planElements, planColorMode, planDiagram, view3d, groups, autoOverlay,
    metricById, metricRange, metricLabel, flexFace, dcrThresholds, dcrColors, gradeColorMap, gradeLegend, markEndById, scoStatusById, scoDcrById, focusFrames, selectedFrames])

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
      font, units, selectedGroupId: groupId, payload: dashPayload, suggestNote,
      // The push button stays on the dashboard — it acts on the GROUPS shown there. The
      // version picker moved to the top bar beside the project settings, because which
      // model you are reading is workspace-wide context, not a dashboard setting.
      resizedCount: resizedRows.length, readOnly,
    }),
    [font, units, groupId, dashPayload, suggestNote, resizedRows.length, readOnly],
  )

  /**
   * The S-Concrete panel's payload. `project` is SYNTHESISED: this workspace holds
   * members and groups, the app holds a Project, and the batch wants the latter — it
   * writes one .SCO per design group and needs the group's cage, its members and the
   * code that produced them. Only the fields the batch and its dashboard actually read
   * are built (grep `project.` in useSconcreteBatch: members, designGroups, code,
   * slsCombo, sconcreteResults, sconcreteRanAt), so this cannot drift into a half-copy
   * of a Project that looks complete and is not.
   *
   * Groups carry their EDITED cage (`groupRebar`), the same one the dashboard and the
   * plan use — verifying the cage as imported while the screen shows the cage you just
   * applied would make the whole round trip meaningless.
   */
  const scoProject = useMemo(() => ({
    name: 'S-Dash demo model',
    code,
    members,
    designGroups: groups.map(g => ({ ...g, rebar: groupRebar[g.id] || g.rebar })),
    slsCombo: sco.slsCombo ?? undefined,
    sconcreteResults: sco.results ?? undefined,
    sconcreteRanAt: sco.ranAt ?? undefined,
  }), [code, members, groups, groupRebar, sco])

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
    if (res.type === 'tear') { setMaximized(null); setHost(kind, 'window'); return }
    if (res.type === 'dock') {
      setMaximized(null)
      setHosts(h => (h[kind] === 'dock' ? h : { ...h, [kind]: 'dock' }))
      setDock(cur => placePanel(cur || { cols: [] }, kind, res.target))
      return
    }
    // Floated where it was dropped. The offset puts the cursor on the header rather than
    // in the corner, so the panel appears under the hand that dragged it.
    setGeom(all => ({ ...all, [kind]: { ...(all[kind] || DEFAULT_GEOM(kind)), x: Math.max(0, res.x - 90), y: Math.max(0, res.y - 14) } }))
    setHost(kind, 'float')
  }, [setHost])
  const dockDrag = useDockDrag({ resolverRef, onResult: onDragResult })

  const toggleMax = useCallback(kind => setMaximized(m => (m === kind ? null : kind)), [])

  // ── context menu ────────────────────────────────────────────────────────────
  // Items are built HERE, with closures over this window's state. Detached, only the
  // labels travel and the chosen index comes back — so a menu item does the same thing
  // wherever it was clicked, because it IS the same item.
  const menuItemsFor = useCallback(kind => ([
    { label: `Detach ${PANELS[kind].title}`, disabled: hosts[kind] === 'window' || !canDetach(), on: () => setHost(kind, 'window') },
    { label: hosts[kind] === 'float' ? 'Dock in workspace' : 'Float over workspace', disabled: hosts[kind] === 'window', on: () => setHost(kind, hosts[kind] === 'float' ? 'dock' : 'float') },
    { label: maximized === kind ? 'Restore' : 'Maximise', disabled: hosts[kind] !== 'dock', on: () => toggleMax(kind) },
    { sep: true },
    { label: 'Jump to governing row', on: () => selectRow(design.governing.row.load.id) },
    { label: 'Detach every panel', disabled: !canDetach(), on: () => setHosts(h => { const n = { ...h }; for (const k of PANEL_ORDER) if (n[k]) n[k] = 'window'; return n }) },
    { sep: true },
    // Reset's home now that it has no toolbar chip. Deliberately NOT in the dep array:
    // resetAll is declared further down, so naming it there would be read at render time
    // and throw on the temporal dead zone. The body is only read when a menu item is
    // clicked, by which point the binding exists — and resetAll is useCallback([]), so
    // its identity never changes and there is no stale closure to worry about.
    { label: 'Reset workspace and edits', on: () => resetAll() },
    { label: `Close ${PANELS[kind].title}`, on: () => closePanel(kind) },
  ]), [hosts, design, setHost, closePanel, selectRow, maximized, toggleMax])

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
  const onSettingsSave = useCallback(({ code: nextCode, settings: next }) => {
    setCode(nextCode)
    setUnitsState(next.units)
    setSettings(next)
    setSettingsOpen(false)
    // Materials are NOT pushed into memberEdits here. They are derived in the `members`
    // memo from `settings.overrideImportedMaterials`, so the dialog's f'c / fy / fyt rows
    // reach every beam the moment the box is ticked and stop reaching them the moment it
    // is unticked — see the note there. Writing them down here instead would make the
    // tick a one-way door: untick would leave the flattened grades behind, because
    // nothing would remember what each member's ETABS section had said.
  }, [])

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
    return [
      { label: frameName || memberId, disabled: true },
      { label: 'Open in the workspace', on: () => pickMember(memberId) },
      { sep: true },
      { label: 'Change group — adopts its section, material and cage', disabled: true },
      ...groups.map(g => {
        const isCurrent = g.id === current?.id
        const t = groupTemplate(g.id)
        return {
          // The donor is named in the label because this is a destructive edit and the
          // beam it copies from is the one fact that decides what you get.
          label: `${isCurrent ? '✓ ' : '→ '}${g.label}${t && !isCurrent ? `  (as ${t.donorId})` : ''}`,
          disabled: isCurrent || !t,
          on: () => moveMemberToGroup(memberId, g.id),
        }
      }),
      ...(groups.length ? [] : [{ label: 'No groups yet — make one in the Groups panel', disabled: true }]),
    ]
  }, [groups, groupTemplate, moveMemberToGroup, pickMember])

  /** Docked / floating: the menu opens in this window, from these very items. */
  const onBeamMenu = useCallback(
    (memberId, frameName, x, y) => openMenu(x, y, beamMenuItems(memberId, frameName)),
    [openMenu, beamMenuItems],
  )

  // ── where each panel mounts ─────────────────────────────────────────────────
  const host = usePopoutHost()
  const fns = kind => ({
    onClose: () => closePanel(kind),
    onWindowClosed: () => setHost(kind, 'dock'),   // the window's ✕ re-docks the panel
    onSelectRow: selectRow,
    onRebarChange,
    onSectionChange,
    onUpdate: onMemberChange,
    onSelectGroup: pickGroup,
    onHiddenStories: setHiddenStories,
    onElements: setPlanElements,
    onColorMode: setPlanColorMode,
    onDiagramMode: setPlanDiagram,
    onDcrThresholds: setDcrThresholds,
    onDcrColors: setDcrColors,
    onFlexFace: setFlexFace,
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
    // Opens the size-floor dialog in the MAIN window even when the dashboard is
    // detached — the dialog is app state, and it belongs where the state lives.
    onSuggestAll: () => setSuggestOpen(true),
    onPushToEtabs: () => setPushOpen(true),
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
    here[kind] = hosts[kind] ? host.publish(kind, hosts[kind] === 'window', payload[kind], fns(kind)) : false
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
          onDcrThresholds={setDcrThresholds} onDcrColors={setDcrColors} onFlexFace={setFlexFace}
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
        onSuggestAll={() => setSuggestOpen(true)}
        onPushToEtabs={() => setPushOpen(true)} />
    )
  }

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
    setGeom({}); setMemberEdits({}); setGroupRebar({}); setRowSel({}); setQuery(''); setFailsOnly(false)
    setDock(null); setMaximized(null); setRailOpen(false); setRailPinned(false); setRailW(258)
    setGroups(GROUPS); setActiveGroupId(null); setRemovedIds(new Set())
    setAutoOverlay([]); setHighlightFrames([]); setGroupsTab(DEFAULT_LAYOUT.groupsTab)
    setSelectedFrames([])
    setView3d(false); setStoryBefore3d(null)
    setHiddenStories(DEFAULT_LAYOUT.hiddenStories); setPlanElements(DEFAULT_LAYOUT.planElements)
    setPlanColorMode(DEFAULT_LAYOUT.planColorMode)
    setPlanDiagram(DEFAULT_LAYOUT.planDiagram); setFlexFace(DEFAULT_LAYOUT.flexFace)
    // Pushed model versions go with the rest of the model. A "new project" that kept
    // three revisions of a frame it no longer has would be describing nothing.
    setVersions([]); setModelVersion('live'); setPushOpen(false); setSuggestNote(null)
    setDcrThresholds(DEFAULT_LAYOUT.dcrThresholds); setDcrColors(DEFAULT_LAYOUT.dcrColors)
  }, [])

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="sdash-root demo-shell" onMouseDown={() => setMenu(null)}>
      {/* Pushes `units` into the app's real UnitsContext, which is what SectionView and
          every formatter read. Rendered, not called, because it owns an effect. */}
      <UnitsSync units={units} />
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
          onSave={onSettingsSave}
        />
      )}
      <div className="sdash-topbar">
        <div className="sdash-topbar-side">
          <span className="demo-brandwrap">
            <span className="sdash-brand">S-DASH</span>
            <span className="sdash-pill">BEAM</span>
          </span>
          {/* The app's application menu, in the page — see MenuBar.js for why it is not
              the native one the product uses. */}
          <MenuBar
            onNewProject={resetAll}
            onReset={resetAll}
            onOpenHelp={tab => setHelpTarget(tab)}
          />
          <select className="sdash-code" value={code} onChange={e => setCode(e.target.value)}
                  title="Design code — switches the engine and the calc sheet">
            <option value="ACI318-19">ACI 318-19</option>
            <option value="EN1992-1-1">EN 1992-1-1</option>
          </select>
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
          {versionOptions.length > 1 && (
            <>
              <select
                className="demo-modelsel"
                value={modelVersion}
                onChange={e => setModelVersion(e.target.value)}
                title="Which model the whole workspace is reading — the working model, or one you pushed"
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
          {/* The app's gear chip, and the app's dialog behind it. Units, design code,
              materials, cover, moduli, bar family and display scale all live in there —
              which is why the demo no longer carries its own unit toggle. */}
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
          onCancel={() => setPushOpen(false)}
          onPush={onPush}
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
                      a {MEMBERS.length}-beam mock frame from <code>data.js</code>.
                    </div>
                  </div>
                ) : (
                  <HelpView target={{ tab: helpTarget }} />
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}

      {suggestOpen && (
        <Portal>
          <SuggestSizeDialog
            code={code}
            title="Suggest all groups"
            onCancel={() => setSuggestOpen(false)}
            onConfirm={runSuggestAll}
          />
        </Portal>
      )}

      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
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
