import { Fragment, useCallback, useEffect, useRef } from 'react'
import { resizeCols, resizeItems } from './dockLayout'

// The docked workspace: columns of panels, with draggable gutters between them.
//
// It holds no state — the layout is App's — and owns exactly two things:
//
//   · GEOMETRY. It is the only place that knows where the tiles actually are on screen,
//     so it publishes a hit test (x, y) → drop target through `resolverRef`. The drag
//     controller calls that; so does this component, to draw the drop indicator. One
//     function, two callers, so the indicator can never point somewhere the drop will not
//     land — which is the classic way drag-and-drop goes subtly wrong.
//
//   · GUTTER DRAGS. A gutter changes only the two panes it sits between, and converts
//     pixels to a FRACTION of the container, so a split survives a window resize instead
//     of drifting every time the workspace changes width.

const EDGE = 34   // depth of the "make a new column here" zone at either end

export default function Workspace({
  layout, onLayout, renderPanel, drag, resolverRef, maximized, empty,
}) {
  const rootRef = useRef(null)
  const colRefs = useRef([])
  const tileRefs = useRef({})

  // ── hit test ────────────────────────────────────────────────────────────────
  const resolve = useCallback((x, y) => {
    const root = rootRef.current
    if (!root) return null
    const r = root.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null

    const cols = colRefs.current.filter(Boolean)
    if (!cols.length) {
      return { type: 'newcol', ci: 0, rect: { left: r.left, top: r.top, width: r.width, height: r.height } }
    }

    // Either END of the workspace makes a new column — the one drop that cannot be
    // expressed as "into an existing column".
    if (x < r.left + EDGE) {
      return { type: 'newcol', ci: 0, rect: { left: r.left, top: r.top, width: EDGE, height: r.height } }
    }
    if (x > r.right - EDGE) {
      return { type: 'newcol', ci: cols.length, rect: { left: r.right - EDGE, top: r.top, width: EDGE, height: r.height } }
    }

    for (let ci = 0; ci < cols.length; ci++) {
      const cr = cols[ci].getBoundingClientRect()
      if (x < cr.left || x > cr.right) continue

      // Near a vertical edge INSIDE a column: also a new column, so a panel can be put
      // between two existing ones without having to hit a 9px gutter.
      if (x < cr.left + EDGE && ci > 0) {
        return { type: 'newcol', ci, rect: { left: cr.left - 3, top: cr.top, width: 6, height: cr.height } }
      }
      if (x > cr.right - EDGE && ci < cols.length - 1) {
        return { type: 'newcol', ci: ci + 1, rect: { left: cr.right - 3, top: cr.top, width: 6, height: cr.height } }
      }

      const items = layout.cols[ci] ? layout.cols[ci].items : []
      for (let ii = 0; ii < items.length; ii++) {
        const el = tileRefs.current[items[ii].kind]
        if (!el) continue
        const tr = el.getBoundingClientRect()
        if (y > tr.bottom) continue
        // Top half of a tile inserts above it, bottom half below.
        const above = y < tr.top + tr.height / 2
        return above
          ? { type: 'in', ci, ii, rect: { left: tr.left, top: tr.top - 3, width: tr.width, height: 6 } }
          : { type: 'in', ci, ii: ii + 1, rect: { left: tr.left, top: tr.bottom - 3, width: tr.width, height: 6 } }
      }
      return {
        type: 'in', ci, ii: items.length,
        rect: { left: cr.left, top: cr.bottom - 3, width: cr.width, height: 6 },
      }
    }
    return null
  }, [layout])

  // Publish for the drag controller. In an effect rather than during render, so the ref
  // only ever points at a function whose DOM has actually been laid out.
  useEffect(() => {
    if (!resolverRef) return undefined
    resolverRef.current = resolve
    return () => { if (resolverRef.current === resolve) resolverRef.current = null }
  }, [resolve, resolverRef])

  // ── gutter drags ────────────────────────────────────────────────────────────
  // `base` is captured once at pointerdown: applying each delta to the ORIGINAL layout
  // rather than the running one keeps the pane edge under the cursor. Accumulating
  // deltas instead drifts, because every intermediate result is clamped.
  const dragGutter = (e, apply) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY }
    const r = rootRef.current.getBoundingClientRect()
    const base = layout
    const move = ev => apply(base, (ev.clientX - start.x) / r.width, (ev.clientY - start.y) / r.height)
    const up = () => {
      try { el.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  if (maximized) {
    return (
      <div className="demo-workspace" ref={rootRef}>
        <div className="demo-col" style={{ flex: 1 }}>
          <div className="demo-tile" style={{ flex: 1 }}>{renderPanel(maximized)}</div>
        </div>
      </div>
    )
  }

  if (!layout.cols.length) return <div className="demo-workspace" ref={rootRef}>{empty}</div>

  const ind = drag && drag.target && drag.target.rect

  return (
    <div className="demo-workspace" ref={rootRef}>
      {layout.cols.map((col, ci) => (
        <Fragment key={ci}>
          {ci > 0 && (
            <div className="demo-gutter col" title="Drag to resize"
                 onPointerDown={e => dragGutter(e, (base, dx) => onLayout(resizeCols(base, ci, dx)))} />
          )}
          <div className="demo-col" ref={el => { colRefs.current[ci] = el }} style={{ flex: col.w }}>
            {col.items.map((it, ii) => (
              <Fragment key={it.kind}>
                {ii > 0 && (
                  <div className="demo-gutter row" title="Drag to resize"
                       onPointerDown={e => dragGutter(e, (base, _dx, dy) => onLayout(resizeItems(base, ci, ii, dy)))} />
                )}
                <div className="demo-tile" ref={el => { tileRefs.current[it.kind] = el }}
                     style={{ flex: it.h, opacity: drag && drag.kind === it.kind ? 0.35 : 1 }}>
                  {renderPanel(it.kind)}
                </div>
              </Fragment>
            ))}
          </div>
        </Fragment>
      ))}

      {/* Where the drop will land. position:fixed because these are viewport coordinates
          straight out of getBoundingClientRect. */}
      {ind && (
        <div className="demo-dropind"
             style={{ left: ind.left, top: ind.top, width: ind.width, height: ind.height }} />
      )}
    </div>
  )
}
