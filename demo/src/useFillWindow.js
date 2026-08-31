import { useEffect } from 'react'
import { isPopoutWindow } from './popoutBus.js'

// Who decides how big a panel's DRAWING is.
//
// The Template's answer was a hook per host: floating panels carried their own size,
// and a detached one swapped to tracking window.innerWidth/Height. That was needed
// because a panel's content is drawn from `size` — an SVG's width/height, a scroll box
// — so letting CSS stretch the frame is not enough. The frame grows and the drawing
// inside it does not, which is what made detached panels look pinned to a small box in
// the corner of their own window.
//
// This demo has THREE hosts (docked in a grid, floating, detached), and a grid cell
// will not tell you its size either. So rather than a branch per host, measure the one
// thing that is true in all three: the body element's own box. It follows the grid, the
// resize grip and the OS window alike, and it can never feed back into layout — the
// measurement is passed to the drawing, never to the frame.
//
//   outer size — where the floating window is and how big; drag/resize state only
//   inner box  — what the drawing is told; measured, never set

export const detached = isPopoutWindow

/** Report an element's content box, and keep reporting it as it changes. */
export function useMeasure(ref, setBox) {
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(entries => {
      const r = entries[0] && entries[0].contentRect
      if (r && r.width > 0 && r.height > 0) setBox({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, setBox])
}

/**
 * The root element's inline style under each host.
 *  · detached — nothing: the stylesheet (.sdash-popout .sdash-planwin) fills the window
 *  · docked   — nothing: the workspace grid places it
 *  · floating — position and size from the panel's own drag/resize state
 */
export function winStyle(host, pos, size) {
  if (host !== 'float') return undefined
  return { transform: `translate(${pos.x}px, ${pos.y}px)`, width: size.w, height: size.h }
}
