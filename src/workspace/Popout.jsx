import { useEffect, useRef, useState } from 'react'
import { openChannel, PANELS } from './popoutBus'
import Menu from './Menu'
import UnitsSync from './UnitsBridge'
import SectionPanel from './panels/SectionPanel'
import CalcPanel from './panels/CalcPanel'
import LoadsPanel from './panels/LoadsPanel'
import ForcePanel from './panels/ForcePanel'
import ElevationPanel from './panels/ElevationPanel'
import EditorPanel from './panels/EditorPanel'
import DashboardPanel from './panels/DashboardPanel'
import PlanPanel from './panels/PlanPanel'
import GroupsPanel from './panels/GroupsPanel'

// One panel, in its own window.
//
// It renders the SAME component the docked panel does, so the two can never drift. The
// props arrive from the main window over the bus — that window still owns all the state
// and does all the computing, including running the engine — and every callback is
// proxied straight back, so a rebar edit made here is applied by the same handler as an
// edit made there. Nothing is duplicated and nothing goes through the Electron main
// process; in a browser there is no main process to go through.
const COMPONENTS = {
  section: SectionPanel, calc: CalcPanel, loads: LoadsPanel, force: ForcePanel,
  elevation: ElevationPanel, editor: EditorPanel, dashboard: DashboardPanel, plan: PlanPanel,
  groups: GroupsPanel,
}

export default function Popout({ kind }) {
  const [props, setProps] = useState(null)
  const [menu, setMenu] = useState(null)
  const chRef = useRef(null)
  const waiting = useRef(new Map())    // request id -> resolve
  const nextId = useRef(0)

  useEffect(() => {
    const ch = openChannel()
    chRef.current = ch
    if (!ch) return undefined
    ch.onmessage = e => {
      const m = e && e.data
      if (!m || m.kind !== kind) return
      if (m.t === 'props') setProps(m.props || {})
      else if (m.t === 'res') {
        const settle = waiting.current.get(m.id)
        if (settle) { waiting.current.delete(m.id); settle(m.items || []) }
      } else if (m.t === 'close') window.close()   // the main window re-docked us
    }
    // This window has missed every update so far — ask for the current props rather
    // than sitting blank until something happens to change them.
    ch.postMessage({ t: 'hello', kind })
    // Tell the main window when the OS closes us, so the panel comes back to the
    // workspace instead of vanishing.
    const bye = () => { try { ch.postMessage({ t: 'closed', kind }) } catch { /* going away */ } }
    window.addEventListener('pagehide', bye)
    return () => { window.removeEventListener('pagehide', bye); ch.close() }
  }, [kind])

  // The font is document-level, and this is a different document — so it travels as a
  // prop like everything else and is applied here.
  useEffect(() => {
    if (props && props.font) document.documentElement.dataset.font = props.font
  }, [props])

  const Comp = COMPONENTS[kind]
  if (!Comp) return <div className="sdash-root sdash-popout"><div className="sdash-popout-wait">Unknown panel “{kind}”.</div></div>
  if (!props) return <div className="sdash-root sdash-popout"><div className="sdash-popout-wait">Loading…</div></div>

  // Callbacks run in the MAIN window — it owns the model, the selection and the engine.
  const fns = {}
  for (const name of (PANELS[kind] || {}).fns || []) {
    fns[name] = (...args) => {
      const ch = chRef.current
      if (ch) { try { ch.postMessage({ t: 'call', kind, fn: name, args }) } catch { /* channel gone */ } }
    }
  }

  // Ask the main window something and wait for the answer. Resolves EMPTY rather than
  // hanging if the channel is gone or the reply never comes: a right-click that opens
  // nothing is a poor menu, but a right-click that freezes the window is a bug.
  const request = (fn, args) => new Promise(resolve => {
    const ch = chRef.current
    if (!ch) return resolve([])
    const id = ++nextId.current
    waiting.current.set(id, resolve)
    try { ch.postMessage({ t: 'req', kind, fn, args, id }) }
    catch { waiting.current.delete(id); return resolve([]) }
    setTimeout(() => {
      if (waiting.current.has(id)) { waiting.current.delete(id); resolve([]) }
    }, 4000)
  })

  // The items arrive as labels only — each one's real `on` is a closure over the main
  // window's state, which will not clone and would mean nothing here anyway. Give each
  // back an `on` that names its index; the closure it stands for runs over there.
  for (const name of (PANELS[kind] || {}).reqs || []) {
    fns[name] = (...args) => request(name, args).then(items =>
      items.map((it, i) => ({
        ...it,
        on: () => {
          const ch = chRef.current
          if (ch) { try { ch.postMessage({ t: 'invoke', kind, index: i }) } catch { /* channel gone */ } }
        },
      })))
  }

  // Awaited because this ASKS the main window and waits. Coordinates are read before
  // the await, so the menu opens where the click was rather than where the pointer
  // drifted to while the round trip was in flight.
  const onMenu = async e => {
    e.preventDefault()
    const x = e.clientX, y = e.clientY
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
    <div className="sdash-root sdash-popout" onMouseDown={() => setMenu(null)}>
      <UnitsSync units={props.units} />
      <div className="demo-popout-shell">
        <div className="demo-popout-bar">
          <span className="sdash-brand" style={{ fontSize: 16 }}>S-DASH</span>
          <span className="sdash-pill">{PANELS[kind].title.toUpperCase()}</span>
          <span className="demo-mmeta">{props.memberId}</span>
          <span style={{ flex: 1 }} />
          <span className="demo-tb-note">detached · the main window still owns this</span>
        </div>
        <Comp {...props} {...fns} host="window" onMenu={onMenu} onBeamMenu={onBeamMenu} />
      </div>
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
