import { useEffect, useRef } from 'react'
import { openChannel, PANELS, isDesktop, cloneable } from './popoutBus.js'

// Post, and say so when it fails. postMessage throws DataCloneError on anything it
// cannot serialise, and swallowing that is how a panel ends up receiving nothing and
// sitting on "Loading…" with an empty log. cloneable() should prevent it; if it ever
// throws again, this says which panel and why rather than leaving a window to hang.
function post(ch, kind, props) {
  try {
    ch.postMessage({ t: 'props', kind, props: cloneable(props) })
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

// The main window's half of the popout bus.
//
// For each panel it decides WHERE that panel mounts — its own window when detached,
// in the workspace otherwise — then keeps a detached panel fed with props and runs the
// callbacks it sends back. State never leaves this window; only a snapshot of the props
// goes out, and every handler still runs here. That is what lets a rebar edit made in a
// floating Section window land in the same reducer as one made in the docked panel.
//
//     const host = usePopoutHost()
//     const renderHere = host.publish('section', detached, props, fns)
export default function usePopoutHost() {
  const chRef = useRef(null)
  const live = useRef(new Map())     // kind -> { props, fns, detached }
  const opened = useRef(new Set())   // kinds whose window we have asked for
  const wins = useRef(new Map())     // kind -> Window (browser host only)
  const sent = useRef(new Map())     // last props posted per kind
  const held = useRef(new Map())     // kind -> menu items a popout is choosing from

  useEffect(() => {
    const ch = openChannel()
    chRef.current = ch
    if (!ch) return undefined
    ch.onmessage = e => {
      const m = e && e.data
      if (!m || !m.kind) return
      const rec = live.current.get(m.kind)
      // A window that has just opened wants the props it missed.
      if (m.t === 'hello' && rec && rec.detached) {
        sent.current.set(m.kind, rec.props)
        post(ch, m.kind, rec.props)
      } else if (m.t === 'call' && rec) {
        const fn = rec.fns && rec.fns[m.fn]
        if (typeof fn === 'function') fn(...(m.args || []))
      } else if (m.t === 'req' && rec) {
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
            t: 'res', kind: m.kind, id: m.id,
            items: items.map(it => ({ label: it.label, disabled: !!it.disabled, sep: !!it.sep })),
          })
        } catch { /* the popout times its request out */ }
      } else if (m.t === 'invoke') {
        const it = (held.current.get(m.kind) || [])[m.index]
        if (it && !it.disabled && typeof it.on === 'function') it.on()
      } else if (m.t === 'closed') {
        // The window went away on its own — re-dock the panel so the workspace agrees.
        opened.current.delete(m.kind)
        wins.current.delete(m.kind)
        if (rec && rec.fns && typeof rec.fns.onWindowClosed === 'function') rec.fns.onWindowClosed()
      }
    }
    return () => { ch.close(); chRef.current = null }
  }, [])

  // Take the panel windows with us when the app page goes away. Without this a browser
  // reload leaves orphans on screen, each connected to a channel nobody is listening on.
  useEffect(() => {
    const bye = () => {
      const ch = chRef.current
      for (const kind of opened.current) {
        if (ch) { try { ch.postMessage({ t: 'close', kind }) } catch { /* going away anyway */ } }
        const w = wins.current.get(kind)
        if (w && !w.closed) { try { w.close() } catch { /* cross-origin, cannot happen here */ } }
      }
    }
    window.addEventListener('pagehide', bye)
    return () => window.removeEventListener('pagehide', bye)
  }, [])

  const openWindow = kind => {
    const title = (PANELS[kind] || {}).title || 'Panel'
    if (isDesktop() && window.desktop.popout) { window.desktop.popout(kind, title); return }
    // Browser host: a named feature string is what makes this a WINDOW rather than a
    // tab — a tab cannot be dragged to another monitor, which is the whole point.
    const w = window.open(
      `${window.location.pathname}?popout=${encodeURIComponent(kind)}`,
      `sdash-${kind}`,
      'popup=yes,width=820,height=600',
    )
    if (w) wins.current.set(kind, w)
    else console.warn(`popout ${kind}: the browser blocked the window — allow pop-ups for this origin.`)
  }

  const closeWindow = kind => {
    const ch = chRef.current
    if (ch) { try { ch.postMessage({ t: 'close', kind }) } catch { /* window may already be gone */ } }
    const w = wins.current.get(kind)
    if (w && !w.closed) { try { w.close() } catch { /* ignore */ } }
    wins.current.delete(kind)
  }

  return {
    // Record a panel's current props/handlers and keep its window in step with
    // `detached`. Returns true when the caller should still render it in the workspace.
    publish(kind, detached, props, fns) {
      live.current.set(kind, { props, fns, detached: !!detached })
      const ch = chRef.current
      if (detached) {
        if (!opened.current.has(kind)) {
          opened.current.add(kind)
          sent.current.delete(kind)     // a new window needs the first payload
          openWindow(kind)
        }
        // Only post when something actually changed. publish() runs on every render of
        // the main window, so a keystroke would otherwise broadcast every panel — and
        // the calc-sheet payload is not small. Shallow compare is enough because these
        // props are rebuilt by useMemo, so an unchanged panel keeps its identities.
        if (ch && !shallowSame(sent.current.get(kind), props)) {
          sent.current.set(kind, props)
          post(ch, kind, props)
        }
        return false                    // hosted out of process — never render in-page
      }
      if (opened.current.has(kind)) {
        opened.current.delete(kind)
        sent.current.delete(kind)
        closeWindow(kind)
      }
      return true
    },
  }
}
