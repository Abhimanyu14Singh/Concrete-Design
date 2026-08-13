import { useCallback, useRef, useState } from 'react'

// Dragging a panel by its header.
//
// Three things can happen when you let go, and which one it is depends only on where the
// pointer ended up:
//
//   over the workspace   → dock there (a slot in a column, or a new column)
//   inside the window    → float, at the pointer
//   outside the window   → TEAR OFF into its own window
//
// The last one is the interesting one, and it works because the header takes a POINTER
// CAPTURE. Without capture the browser stops delivering pointermove the moment the cursor
// leaves the window, so a drag toward the second monitor would simply stop reporting and
// the gesture could never be distinguished from one that ended at the edge. With capture,
// clientX/clientY keep going and go out of range — negative, or past innerWidth — which is
// exactly the signal needed. (The capture is taken in PanelFrame, on the header element,
// which stays mounted for the whole gesture.)
//
// The margin matters: someone dropping a panel against the right-hand edge of the
// workspace is aiming at a new column, not at a new window. Requiring the pointer to be
// clearly outside keeps those two intentions apart.
const OUT = 12
const outside = (x, y) =>
  x < -OUT || y < -OUT || x > window.innerWidth + OUT || y > window.innerHeight + OUT

/**
 * @param resolverRef ref to a function (x, y) => dock target | null, published by the
 *        workspace. A ref rather than a prop because the workspace's geometry changes on
 *        every render and the drag must always ask the CURRENT one.
 * @param onResult   (kind, result) => void, called once on release.
 */
export default function useDockDrag({ resolverRef, onResult }) {
  // {kind, x, y, target, tear} while a drag is live, else null. Rendered as a ghost and
  // a drop indicator, so it has to be state and not a ref.
  const [drag, setDrag] = useState(null)
  const kindRef = useRef(null)

  const resolve = (x, y) => {
    if (outside(x, y)) return { target: null, tear: true }
    const fn = resolverRef.current
    return { target: fn ? fn(x, y) : null, tear: false }
  }

  const begin = useCallback((kind, x, y) => {
    kindRef.current = kind
    const { target, tear } = resolve(x, y)
    setDrag({ kind, x, y, target, tear })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const move = useCallback((x, y) => {
    const { target, tear } = resolve(x, y)
    setDrag(d => (d ? { ...d, x, y, target, tear } : d))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const end = useCallback((x, y) => {
    const kind = kindRef.current
    kindRef.current = null
    setDrag(null)
    if (!kind) return
    const { target, tear } = resolve(x, y)
    if (tear) onResult(kind, { type: 'tear' })
    else if (target) onResult(kind, { type: 'dock', target })
    else onResult(kind, { type: 'float', x, y })
  }, [onResult])   // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback(() => { kindRef.current = null; setDrag(null) }, [])

  return { drag, begin, move, end, cancel }
}
