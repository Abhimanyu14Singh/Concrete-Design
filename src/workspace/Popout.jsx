import { useCallback, useEffect, useRef, useState } from 'react'
import { openChannel, PANELS } from './popoutBus'
import { DOCK, windowLabel } from './windowDock'
import Menu from './Menu'
import UnitsSync from './UnitsBridge'
import Workspace from './Workspace'
import useDockDrag from './useDockDrag'
import SectionPanel from './panels/SectionPanel'
import CalcPanel from './panels/CalcPanel'
import LoadsPanel from './panels/LoadsPanel'
import ForcePanel from './panels/ForcePanel'
import ElevationPanel from './panels/ElevationPanel'
import EditorPanel from './panels/EditorPanel'
import DashboardPanel from './panels/DashboardPanel'
import PlanPanel from './panels/PlanPanel'
import GroupsPanel from './panels/GroupsPanel'
import SconcretePanel from './panels/SconcretePanel'

// A detached WINDOW — a container holding one or more panels.
//
// It renders the SAME panel components the workspace does, laid out by the SAME
// `Workspace` component over the SAME column model, so a detached window has real
// columns and draggable gutters rather than a second, slightly-different arrangement
// that would drift from the dock. The props arrive from the main window over the bus —
// that window still owns all the state and does all the computing, including running the
// engine — and every callback is proxied straight back.
//
// This used to be one panel per window (`?popout=<kind>`, one component, no layout).
// The window is the addressable thing now: it asks what it is holding, and panels move
// in and out of it by drag or menu while it stays open.
//
// THE MAIN WINDOW OWNS THE MODEL, including where panels are. Every move made here —
// dragging a panel to another window, sending one home, rearranging this window's own
// columns — is posted as an intention and applied there; the new arrangement comes back
// as `contents`. That is what stops two windows from disagreeing about who holds what,
// which is the failure mode that makes a docking system feel haunted.
//
// EVERY kind in PANEL_ORDER needs an entry here. A panel can be registered in
// popoutBus (so the workspace offers Detach) and still be missing from this map, in
// which case detaching it opens a window that says "Unknown panel" — which is what
// happened to `sconcrete`. `popoutComponents.test.ts` now pins the two lists together.
export const COMPONENTS = {
  section: SectionPanel, calc: CalcPanel, loads: LoadsPanel, force: ForcePanel,
  elevation: ElevationPanel, editor: EditorPanel, dashboard: DashboardPanel, plan: PlanPanel,
  groups: GroupsPanel, sconcrete: SconcretePanel,
}

export default function Popout({ winId }) {
  const [contents, setContents] = useState(null)   // { kinds, dock, title }
  const [dock, setDock] = useState(null)           // local echo, so gutters feel immediate
  const [propsByKind, setProps] = useState({})
  const [menu, setMenu] = useState(null)
  const chRef = useRef(null)
  const waiting = useRef(new Map())    // request id -> resolve
  const boundsWait = useRef(null)      // resolve for an in-flight bounds request
  const nextId = useRef(0)
  const resolverRef = useRef(null)

  useEffect(() => {
    const ch = openChannel()
    chRef.current = ch
    if (!ch) return undefined
    ch.onmessage = e => {
      const m = e && e.data
      if (!m || (m.win && m.win !== winId)) return
      if (m.t === 'contents') {
        setContents({ kinds: m.kinds || [], dock: m.dock || { cols: [] }, title: m.title, others: m.others || [] })
        setDock(m.dock || { cols: [] })
      } else if (m.t === 'props') {
        setProps(p => ({ ...p, [m.kind]: m.props || {} }))
      } else if (m.t === 'res') {
        const settle = waiting.current.get(m.id)
        if (settle) { waiting.current.delete(m.id); settle(m.items || []) }
      } else if (m.t === 'bounds') {
        const settle = boundsWait.current
        if (settle) { boundsWait.current = null; settle(m.list || []) }
      } else if (m.t === 'close') window.close()   // the main window reclaimed us
    }
    // This window has missed every update so far — ask for the current contents rather
    // than sitting blank until something happens to change them.
    ch.postMessage({ t: 'hello', win: winId })
    // Tell the main window when the OS closes us, so its panels come back to the
    // workspace instead of vanishing with it.
    const bye = () => { try { ch.postMessage({ t: 'closed', win: winId }) } catch { /* going away */ } }
    window.addEventListener('pagehide', bye)
    return () => { window.removeEventListener('pagehide', bye); ch.close() }
  }, [winId])

  const send = useCallback(msg => {
    const ch = chRef.current
    if (ch) { try { ch.postMessage(msg) } catch { /* channel gone */ } }
  }, [])

  // The font is document-level, and this is a different document — so it travels as a
  // prop like everything else and is applied here. Any panel's copy will do; they all
  // carry the workspace's.
  const anyProps = Object.values(propsByKind)[0] || {}
  useEffect(() => {
    if (anyProps.font) document.documentElement.dataset.font = anyProps.font
  }, [anyProps.font])

  // ── cross-window drag ───────────────────────────────────────────────────────
  // Only the main window knows where the other windows are, so a drag starting here has
  // to ask. Resolves EMPTY rather than hanging if the reply never comes: a drag that can
  // only tear off is a lesser gesture, a drag that freezes is a bug.
  const getBounds = useCallback(() => new Promise(resolve => {
    if (boundsWait.current) boundsWait.current([])
    boundsWait.current = resolve
    send({ t: 'bounds?', win: winId })
    setTimeout(() => {
      if (boundsWait.current === resolve) { boundsWait.current = null; resolve([]) }
    }, 1500)
  }), [send, winId])

  const onDragResult = useCallback((kind, res) => {
    if (res.type === 'window') send({ t: 'move', kind, to: res.winId })
    else if (res.type === 'tear') send({ t: 'move', kind, to: 'new' })
    else if (res.type === 'dock') send({ t: 'move', kind, to: winId, target: res.target })
    // 'float' inside a detached window has nothing to float over — the drop is simply
    // dismissed, which is the same as dropping a panel back where it started.
  }, [send, winId])

  const dragCtl = useDockDrag({ resolverRef, onResult: onDragResult, getBounds, selfWinId: winId })

  // ── per-panel bus proxies ───────────────────────────────────────────────────
  // Callbacks run in the MAIN window — it owns the model, the selection and the engine.
  const fnsFor = kind => {
    const fns = {}
    for (const name of (PANELS[kind] || {}).fns || []) {
      fns[name] = (...args) => send({ t: 'call', win: winId, kind, fn: name, args })
    }
    // Ask the main window something and wait for the answer. Resolves EMPTY rather than
    // hanging if the channel is gone or the reply never comes: a right-click that opens
    // nothing is a poor menu, but a right-click that freezes the window is a bug.
    const request = (fn, args) => new Promise(resolve => {
      const ch = chRef.current
      if (!ch) return resolve([])
      const id = ++nextId.current
      waiting.current.set(id, resolve)
      try { ch.postMessage({ t: 'req', win: winId, kind, fn, args, id }) }
      catch { waiting.current.delete(id); return resolve([]) }
      setTimeout(() => {
        if (waiting.current.has(id)) { waiting.current.delete(id); resolve([]) }
      }, 4000)
    })
    // The items arrive as labels only — each one's real `on` is a closure over the main
    // window's state, which will not clone and would mean nothing here anyway. Give each
    // back an `on` that names its index; the closure it stands for runs over there.
    for (const name of (PANELS[kind] || {}).reqs || []) {
      const withOn = (list, prefix) => list.map((it, i) => ({
        ...it,
        ...(it.children ? { children: withOn(it.children, [...prefix, i]) } : {}),
        on: () => send({ t: 'invoke', win: winId, kind, path: [...prefix, i] }),
      }))
      fns[name] = (...args) => request(name, args).then(items => withOn(items, []))
    }
    return fns
  }

  const renderPanel = kind => {
    const Comp = COMPONENTS[kind]
    const props = propsByKind[kind]
    if (!Comp) return <div className="sdash-popout-wait">Unknown panel “{kind}”.</div>
    if (!props) return <div className="sdash-popout-wait">Loading…</div>
    const fns = fnsFor(kind)

    // Awaited because this ASKS the main window and waits. Coordinates are read before
    // the await, so the menu opens where the click was rather than where the pointer
    // drifted to while the round trip was in flight.
    const onMenu = async e => {
      e.preventDefault()
      const x = e.clientX, y = e.clientY
      // The move entries ("Move to Window 2", "Move to workspace") come from the MAIN
      // window like every other item — it is the one that knows which windows exist and
      // what each holds, and it already excludes the one this panel is in. Appending a
      // local copy here would double them up and let the two disagree.
      const items = await fns.menuItemsFor()
      if (items && items.length) setMenu({ x, y, items })
    }

    // The same round trip for a right-click on a BEAM, for any panel that declares the
    // req. The panel hands up the member it was clicked on and where; the items are built
    // over the main window's state, and the one that is chosen runs back there. The menu
    // itself renders in THIS window, which is why the panel cannot own it — a panel is
    // handed props and hands back events, and never learns which window it is in.
    const onBeamMenu = fns.beamMenuFor
      ? async (memberId, frameName, x, y) => {
        const items = await fns.beamMenuFor(memberId, frameName)
        if (items && items.length) setMenu({ x, y, items })
      }
      : undefined

    return (
      <Comp
        {...props} {...fns}
        host="dock"
        canFloat={false}
        onSendHome={() => send({ t: 'move', kind, to: DOCK })}
        onHost={h => { if (h === 'window') send({ t: 'move', kind, to: 'new' }) }}
        onDrag={{
          begin: (x, y, sx, sy) => dragCtl.begin(kind, x, y, sx, sy),
          move: dragCtl.move, end: dragCtl.end,
        }}
        onMenu={onMenu}
        onBeamMenu={onBeamMenu}
      />
    )
  }

  if (!contents) {
    return <div className="sdash-root sdash-popout"><div className="sdash-popout-wait">Loading…</div></div>
  }

  const d = dragCtl.drag
  return (
    <div className="sdash-root sdash-popout" onMouseDown={() => setMenu(null)}>
      <UnitsSync units={anyProps.units} />
      <div className="demo-popout-shell">
        <div className="demo-popout-bar">
          <span className="sdash-brand" style={{ fontSize: 16 }}>S-DASH</span>
          <span className="sdash-pill">{(contents.title || windowLabel(winId)).toUpperCase()}</span>
          <span className="demo-mmeta">{contents.kinds.map(k => (PANELS[k] || {}).title || k).join(' · ')}</span>
          {/* Fold this whole window into another one — the window-level counterpart to a
              panel's "Move to". It lives in the WINDOW's bar, not a panel's menu, because
              it acts on the window: everything here goes, and this window closes. Offered
              only when there is somewhere to go. */}
          <button
            className="demo-winbtn"
            style={{ width: 'auto', padding: '0 8px', fontSize: 11, fontWeight: 600 }}
            title="Move every panel in this window into another window, and close this one"
            onClick={e => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({
                x: r.left, y: r.bottom + 4,
                items: [
                  { label: 'Merge into the workspace', on: () => send({ t: 'merge', from: winId, to: DOCK }) },
                  ...(contents.others || []).map(o => ({
                    label: `Merge into ${o.label}${o.panels.length ? ` (${o.panels.join(', ')})` : ''}`,
                    on: () => send({ t: 'merge', from: winId, to: o.id }),
                  })),
                ],
              })
            }}
          >
            Merge into ▾
          </button>
          <span style={{ flex: 1 }} />
          {/* While a panel is being dragged towards another window, say where it will
              land. Without it the gesture is a leap of faith: the drop indicator lives in
              the OTHER window, which is behind this one at that moment. */}
          {d && d.overWin
            ? <span className="demo-tb-note">→ drop into {windowLabel(d.overWin)}</span>
            : d && d.tear
              ? <span className="demo-tb-note">→ release for a new window</span>
              : <span className="demo-tb-note">detached · the main window still owns this</span>}
        </div>
        <Workspace
          layout={dock || contents.dock}
          onLayout={next => { setDock(next); send({ t: 'wdock', win: winId, dock: next }) }}
          renderPanel={renderPanel}
          drag={d}
          resolverRef={resolverRef}
          empty={<div className="sdash-popout-wait">This window is empty — drag a panel into it.</div>}
        />
      </div>
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
