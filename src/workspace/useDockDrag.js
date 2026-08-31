import { useCallback, useRef, useState } from 'react'
import { hitTestWindows, DOCK } from './windowDock'

// Dragging a panel by its header.
//
// Four things can happen when you let go, and which one it is depends only on where the
// pointer ended up:
//
//   over THIS window's workspace  → dock there (a slot in a column, or a new column)
//   elsewhere inside this window  → float, at the pointer
//   over ANOTHER window           → dock into that window
//   over nothing at all           → TEAR OFF into a new window of its own
//
// The last two are what make panels movable between screens. They work because the
// header takes a POINTER CAPTURE: without capture the browser stops delivering
// pointermove the moment the cursor leaves the window, so a drag toward the second
// monitor would simply stop reporting and the gesture could never be distinguished from
// one that ended at the edge. With capture, the events keep coming.
//
// TWO COORDINATE SYSTEMS, and the distinction matters. `clientX/clientY` answer "where in
// THIS document" — the only thing the layout resolver can use, and meaningless once the
// pointer is over another window. `screenX/screenY` answer "where on the desktop", which
// is the only frame every window shares and therefore the only way to ask which window is
// under the pointer. Both are read off the same event, so they can never disagree.
//
// The margin matters: someone dropping a panel against the right-hand edge of the
// workspace is aiming at a new column, not at another window. Requiring the pointer to be
// clearly outside keeps those two intentions apart.
const OUT = 12
const outside = (x, y) =>
  x < -OUT || y < -OUT || x > window.innerWidth + OUT || y > window.innerHeight + OUT

/**
 * @param resolverRef ref to a function (x, y) => dock target | null, published by the
 *        workspace. A ref rather than a prop because the workspace's geometry changes on
 *        every render and the drag must always ask the CURRENT one.
 * @param onResult    (kind, result) => void, called once on release.
 * @param getBounds   optional () => Promise<[{id,x,y,w,h}]>. Fetched ONCE per drag, at
 *        `begin`, and hit-tested locally on every move — a round trip per pointermove
 *        would put IPC in the middle of a 60 Hz gesture.
 * @param selfWinId   this window's id ('dock' in the main window), excluded from the hit
 *        test so a drag that never leaves home is an ordinary in-window dock.
 */
export default function useDockDrag({ resolverRef, onResult, getBounds, selfWinId = DOCK }) {
  // {kind, x, y, target, tear, overWin} while a drag is live, else null. Rendered as a
  // ghost and a drop indicator, so it has to be state and not a ref.
  const [drag, setDrag] = useState(null)
  const kindRef = useRef(null)
  const boundsRef = useRef(null)

  const resolve = (x, y, sx, sy) => {
    if (!outside(x, y)) {
      const fn = resolverRef.current
      return { target: fn ? fn(x, y) : null, tear: false, overWin: null }
    }
    // Outside this window. Is it over another one, or over the desktop?
    const overWin = (sx == null || sy == null)
      ? null
      : hitTestWindows(boundsRef.current, sx, sy, selfWinId)
    return { target: null, tear: !overWin, overWin }
  }

  const begin = useCallback((kind, x, y, sx, sy) => {
    kindRef.current = kind
    // Ask where the other windows are. It resolves in a few ms, long before anyone drags
    // across a screen — and until it does, `boundsRef` is null and an out-of-window drag
    // reads as a tear-off, which is exactly the behaviour this had before.
    boundsRef.current = null
    if (getBounds) {
      Promise.resolve(getBounds())
        .then(list => { boundsRef.current = list })
        .catch(() => { boundsRef.current = null })
    }
    const r = resolve(x, y, sx, sy)
    setDrag({ kind, x, y, ...r })
  }, [getBounds])   // eslint-disable-line react-hooks/exhaustive-deps

  const move = useCallback((x, y, sx, sy) => {
    const r = resolve(x, y, sx, sy)
    setDrag(d => (d ? { ...d, x, y, ...r } : d))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const end = useCallback((x, y, sx, sy) => {
    const kind = kindRef.current
    kindRef.current = null
    setDrag(null)
    boundsRef.current = null
    if (!kind) return
    const { target, tear, overWin } = resolve(x, y, sx, sy)
    if (overWin) onResult(kind, { type: 'window', winId: overWin })
    else if (tear) onResult(kind, { type: 'tear' })
    else if (target) onResult(kind, { type: 'dock', target })
    else onResult(kind, { type: 'float', x, y })
  }, [onResult])   // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback(() => { kindRef.current = null; boundsRef.current = null; setDrag(null) }, [])

  return { drag, begin, move, end, cancel }
}
