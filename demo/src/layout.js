// Where each panel is, remembered.
//
// This is the difference between a nice demo and something usable daily: if you put the
// Calc Sheet on the second monitor, it should be there tomorrow. Persisting it also
// forces the layout to be plain serialisable state rather than something scattered
// through component internals — which is why PanelFrame takes its float geometry as a
// controlled prop instead of owning it.
//
// One thing is deliberately NOT restored: a panel saved as `window` comes back as
// `dock`. Reopening two OS windows before the user has asked for anything is startling,
// and in a browser it would be a pop-up on load, which browsers block anyway. The
// toolbar count tells them what was detached; one click puts it back.

import { isLayout } from './dockLayout.js'
import { DEFAULT_DCR_THRESHOLDS, MAP_DCR_COLORS } from '../../src/theme.ts'

const KEY = 'sdash-beam-demo/layout/v2'

const DEFAULTS = {
  memberId: 'B1',
  groupId: 'G-featured',
  code: 'ACI318-19',
  font: 'inter',
  units: 'imperial',
  // Nine panels open at once is a wall, not a workspace. Four start docked; the rest are
  // a toolbar click away.
  //
  // Plan and Groups are docked as a PAIR, because neither is much use without the other:
  // the lasso that feeds "Group selection" is on the plan, and the group you make is what
  // colours it back. Loads gave up its slot for that — it is the most specialised of the
  // four, and the check chips already say which row governs.
  hosts: {
    plan: 'dock', groups: 'dock', section: 'dock', calc: 'dock',
    loads: null, force: null, elevation: null, editor: null, dashboard: null,
    // S-Concrete is the END of the workflow and needs the desktop shell to run a batch,
    // so it starts closed like the rest of the second rank — one toolbar click away.
    sconcrete: null,
  },
  geom: {},          // kind -> {x, y, w, h} for the floating state
  // The rail starts SHUT. It is navigation you reach for, not something to look at
  // while working, and the workspace is the better use of 258px by default.
  railOpen: false,
  railPinned: false,
  railW: 258,
  dock: null,        // the docked column layout; null = derive a default
  maximized: null,   // a kind, when one panel has the whole workspace
  // Storeys the plan HIDES. A plan is ONE floor — superimposing five puts every level's
  // beams on the same lines and stacks five slab fills into a solid grey, which reads as
  // a rendering fault rather than as a whole building. So the default hides all but L2,
  // and the Filter is how you add floors back or compare two.
  hiddenStories: ['R', 'L4', 'L3', 'L1'],
  // Everything drawn by default. Slabs sit behind the framing at 16% and grids are the
  // reference an engineer reads positions against, so hiding either by default would be
  // hiding information to save clutter that is not there.
  planElements: { columns: true, walls: true, floors: true, grids: true },
  planColorMode: 'dcr',
  // The M / V force overlay on the plan: 'off' | 'moment' | 'shear'. A view preference
  // like the projection, so it persists — but it starts OFF, because booting into a
  // model covered in purple polygons hides the colouring that is the plan's usual job.
  planDiagram: 'off',
  // The DCR colour scale: three ascending cut-points and the four band colours they
  // divide. Both are the APP's defaults, imported rather than retyped — a demo that
  // booted on a different green than the product would be the wrong picture of it.
  dcrThresholds: [...DEFAULT_DCR_THRESHOLDS],
  dcrColors: [...MAP_DCR_COLORS],
  // The projection is a VIEW preference, so it persists with the rest of the layout —
  // unlike the grouping itself, which is model and deliberately starts fresh (see App).
  view3d: false,
  // The storey to come back to when 3D is switched off. 3D forces 'All' (one storey
  // tilted is just a plan at an angle), and dropping the user on 'All' afterwards would
  // silently lose the level they had been working on.
  storyBefore3d: null,
  // Which face the ρ ramp measures, in the 'flexSteel' colour mode. 'bot' is the sagging
  // steel, which is the face most beams are actually designed on.
  flexFace: 'bot',       // 'bot' | 'top'
  groupsTab: 'groups',   // 'groups' | 'auto'
  selectionKind: 'member',
  openGroups: {},    // groupId -> true
}

export function loadLayout() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const saved = JSON.parse(raw)
    const hosts = { ...DEFAULTS.hosts }
    for (const k of Object.keys(hosts)) {
      const v = saved.hosts && saved.hosts[k]
      // `null` means "closed" and must survive; anything unrecognised falls back rather
      // than letting a stale key from an older version wedge a panel into limbo.
      if (v === null || v === 'dock' || v === 'float') hosts[k] = v
      else if (v === 'window') hosts[k] = 'dock'
      else hosts[k] = DEFAULTS.hosts[k]
    }
    // A layout out of storage is untrusted input — an old shape must fall back to the
    // default rather than crash the workspace on boot.
    const dock = isLayout(saved.dock) ? saved.dock : null
    // Same rule for the DCR scale, and it earns the check: dcrBandsFrom reads t[0..2] and
    // calls toFixed on each, so a truncated or hand-edited array is a crash on boot in
    // the one panel that opens by default, not a cosmetic fallback.
    const nums = v => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))
    const hexes = v => Array.isArray(v) && v.length === 4 && v.every(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
    const dcrThresholds = nums(saved.dcrThresholds) ? saved.dcrThresholds : [...DEFAULTS.dcrThresholds]
    const dcrColors = hexes(saved.dcrColors) ? saved.dcrColors : [...DEFAULTS.dcrColors]
    return { ...DEFAULTS, ...saved, hosts, dock, dcrThresholds, dcrColors }
  } catch {
    return { ...DEFAULTS }      // corrupt or unavailable storage must never break boot
  }
}

export function saveLayout(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)) }
  catch { /* private mode, quota — losing the layout is not worth an error */ }
}

export function clearLayout() {
  try { localStorage.removeItem(KEY) } catch { /* as above */ }
}

export { DEFAULTS as DEFAULT_LAYOUT }
