import { useEffect, useRef } from 'react'
import Portal from './Portal.js'
import { IconChevronRight, IconPin, IconPinned } from './icons.js'

// The rail's housing: a 34px strip when shut, a panel when open.
//
// Shut is the default, because the workspace is the thing you are working in and the rail
// is navigation you reach for. The strip is not just a button, though — it keeps the
// counts on it, so "how many beams are over capacity" is answerable without opening
// anything. A collapsed sidebar that goes completely blank makes you open it to find out
// whether you needed to.
//
// Two modes, and the difference is what happens to the workspace:
//
//   unpinned (default)  the rail OVERLAYS the workspace. Opening it moves nothing, so
//                       every docked panel keeps its size and no SVG has to re-fit. That
//                       matters here: the section drawing, the plan and the force diagram
//                       are all sized from a measured box, so a push-open would re-render
//                       three drawings every time you glanced at the group tree.
//   pinned              the rail PUSHES, the way it used to. For anyone who wants it
//                       permanently open and is happy to give up the width.

export default function RailDock({
  open, pinned, width, fails, onOpen, onClose, onTogglePin, onWidth, children,
}) {
  const dragging = useRef(false)

  // Escape closes it — but only when it is a transient overlay. Pinned, it is furniture,
  // and having Escape dismiss furniture is a surprise.
  useEffect(() => {
    if (!open || pinned) return undefined
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, pinned, onClose])

  const startResize = e => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    dragging.current = true
    const startX = e.clientX, startW = width
    const move = ev => onWidth(Math.min(460, Math.max(190, startW + (ev.clientX - startX))))
    const up = () => {
      dragging.current = false
      try { el.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const body = (
    <div className="demo-railbody" style={{ width }}>
      <div className="demo-railhead">
        <button className="demo-winbtn" title={pinned ? 'Unpin — let it overlay and close on Escape' : 'Pin open — the workspace makes room for it'}
                onClick={onTogglePin}>
          {pinned ? <IconPinned size={14} /> : <IconPin size={14} />}
        </button>
        <span style={{ flex: 1 }} />
        <button className="demo-winbtn" title="Collapse" onClick={onClose}>
          <IconChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
        </button>
      </div>
      <div className="demo-railcontent">{children}</div>
      {/* Drag the edge to widen it — long group names and 33-row beam marks want more
          than 258px on a big screen, and less on a laptop. */}
      <div className="demo-railgrip" onPointerDown={startResize} title="Drag to resize" />
    </div>
  )

  if (pinned) return <div className="demo-raildock pinned">{body}</div>

  return (
    <>
      <button className="demo-railstrip" onClick={onOpen}
              title="Groups & members — click to open (Esc closes)">
        <IconChevronRight size={13} />
        <span className="demo-railstrip-label">Groups &amp; members</span>
        {fails > 0 && <span className="demo-railstrip-badge">{fails}</span>}
      </button>
      {open && (
        <Portal>
          {/* Transparent, but it has to exist: clicking anywhere else should shut a
              transient drawer, and without a backdrop that click lands on a panel and
              does something else as well. */}
          <div className="demo-railbackdrop" onMouseDown={onClose} />
          <div className="demo-raildock floating">{body}</div>
        </Portal>
      )}
    </>
  )
}
