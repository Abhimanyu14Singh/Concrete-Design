// Bus between the main window and its detached panels. Lifted from the Template,
// with one change: the Template only detaches on the desktop, because that is where a
// panel can become a real OS window. Here the demo is SERVED over http://127.0.0.1,
// which means a browser can do it too — window.open on the same origin is a real
// window you can drag onto a second monitor, and BroadcastChannel reaches it because
// the origin matches. So the same code drives both hosts and you can see the whole
// idea without installing anything.
//
// The rule that makes it work is unchanged: the MAIN window owns all state. A panel
// is handed props and hands back events, and never knows which window it is in.
export const CHANNEL = 'sdash-beam-demo'

export function openChannel() {
  try { return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL) }
  catch { return null }
}

// Every panel that may own a window, and what has to travel back for it to work there.
//
//   fns  — fire and forget. Posted to the main window and run there; nothing returns.
//   reqs — must ANSWER. Goes over a request/reply pair because the caller needs the
//          return value (a context menu's items, say).
//
// Anything a panel calls that is NOT listed here arrives undefined. Guard optional
// handlers at the call site rather than assuming they are present — calling undefined
// throws out of an event handler and can leave a gesture stuck mid-drag, which looks
// like a frozen window rather than the crash it is.
export const PANELS = {
  section: {
    title: 'Section',
    // In GROUP mode this panel is the group card, so it needs the card's whole edit
    // surface — apply the cage, pin an L/3 note, set the reduced mid-third / opposite-end
    // / end-third cages, sign the group off. Anything missing here arrives undefined in a
    // detached window and the affordance silently does nothing, which is worse than not
    // offering it.
    fns: [
      'onClose', 'onRebarChange', 'onSectionChange', 'onSelectRow', 'onApplyRebar', 'onApplySection',
      'onToggleCurtailmentNote', 'onSetOppositeTop', 'onSetMidThirdTop',
      'onSetEndThirdBot', 'onSetReviewed',
    ],
    reqs: ['menuItemsFor'],
  },
  calc:    { title: 'Calc Sheet',    fns: ['onClose', 'onSelectRow'],                  reqs: ['menuItemsFor'] },
  loads:   { title: 'Loads',         fns: ['onClose', 'onSelectRow'],                  reqs: ['menuItemsFor'] },
  force:   { title: 'Force Diagram', fns: ['onClose', 'onSelectRow'],                  reqs: ['menuItemsFor'] },
  elevation: { title: 'Elevation',   fns: ['onClose'],                                 reqs: ['menuItemsFor'] },
  // The editor hands back a WHOLE Member — the heaviest thing that crosses the bus, and
  // the reason `cloneable()` has to walk all the way down rather than skim the top level.
  editor:  { title: 'Editor',        fns: ['onClose', 'onUpdate'],                     reqs: ['menuItemsFor'] },
  plan: {
    title: 'Plan',
    fns: ['onClose', 'onStory', 'onColorMode', 'onSelectFrames', 'onOpenMember', 'onView3d', 'onDiagramMode', 'onDcrThresholds', 'onDcrColors', 'onFlexFace'],
    // `beamMenuFor` is a REQ for the same reason the header menu is: the items are built
    // in the main window over its state, so only their labels can cross and the chosen
    // index has to come back. It takes the member and frame name as arguments — the bus
    // forwards req args, so one handler serves every beam rather than the main window
    // pushing a menu per frame into the payload.
    reqs: ['menuItemsFor', 'beamMenuFor'],
  },
  // Grouping. `onGroupsChange` and `onApplySuggestion` both hand back a whole
  // DesignGroup[] — the heaviest thing on this bus after the Editor's Member, and the
  // reason `cloneable()` has to walk all the way down: a group list is a DAG, with the
  // same member id string repeated across bins and the same colour shared between them.
  groups: {
    title: 'Groups',
    fns: [
      'onClose', 'onGroupsChange', 'onActiveGroupChange', 'onSelectFrames',
      'onDeleteGroupWithMembers', 'onApplySuggestion', 'onOverlayChange',
      'onHighlightFrames', 'onTab',
    ],
    reqs: ['menuItemsFor'],
  },
  dashboard: {
    title: 'Group Dashboard',
    fns: ['onClose', 'onSelectGroup', 'onApplyRebar', 'onOpenMember', 'onSetReviewed', 'onSuggestAll', 'onPushToEtabs'],
    reqs: ['menuItemsFor'],
  },
  // S-Concrete verification. `onProjectPatch` carries the run's RESULTS back — plain
  // fields, not the updater the hook produces, because a function cannot be posted (see
  // SconcretePanel). Everything native happens in the main process either way, so a
  // detached window drives the same batch the docked panel does.
  sconcrete: {
    title: 'S-Concrete',
    fns: ['onClose', 'onSelectGroup', 'onOpenMember', 'onProjectPatch'],
    reqs: ['menuItemsFor'],
  },
}

export const PANEL_ORDER = ['plan', 'groups', 'section', 'calc', 'loads', 'force', 'elevation', 'editor', 'dashboard', 'sconcrete']

export const isPopoutWindow = () => {
  try { return !!new URLSearchParams(window.location.search).get('popout') } catch { return false }
}

export const popoutKind = () => {
  try { return new URLSearchParams(window.location.search).get('popout') } catch { return null }
}

/** The Electron shell, which can give a panel a frameless-titled OS window. */
export const isDesktop = () =>
  typeof window !== 'undefined' && !!(window.desktop && window.desktop.isDesktop)

/** Either host can detach; only the window furniture differs. */
export const canDetach = () =>
  isDesktop() || (typeof window !== 'undefined' && typeof window.open === 'function')

// Strip anything structured-clone would choke on, so one unserialisable prop cannot
// silently kill the whole message.
//
// This has to go all the way down. A shallow version only drops functions sitting
// directly on the props object, and the prop that actually broke every panel in the
// app this came from was an OBJECT whose values were formatters. Shallow, it looked
// perfectly cloneable; postMessage disagreed and threw, and the panels it killed
// showed "Loading…" with nothing logged.
//
// Maps, Sets, Dates and typed arrays clone natively and are passed through whole —
// walking into them would rebuild them as plain objects and change what panels get.
//
// ── The visited set tracks the current PATH, not everything seen ────────────────
//
// The Template's version carried one WeakSet for the whole traversal and returned
// undefined for anything already in it. That catches cycles, but it also DELETES every
// repeat of a merely SHARED reference — and a payload of any size is a DAG, not a tree.
// Two beams pointing at one cage object, a group template also referenced by its
// members, a bar-size array reused across a row: the first occurrence survives, every
// later one silently becomes undefined, and the panel crashes on `.length` of something
// that was plainly there in the sending window. It is a horrible bug to chase, because
// the object is fine everywhere you would think to look.
//
// Adding on the way down and REMOVING on the way back up keeps the cycle guard (an
// ancestor is still in the set) while letting siblings share freely. The cost is that a
// shared subtree is copied once per reference instead of once — which is what postMessage
// would do to it anyway.
export function cloneable(v, path) {
  if (v === null || typeof v !== 'object') {
    return (typeof v === 'function' || typeof v === 'symbol') ? undefined : v
  }
  if (v instanceof Map || v instanceof Set || v instanceof Date || ArrayBuffer.isView(v)) return v
  path = path || new Set()
  if (path.has(v)) return undefined            // a true cycle — this cannot be posted
  path.add(v)
  let out
  if (Array.isArray(v)) {
    out = v.map(x => cloneable(x, path))
  } else {
    out = {}
    for (const k of Object.keys(v)) {
      const c = cloneable(v[k], path)
      if (c !== undefined) out[k] = c
    }
  }
  path.delete(v)                               // left this branch; a sibling may share it
  return out
}
