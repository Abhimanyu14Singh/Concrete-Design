import { useRef, useState } from 'react'
import { useMeasure, winStyle } from './useFillWindow'
import { IconAttach, IconClose, IconDetach, IconDock, IconFloat, IconMax, IconMin } from './icons'

// The chrome every panel wears, and the only place that knows there is more than one
// place a panel can live.
//
//   host = 'dock'   tiled in the workspace, sized by the layout
//        = 'float'  a draggable, resizable window inside the page
//        = 'window' its own OS / browser window, this whole document
//
// A panel body never learns which. It is handed a measured {w,h} and a set of callbacks
// and behaves identically in all three — which is the property worth having, because it
// is also what makes the bodies testable and what stops the docked and detached versions
// of a panel from drifting apart.
//
// Float geometry is CONTROLLED — {x, y, w, h} in, onGeom out — rather than owned here.
// Two reasons: the layout has to be persisted, and state a component keeps to itself
// cannot be. It also means a panel that is dragged, docked and floated again comes back
// where it was left, which is what anyone expects of a window.

const DRAG_SLOP = 5   // px before a click on the header becomes a drag

export default function PanelFrame({
  host, title, subtitle, onHost, onClose, onMenu, children, bodyClass = '',
  geom, onGeom, onDrag, maximized, onMaximize, actions, titleAfter,
  // A panel docked INSIDE a detached window is host='dock' like any other, but that
  // window is not the workspace: there is nothing to float over, and "put this back"
  // means the main workspace rather than this container. Both are opt-in so the main
  // workspace keeps exactly the chrome it had.
  canFloat = true, onSendHome,
}) {
  const resize = useRef(null)
  const bodyRef = useRef(null)
  const [box, setBox] = useState({ w: 320, h: 240 })
  useMeasure(bodyRef, setBox)

  const g = geom || { x: 96, y: 104, w: 520, h: 380 }
  const pos = { x: g.x, y: g.y }
  const size = { w: g.w, h: g.h }
  const floating = host === 'float'
  const inPage = host !== 'window'

  // ── header drag ─────────────────────────────────────────────────────────────
  // One gesture, three possible outcomes — dock somewhere else, float, or tear off into
  // its own window — and the drag controller decides which from where the pointer ends.
  //
  // POINTER CAPTURE is what makes tear-off possible at all: without it the browser stops
  // delivering pointermove as soon as the cursor leaves the window, so a drag toward the
  // second monitor would just stop reporting. With it, clientX/clientY keep going and go
  // out of range, which is the signal the controller reads.
  //
  // SCREEN coordinates go along for the ride because client coordinates stop meaning
  // anything the moment the pointer leaves this document — and dropping a panel INTO
  // another window is a question only screen space can answer. They are read off the
  // same event, so the two can never describe different points.
  const onHeadDown = e => {
    if (!inPage || e.button !== 0 || !onDrag) return
    if (e.target.closest('button')) return          // the header's own controls
    const el = e.currentTarget
    const startX = e.clientX, startY = e.clientY
    const from = { x: g.x, y: g.y }
    let started = false
    try { el.setPointerCapture(e.pointerId) } catch { /* no capture, drag still works in-window */ }

    const move = ev => {
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_SLOP) return
      if (!started) { started = true; onDrag.begin(ev.clientX, ev.clientY, ev.screenX, ev.screenY) }
      // A floating panel keeps following the cursor as it always did; the drop logic
      // rides along on top rather than replacing it.
      if (floating && onGeom) {
        onGeom({ ...g, x: Math.max(0, from.x + (ev.clientX - startX)), y: Math.max(0, from.y + (ev.clientY - startY)) })
      }
      onDrag.move(ev.clientX, ev.clientY, ev.screenX, ev.screenY)
    }
    const up = ev => {
      try { el.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('lostpointercapture', up)
      if (started) onDrag.end(ev.clientX, ev.clientY, ev.screenX, ev.screenY)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    // Losing capture (a browser-level interruption) must not leave a drag half-open.
    el.addEventListener('lostpointercapture', up)
  }

  return (
    <div
      className={`sdash-planwin ${host === 'window' ? '' : host === 'float' ? 'floating' : 'docked'}`}
      style={winStyle(host, pos, size)}
      onMouseDown={e => e.stopPropagation()}
    >
      <div
        className={'sdash-planwin-head' + (inPage && onDrag ? ' draggable' : '')}
        onPointerDown={onHeadDown}
        onDoubleClick={() => { if (host === 'dock' && onMaximize) onMaximize() }}
        onContextMenu={onMenu}
        title={inPage && onDrag ? 'Drag to move, or out of the window to detach · double-click to maximise' : undefined}
      >
        <span style={{ flex: 1, fontWeight: 600, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
          {/* A control that SELECTS WHAT THE PANEL IS SHOWING, sitting between the title
              and the subtitle — because that is what it is: part of the name. `actions`
              (further down, hard right) is for things the panel DOES. Centred rather than
              inheriting the row's baseline, which would hang a button off the text. */}
          {titleAfter ? <span style={{ alignSelf: 'center', display: 'inline-flex', flexShrink: 0 }}>{titleAfter}</span> : null}
          {subtitle ? <span className="demo-winhead-sub">{subtitle}</span> : null}
        </span>

        {/* A panel's OWN controls, ahead of the window controls. They sit in the header
            rather than on a strip of their own because a strip costs every panel a row of
            height for something only one panel needs. */}
        {actions}

        {/* In its own window there is exactly one thing to offer: come back. The OS title
            bar's ✕ already does it too — closing posts `closed`, and the main window
            re-docks the panel — so both routes land in the same handler. */}
        {host === 'window' ? (
          <button className="demo-winbtn" title="Attach — put this panel back in the workspace"
                  onPointerDown={e => e.stopPropagation()} onClick={() => window.close()}>
            <IconAttach size={14} />
          </button>
        ) : (
          <>
            {host === 'dock' && onMaximize && (
              <button className="demo-winbtn" title={maximized ? 'Restore' : 'Maximise to the whole workspace'}
                      onPointerDown={e => e.stopPropagation()} onClick={onMaximize}>
                {maximized ? <IconMin size={14} /> : <IconMax size={14} />}
              </button>
            )}
            {/* Inside a detached window: send this panel back to the main workspace. The
                OS ✕ only helps when the panel is the last one there, so a window holding
                three panels needs a per-panel route home. */}
            {onSendHome && (
              <button className="demo-winbtn" title="Move back to the main workspace"
                      onPointerDown={e => e.stopPropagation()} onClick={onSendHome}>
                <IconAttach size={14} />
              </button>
            )}
            {canFloat && (
              <button className="demo-winbtn" title={floating ? 'Dock into the workspace' : 'Float over the workspace'}
                      onPointerDown={e => e.stopPropagation()}
                      onClick={() => onHost(floating ? 'dock' : 'float')}>
                {floating ? <IconDock size={14} /> : <IconFloat size={14} />}
              </button>
            )}
            <button className="demo-winbtn" title="Detach into its own window"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => onHost('window')}>
              <IconDetach size={14} />
            </button>
            <button className="demo-winbtn x" title="Close"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => onClose && onClose()}>
              <IconClose size={13} />
            </button>
          </>
        )}
      </div>

      <div ref={bodyRef} className={`sdash-planwin-body ${bodyClass}`} style={{ padding: 0 }}>
        {typeof children === 'function' ? children(box) : children}
      </div>

      {floating && (
        <div
          className="sdash-planwin-resize"
          onPointerDown={e => {
            if (e.button !== 0) return
            e.stopPropagation()
            const el = e.currentTarget
            try { el.setPointerCapture(e.pointerId) } catch { /* fine */ }
            const start = { x: e.clientX, y: e.clientY, w: size.w, h: size.h }
            const move = ev => onGeom({
              ...g,
              w: Math.max(300, start.w + (ev.clientX - start.x)),
              h: Math.max(200, start.h + (ev.clientY - start.y)),
            })
            const up = () => {
              el.removeEventListener('pointermove', move)
              el.removeEventListener('pointerup', up)
            }
            el.addEventListener('pointermove', move)
            el.addEventListener('pointerup', up)
          }}
        />
      )}
    </div>
  )
}
