import { useEffect, useRef } from 'react'
import { openChannel, PANELS, isDesktop, cloneable, shellWindowBounds } from './popoutBus'
import { DOCK, windowLabel } from './windowDock'

/**
 * How long to wait before believing a window really closed.
 *
 * `pagehide` fires for a RELOAD as well as for a close, and the two are
 * indistinguishable from the event alone. Since a closed window now CLOSES its panels,
 * treating a reload as a close would mean F5 in a detached window silently destroys
 * everything in it. So the close is deferred: if the same window says `hello` again
 * within the grace period, it reloaded and the close is cancelled.
 *
 * Long enough for a page to come back (a reload re-runs the bundle), short enough that
 * shutting a window feels immediate.
 */
const RELOAD_GRACE_MS = 900

// Post, and say so when it fails. postMessage throws DataCloneError on anything it
// cannot serialise, and swallowing that is how a panel ends up receiving nothing and
// sitting on "Loading…" with an empty log. cloneable() should prevent it; if it ever
// throws again, this says which panel and why rather than leaving a window to hang.
function post(ch, win, kind, props) {
  try {
    ch.postMessage({ t: 'props', win, kind, props: cloneable(props) })
  } catch (err) {
    console.error(`popout ${kind}: props would not post -`, err && err.message)
  }
}

// Same keys, same identities — enough to tell "nothing moved" from "repaint me".
function shallowSame(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => a[k] === b[k])
}

/**
 * Does this panel's payload need posting?
 *
 * `publish` runs on every render of the main window, so posting unconditionally would
 * broadcast every panel on every keystroke — and the calc-sheet payload is not small.
 * Shallow compare is enough for the props themselves, because they are rebuilt by
 * useMemo and an unchanged panel keeps its identities.
 *
 * MOVING COUNTS AS A CHANGE even when the props are identical, which is the part that is
 * easy to miss. A panel dragged from one window to another carries exactly the props it
 * had, so comparing props alone posts nothing — and the receiving window ends up told it
 * holds the panel but never told what to draw, showing an empty slot where it should be.
 * Exported so that stays pinned by a test rather than by memory.
 */
export function needsPost(prevProps, prevWin, props, win) {
  return prevWin !== win || !shallowSame(prevProps, props)
}

// The main window's half of the popout bus.
//
// State never leaves this window. A detached window is handed a snapshot of its panels'
// props and a description of what it is holding; every callback it fires runs back here,
// which is what lets a rebar edit made in a floating Section window land in the same
// reducer as one made in the docked panel.
//
// WHAT CHANGED WHEN WINDOWS BECAME CONTAINERS
//
// This used to be keyed by panel kind throughout: one window per kind, `?popout=<kind>`,
// every message addressed by kind. A window and a panel were the same thing, so there
// was no way to name a window in order to put a second panel in it.
//
// Now there are two levels. WINDOWS (`w1`, `w2`, …) are opened, closed and told what
// they contain; PANELS are published into whichever window currently holds them. Panel
// traffic still carries its kind — that is what routes a callback to the right handler —
// but it also carries the window, so a panel that moves between windows keeps working
// without anything being torn down and rebuilt.
//
//     const host = usePopoutHost({ onMove, onWinDock, onWindowClosed })
//     host.syncWindows([{ id: 'w1', kinds: ['calc', 'section'], dock }])
//     const renderHere = host.publish('calc', 'w1', props, fns)
export default function usePopoutHost({ onMove, onMerge, onWinDock, onWindowClosed } = {}) {
  const chRef = useRef(null)
  const live = useRef(new Map())     // kind -> { props, fns, win }
  const windows = useRef(new Map())  // winId -> { kinds, dock }
  const opened = useRef(new Set())   // window ids whose OS window we have asked for
  const wins = useRef(new Map())     // winId -> Window (browser host only)
  const sent = useRef(new Map())     // kind -> last props posted
  const sentTo = useRef(new Map())   // kind -> the window those props were posted TO
  const sentWin = useRef(new Map())  // winId -> last contents signature posted
  const held = useRef(new Map())     // kind -> menu items a popout is choosing from
  const closing = useRef(new Map())  // winId -> pending close timer (see RELOAD_GRACE_MS)

  // Handlers change identity every render; the channel listener is installed once. A ref
  // keeps the listener pointing at the CURRENT ones without resubscribing (which would
  // drop messages in flight).
  const cbs = useRef({})
  cbs.current = { onMove, onMerge, onWinDock, onWindowClosed }

  /**
   * The OTHER windows, as a window's merge menu needs them.
   *
   * A detached window cannot work this out for itself — it has no handle on its
   * siblings and no idea what they hold — so the roster travels with its contents.
   * Titles rather than kinds, because it goes straight into a menu.
   */
  const rosterFor = winId => [...windows.current.entries()]
    .filter(([id]) => id !== winId)
    .map(([id, rec]) => ({
      id,
      label: windowLabel(id),
      panels: (rec.kinds || []).map(k => (PANELS[k] || {}).title || k),
    }))

  const postContents = (ch, winId) => {
    const rec = windows.current.get(winId)
    if (!ch || !rec) return
    try {
      ch.postMessage({
        t: 'contents', win: winId, kinds: rec.kinds,
        dock: cloneable(rec.dock), title: windowLabel(winId),
        others: rosterFor(winId),
      })
    } catch (err) {
      console.error(`popout ${winId}: contents would not post -`, err && err.message)
    }
  }

  useEffect(() => {
    const ch = openChannel()
    chRef.current = ch
    if (!ch) return undefined
    ch.onmessage = async e => {
      const m = e && e.data
      if (!m) return
      const rec = m.kind ? live.current.get(m.kind) : null

      if (m.t === 'hello') {
        // Back so soon? Then the `closed` we just heard was a RELOAD, not a close — call
        // it off before it takes the window's panels with it.
        const pending = closing.current.get(m.win)
        if (pending) { clearTimeout(pending); closing.current.delete(m.win) }
        // A window that has just opened (or reloaded) wants everything it missed: what it
        // is holding, then the props for each of those panels.
        postContents(ch, m.win)
        for (const kind of (windows.current.get(m.win) || { kinds: [] }).kinds) {
          const r = live.current.get(kind)
          if (r) { sent.current.set(kind, r.props); post(ch, m.win, kind, r.props) }
        }
        return
      }

      if (m.t === 'bounds?') {
        // A drag is starting over there. Only this window can answer where the others
        // are — see shellWindowBounds.
        const list = await shellWindowBounds(wins.current)
        try { ch.postMessage({ t: 'bounds', win: m.win, list }) } catch { /* drag falls back to in-window */ }
        return
      }

      if (m.t === 'move') {
        // "Put panel `kind` into window `to`, at `target`." Every route — drag across
        // windows, the Move-to menu, a tear-off from a popout — funnels through here, so
        // the model only has one way in.
        if (cbs.current.onMove) cbs.current.onMove(m.kind, m.to, m.target || null)
        return
      }

      if (m.t === 'merge') {
        // "Empty window `from` into window `to`." A whole-window verb, so it cannot be
        // expressed as a panel move — see mergeWindows.
        if (cbs.current.onMerge) cbs.current.onMerge(m.from, m.to)
        return
      }

      if (m.t === 'wdock') {
        // The window rearranged itself internally. Persist it so the split survives a
        // move or a restart.
        if (cbs.current.onWinDock) cbs.current.onWinDock(m.win, m.dock)
        return
      }

      if (m.t === 'closed') {
        // Deferred, so a reload can take it back — see RELOAD_GRACE_MS. Nothing is
        // forgotten until the timer fires: `opened` in particular must keep this window
        // for now, or a re-render in the meantime would see a window with panels and no
        // OS window, and helpfully open a second one.
        const prev = closing.current.get(m.win)
        if (prev) clearTimeout(prev)
        closing.current.set(m.win, setTimeout(() => {
          closing.current.delete(m.win)
          opened.current.delete(m.win)
          wins.current.delete(m.win)
          sentWin.current.delete(m.win)
          if (cbs.current.onWindowClosed) cbs.current.onWindowClosed(m.win)
        }, RELOAD_GRACE_MS))
        return
      }

      if (!rec) return
      if (m.t === 'call') {
        const fn = rec.fns && rec.fns[m.fn]
        if (typeof fn === 'function') fn(...(m.args || []))
      } else if (m.t === 'req') {
        // A call that has to answer. Only the LABELS can travel: each menu item carries
        // an `on` closure over this window's state, which will not clone and would not
        // mean anything over there anyway. So the items are kept here, the popout is
        // sent their labels, and it replies with the index it wants — "invoke" then runs
        // the closure, still in this window, exactly as a docked click would.
        const fn = rec.fns && rec.fns[m.fn]
        let items = []
        try { items = (typeof fn === 'function' ? fn(...(m.args || [])) : null) || [] } catch { items = [] }
        held.current.set(m.kind, items)   // one menu open at a time — nothing to reap
        try {
          ch.postMessage({
            t: 'res', win: m.win, kind: m.kind, id: m.id,
            items: items.map(function ser(it) {
              return {
                label: it.label, disabled: !!it.disabled, sep: !!it.sep,
                ...(it.title ? { title: it.title } : {}),
                ...(it.danger ? { danger: true } : {}),
                // Submenu children travel too, so a detached panel can render the same
                // nested list. Their closures stay here; the popout replies with a PATH.
                ...(it.children ? { children: it.children.map(ser) } : {}),
              }
            }),
          })
        } catch { /* the popout times its request out */ }
      } else if (m.t === 'invoke') {
        // A path, so a submenu entry can be addressed too. `index` is the old
        // single-level form and still works.
        const path = Array.isArray(m.path) ? m.path : [m.index]
        let list = held.current.get(m.kind) || []
        let it = null
        for (const idx of path) {
          it = list[idx]
          if (!it) break
          list = it.children || []
        }
        if (it && !it.disabled && typeof it.on === 'function') it.on()
      }
    }
    return () => {
      for (const t of closing.current.values()) clearTimeout(t)
      closing.current.clear()
      // Take the panel windows with us. The host is being torn down — File → New
      // Project drops back to the launch screen and unmounts the whole workspace — and
      // a detached window outliving it is stranded: its channel has no listener, so it
      // shows the last model it was sent, forever, with every control inert.
      //
      // The `close` message goes out BEFORE the channel does, and Electron gets a direct
      // IPC as well: the message depends on the popout's own listener still running,
      // which is a race worth not relying on when there is a synchronous route.
      for (const winId of opened.current) {
        try { ch.postMessage({ t: 'close', win: winId }) } catch { /* going away anyway */ }
        if (isDesktop() && window.desktop.popoutClose) {
          try { window.desktop.popoutClose(winId) } catch { /* the message is the fallback */ }
        }
        const w = wins.current.get(winId)
        if (w && !w.closed) { try { w.close() } catch { /* cross-origin, cannot happen here */ } }
      }
      opened.current.clear()
      wins.current.clear()
      ch.close(); chRef.current = null
    }
  }, [])

  // Take the panel windows with us when the app page goes away. Without this a browser
  // reload leaves orphans on screen, each connected to a channel nobody is listening on.
  useEffect(() => {
    const bye = () => {
      const ch = chRef.current
      for (const winId of opened.current) {
        if (ch) { try { ch.postMessage({ t: 'close', win: winId }) } catch { /* going away anyway */ } }
        const w = wins.current.get(winId)
        if (w && !w.closed) { try { w.close() } catch { /* cross-origin, cannot happen here */ } }
      }
    }
    window.addEventListener('pagehide', bye)
    return () => window.removeEventListener('pagehide', bye)
  }, [])

  const openWindow = winId => {
    const title = windowLabel(winId)
    if (isDesktop() && window.desktop.popout) { window.desktop.popout(winId, title); return }
    // Browser host: a named feature string is what makes this a WINDOW rather than a
    // tab — a tab cannot be dragged to another monitor, which is the whole point.
    const w = window.open(
      `${window.location.pathname}?popout=${encodeURIComponent(winId)}`,
      `sdash-${winId}`,
      'popup=yes,width=900,height=660',
    )
    if (w) wins.current.set(winId, w)
    else console.warn(`popout ${winId}: the browser blocked the window — allow pop-ups for this origin.`)
  }

  const closeWindow = winId => {
    // We are closing this one deliberately (its last panel moved out), so any deferred
    // close from its own `pagehide` is redundant — and would run against a window id
    // that may have been handed to a NEW window by then.
    const pending = closing.current.get(winId)
    if (pending) { clearTimeout(pending); closing.current.delete(winId) }
    const ch = chRef.current
    if (ch) { try { ch.postMessage({ t: 'close', win: winId }) } catch { /* may already be gone */ } }
    if (isDesktop() && window.desktop.popoutClose) {
      try { window.desktop.popoutClose(winId) } catch { /* the `close` message is the fallback */ }
    }
    const w = wins.current.get(winId)
    if (w && !w.closed) { try { w.close() } catch { /* ignore */ } }
    wins.current.delete(winId)
    sentWin.current.delete(winId)
  }

  return {
    /**
     * Declare the full set of panel windows and what each holds.
     *
     * Opens a window that has appeared, closes one that has emptied, and pushes fresh
     * contents to any whose panel list or layout changed. Call it once per render with
     * the whole set — deriving the open/close from a declared set rather than firing
     * commands at each transition means a move that empties one window and fills another
     * cannot leave a stale window behind.
     */
    syncWindows(list) {
      const ch = chRef.current
      const next = new Map((list || []).map(w => [w.id, { kinds: w.kinds, dock: w.dock }]))
      windows.current = next

      for (const winId of next.keys()) {
        if (!opened.current.has(winId)) {
          opened.current.add(winId)
          sentWin.current.delete(winId)
          openWindow(winId)
        }
      }
      for (const winId of [...opened.current]) {
        if (!next.has(winId)) { opened.current.delete(winId); closeWindow(winId) }
      }
      // Contents are small (a kind list and a layout), but they are posted on every
      // render otherwise — and a popout re-rendering its whole dock on each keystroke in
      // the main window is exactly the sort of thing that makes a second monitor feel
      // laggy. Signature-compare instead.
      for (const [winId, rec] of next) {
        // The roster is part of what a window is told, so it belongs in the signature:
        // without it, opening or closing a SIBLING would never reach this window and its
        // merge menu would go stale.
        const sig = JSON.stringify([rec.kinds, rec.dock, rosterFor(winId)])
        if (sentWin.current.get(winId) !== sig) {
          sentWin.current.set(winId, sig)
          postContents(ch, winId)
        }
      }
    },

    /**
     * Record a panel's current props/handlers and keep its window fed.
     *
     * `winId` is the window holding it, or null when it lives in this one. Returns true
     * when the caller should still render it here.
     */
    publish(kind, winId, props, fns) {
      live.current.set(kind, { props, fns, win: winId || null })
      const ch = chRef.current
      if (!winId) { sent.current.delete(kind); sentTo.current.delete(kind); return true }
      if (ch && needsPost(sent.current.get(kind), sentTo.current.get(kind), props, winId)) {
        sent.current.set(kind, props)
        sentTo.current.set(kind, winId)
        post(ch, winId, kind, props)
      }
      return false                    // hosted out of process — never render in-page
    },

    /**
     * Bring a window forward — after a panel is dropped into it, or when a detached
     * panel's button opened a dialog back here (see `revealHere`).
     *
     * `dock` means THIS window. The desktop host resolves it in the main process, but
     * the browser host cannot: `wins` only holds the popouts this window opened, never
     * itself, so without the first branch focusing the dock silently did nothing. Best
     * effort either way — a browser may refuse a self-focus that no gesture in THIS
     * document asked for, which is why the caller does not rely on it alone.
     */
    focusWindow(winId) {
      if (isDesktop() && window.desktop.popoutFocus) {
        try { window.desktop.popoutFocus(winId) } catch { /* cosmetic */ }
        return
      }
      if (winId === DOCK) { try { window.focus() } catch { /* cosmetic */ } return }
      const w = wins.current.get(winId)
      if (w && !w.closed) { try { w.focus() } catch { /* cosmetic */ } }
    },

    /** Screen bounds of every dockable window — for a drag starting in THIS window. */
    bounds() { return shellWindowBounds(wins.current) },
  }
}
