// Panels across SEVERAL windows, as data.
//
// The workspace used to have one rule for where a panel lives: `hosts[kind]` was 'dock',
// 'float', 'window' or null, and 'window' meant "its own OS window, alone". That made a
// window and a panel the same thing, so there was nowhere to put a second panel and no
// way to name the window you wanted to put it in.
//
// Here a WINDOW IS A CONTAINER with an id, holding any number of panels in its own column
// layout — the same `dockLayout` the main workspace uses, so a detached window gets the
// same columns, gutters and drag-to-rearrange for free rather than growing a second,
// slightly-different layout engine that would drift.
//
//     hosts:   { calc: 'window' }          // WHAT kind of host
//     winOf:   { calc: 'w1' }              // WHICH window, when that host is 'window'
//     winDock: { w1: {cols:[…]} }          // the layout INSIDE window w1
//     dock:    {cols:[…]}                  // the main workspace's own layout
//
// `dock` is a reserved window id meaning the main workspace, so one set of move
// operations covers "into window w2" and "back into the workspace" without a special
// case at every call site.
//
// Everything here is pure. A move is (state) => state, which is what lets a drag that is
// abandoned mid-gesture leave nothing behind, and what makes the whole model testable
// without a browser, a second monitor, or Electron.

import { panelsOf, placePanel, removePanel, reconcile } from './dockLayout'

/** The main workspace, addressed as if it were a window. */
export const DOCK = 'dock'

/** Every window id currently holding at least one panel. */
export function windowIds(hosts, winOf) {
  const ids = []
  for (const kind of Object.keys(winOf || {})) {
    if (hosts[kind] !== 'window') continue
    const id = winOf[kind]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids.sort()
}

/** The panels held by one window, in no particular order (the layout carries order). */
export function panelsInWindow(hosts, winOf, winId) {
  return Object.keys(winOf || {}).filter(k => hosts[k] === 'window' && winOf[k] === winId)
}

/**
 * A window id not currently in use.
 *
 * Counts UP from w1 and takes the first gap, so closing w2 of three windows and opening
 * another reuses `w2` rather than climbing to `w4`. Ids show up in menus ("Move to ▸
 * Window 2"), and a list that reads 1, 3, 4 invites the question of where 2 went.
 */
export function newWinId(hosts, winOf) {
  const taken = new Set(windowIds(hosts, winOf))
  for (let n = 1; ; n++) {
    const id = `w${n}`
    if (!taken.has(id)) return id
  }
}

/** Human label for a window id — what the "Move to ▸" menu and window titles show. */
export function windowLabel(winId) {
  return winId === DOCK ? 'Workspace' : `Window ${String(winId).replace(/^w/, '')}`
}

/**
 * Move a panel to a window (or back to the workspace), placing it at `target` within
 * that window's layout.
 *
 * One operation covers every route — drag, menu, tear-off — because the destination is
 * always just a window id. `target` is a dockLayout target ({type:'in',ci,ii} or
 * {type:'newcol',ci}); omit it and the panel is appended by `reconcile`, which is what a
 * menu command wants since it has no drop point to speak of.
 *
 * The panel is removed from wherever it was FIRST, so a move and an insert are the same
 * code path and dropping a panel back where it came from is a no-op rather than a
 * duplicate.
 */
export function movePanelToWindow(state, kind, winId, target) {
  const hosts = { ...state.hosts }
  const winOf = { ...state.winOf }
  const winDock = { ...state.winDock }
  let dock = state.dock

  // Leave the old home, whichever it was.
  const wasWin = hosts[kind] === 'window' ? winOf[kind] : null
  if (wasWin && winDock[wasWin]) winDock[wasWin] = removePanel(winDock[wasWin], kind)
  if (hosts[kind] === 'dock' && dock) dock = removePanel(dock, kind)

  if (winId === DOCK) {
    hosts[kind] = 'dock'
    delete winOf[kind]
    // No target means "put it back, wherever fits" — which is `reconcile`, NOT
    // `placePanel(…, null)`. The latter returns the layout with the panel REMOVED
    // (see dockLayout: a null target is how a drag cancels), so a menu-driven "Move to
    // workspace" used to land a panel in `hosts` but not in the layout, leaving it
    // rendered nowhere until an unrelated reconcile effect happened to repair it.
    if (dock) {
      dock = target ? placePanel(dock, kind, target) : reconcile(dock, [...panelsOf(dock), kind])
    }
  } else {
    hosts[kind] = 'window'
    winOf[kind] = winId
    const before = winDock[winId] || { cols: [] }
    winDock[winId] = target
      ? placePanel(before, kind, target)
      : reconcile(before, [...panelsInWindow(hosts, winOf, winId)])
  }
  return prune({ ...state, hosts, winOf, winDock, dock })
}

/** Detach a panel into a NEW window of its own. Returns the state and the id created,
 *  because the caller has to ask the shell to open that window. */
export function detachToNewWindow(state, kind, winId) {
  const id = winId || newWinId(state.hosts, state.winOf)
  return { state: movePanelToWindow(state, kind, id), winId: id }
}

/**
 * Move EVERYTHING from one window into another — three windows become two.
 *
 * Moving panels one at a time already worked, but a window holding four panels then
 * costs four trips through a menu, and the half-emptied window sits there in between.
 * This is the whole-window verb: merge `from` into `to` and let the emptied window go.
 *
 * `to` may be `DOCK`, which folds a detached window back into the main workspace — the
 * same operation, one screen fewer.
 *
 * ORDER COMES FROM THE SOURCE LAYOUT, not from `panelsInWindow` (which is key order and
 * therefore arbitrary). A window whose panels read top-to-bottom should arrive in that
 * order, or a merge quietly reshuffles an arrangement the engineer set up.
 *
 * Each panel is placed with NO target, so `reconcile` drops it into the destination's
 * shortest column. That balances rather than stacking everything into one column, and it
 * needs no decision from the caller — there is no drop point in a menu command.
 */
export function mergeWindows(state, from, to) {
  if (!from || !to || from === to) return state
  // Layout order first, with anything the layout has not caught up with appended — a
  // panel must never be dropped by a merge just because the layout was stale.
  const held = panelsInWindow(state.hosts, state.winOf, from)
  const laidOut = state.winDock[from] ? panelsOf(state.winDock[from]) : []
  const ordered = [...laidOut.filter(k => held.includes(k)), ...held.filter(k => !laidOut.includes(k))]
  if (!ordered.length) return state
  let next = state
  for (const kind of ordered) next = movePanelToWindow(next, kind, to)
  return next
}

/**
 * Close a window and everything in it.
 *
 * Its panels end up CLOSED (`hosts[kind] = null`), not moved somewhere else. Closing a
 * window is how a view is dismissed, so the ✕ has to mean the same thing on a second
 * monitor as it does in the workspace — shutting a window and having its panels
 * reappear in the main dock is the ✕ rearranging a screen you were not looking at.
 *
 * The deliberate routes home are separate and say what they do: the ⇤ button on each
 * panel inside a detached window, and "Move to workspace" in its menu.
 *
 * A no-op when the window is already empty, which is the normal case after its last
 * panel was dragged out — the window then closes itself, and that must not be read as
 * a request to close a panel that has already moved on.
 */
export function closeWindowPanels(state, winId) {
  const kinds = panelsInWindow(state.hosts, state.winOf, winId)
  if (!kinds.length) return state
  const hosts = { ...state.hosts }
  const winOf = { ...state.winOf }
  for (const kind of kinds) { hosts[kind] = null; delete winOf[kind] }
  return prune({ ...state, hosts, winOf })
}

/**
 * Drop window layouts for windows that no longer hold anything, and reconcile the rest
 * against the panels they actually have.
 *
 * Without this an emptied window keeps a layout entry forever, and — worse — a layout
 * can hold a panel that has since moved elsewhere, which would render it in two windows
 * at once. Reconciling here rather than at each call site means every route into the
 * model (drag, menu, close, restore) is self-correcting.
 */
export function prune(state) {
  const winDock = {}
  for (const id of windowIds(state.hosts, state.winOf)) {
    const kinds = panelsInWindow(state.hosts, state.winOf, id)
    winDock[id] = reconcile(state.winDock[id] || { cols: [] }, kinds)
  }
  // A panel marked 'window' with no window id is a broken record — put it back in the
  // dock rather than leaving it unreachable in every host.
  const hosts = { ...state.hosts }
  const winOf = { ...state.winOf }
  for (const kind of Object.keys(hosts)) {
    if (hosts[kind] === 'window' && !winOf[kind]) hosts[kind] = 'dock'
    if (hosts[kind] !== 'window' && winOf[kind]) delete winOf[kind]
  }
  return { ...state, hosts, winOf, winDock }
}

/**
 * Which window is under a screen point.
 *
 * `list` is [{id, x, y, w, h}] in SCREEN coordinates, taken once at drag start (see
 * `popout:bounds` in electron/main.cjs). Hit-testing locally on every pointermove keeps
 * a 60 Hz gesture off the IPC channel.
 *
 * LAST MATCH WINS. The list arrives with the main window first and panel windows after,
 * which is the order they stack in — so when windows overlap, the later (higher) one is
 * the one the user can see under the pointer and the one they mean.
 *
 * `selfId` is excluded: a drag that never leaves its own window is an ordinary in-window
 * dock, already handled by the layout resolver, and letting it match here would turn
 * every local drag into a cross-window move to the window it started in.
 */
export function hitTestWindows(list, screenX, screenY, selfId) {
  let hit = null
  for (const b of list || []) {
    if (!b || b.id === selfId) continue
    if (screenX >= b.x && screenX < b.x + b.w && screenY >= b.y && screenY < b.y + b.h) hit = b.id
  }
  return hit
}

/** Shape check for a persisted `winOf` map — untrusted input out of localStorage. */
export function isWinOf(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v).every(id => typeof id === 'string' && /^w\d+$/.test(id))
}
