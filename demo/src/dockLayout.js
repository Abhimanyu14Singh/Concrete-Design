// The docked workspace's layout, as data.
//
// A COLUMN model, not a free-form tree: the workspace is an ordered list of columns,
// each an ordered list of panels. Columns carry a width fraction, panels inside a column
// carry a height fraction, and both are normalised to sum to 1.
//
//     { cols: [ { w: 0.5, items: [ {kind:'plan', h:0.6}, {kind:'loads', h:0.4} ] },
//               { w: 0.5, items: [ {kind:'section', h:1} ] } ] }
//
// A full binary-split tree would allow arrangements this cannot express (a panel spanning
// two columns at the top, say). It would also need a tree-walking hit test, tree rebalance
// on removal, and a drop model with eight targets per node. Columns cover what anyone
// actually builds — side by side, stacked within a side — with a layout you can read in
// one line of JSON and reason about while dragging. Everything here is a pure function of
// the previous layout, which is what makes drag-and-drop safe: no in-place mutation, so a
// drag that is abandoned mid-gesture leaves nothing behind.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Fractions drift after enough drags and removals. Renormalise so they always sum to 1
 *  and nothing can collapse to zero and become un-grabbable. */
function normalize(layout) {
  const cols = layout.cols.filter(c => c.items.length > 0)
  if (!cols.length) return { cols: [] }
  const wSum = cols.reduce((s, c) => s + (c.w > 0 ? c.w : 0), 0) || cols.length
  return {
    cols: cols.map(c => {
      const hSum = c.items.reduce((s, it) => s + (it.h > 0 ? it.h : 0), 0) || c.items.length
      return {
        w: (c.w > 0 ? c.w : 1) / wSum,
        items: c.items.map(it => ({ kind: it.kind, h: (it.h > 0 ? it.h : 1) / hSum })),
      }
    }),
  }
}

export const panelsOf = layout => layout.cols.flatMap(c => c.items.map(it => it.kind))

export function findPanel(layout, kind) {
  for (let ci = 0; ci < layout.cols.length; ci++) {
    const ii = layout.cols[ci].items.findIndex(it => it.kind === kind)
    if (ii >= 0) return { ci, ii }
  }
  return null
}

/** Drop a panel out of the layout. The column it leaves keeps its width — its remaining
 *  panels share the height it gave up — and an emptied column is removed, its width going
 *  to the others. That is the "everything else adjusts" behaviour; it falls out of
 *  normalising rather than needing a rule of its own. */
export function removePanel(layout, kind) {
  return normalize({
    cols: layout.cols.map(c => ({ ...c, items: c.items.filter(it => it.kind !== kind) })),
  })
}

/**
 * Put a panel at a place.
 *  target = { type: 'in',     ci, ii }  — into column ci, at slot ii
 *         = { type: 'newcol', ci }      — as a new column inserted at ci
 * Removing first makes a move and an insert the same operation, and means dropping a
 * panel back where it came from is a no-op rather than a duplicate.
 */
export function placePanel(layout, kind, target) {
  const without = removePanel(layout, kind)
  if (!target) return without

  if (target.type === 'newcol') {
    const ci = clamp(target.ci, 0, without.cols.length)
    // A new column takes an even share, so a 3-way split reads as thirds and not as
    // "whatever was left over".
    const w = 1 / (without.cols.length + 1)
    const cols = [...without.cols]
    cols.splice(ci, 0, { w, items: [{ kind, h: 1 }] })
    return normalize({ cols })
  }

  const ci = clamp(target.ci, 0, Math.max(0, without.cols.length - 1))
  if (!without.cols[ci]) return normalize({ cols: [...without.cols, { w: 1, items: [{ kind, h: 1 }] }] })
  const col = without.cols[ci]
  const ii = clamp(target.ii, 0, col.items.length)
  // The newcomer takes an even share of the column, pushing the others down
  // proportionally — nothing already there gets squeezed to nothing.
  const items = [...col.items]
  items.splice(ii, 0, { kind, h: 1 / (col.items.length + 1) })
  const cols = [...without.cols]
  cols[ci] = { ...col, items }
  return normalize({ cols })
}

/** Drag the gutter between columns ci-1 and ci. `frac` is the delta as a fraction of the
 *  workspace width. Only the adjacent pair changes — everything else stays put, which is
 *  what makes a gutter feel like a gutter and not a re-layout. */
export function resizeCols(layout, ci, frac) {
  if (ci <= 0 || ci >= layout.cols.length) return layout
  const MIN = 0.12
  const a = layout.cols[ci - 1], b = layout.cols[ci]
  const total = a.w + b.w
  const aw = clamp(a.w + frac, MIN, total - MIN)
  const cols = [...layout.cols]
  cols[ci - 1] = { ...a, w: aw }
  cols[ci] = { ...b, w: total - aw }
  return { cols }
}

/** Drag the gutter between items ii-1 and ii inside column ci. */
export function resizeItems(layout, ci, ii, frac) {
  const col = layout.cols[ci]
  if (!col || ii <= 0 || ii >= col.items.length) return layout
  const MIN = 0.12
  const a = col.items[ii - 1], b = col.items[ii]
  const total = a.h + b.h
  const ah = clamp(a.h + frac, MIN, total - MIN)
  const items = [...col.items]
  items[ii - 1] = { ...a, h: ah }
  items[ii] = { ...b, h: total - ah }
  const cols = [...layout.cols]
  cols[ci] = { ...col, items }
  return { cols }
}

/**
 * Bring the layout back in step with the set of panels that should be docked.
 *
 * Called after every change to `hosts`, because a panel can leave the dock by being
 * closed, floated or detached, and can come back by any of the reverse routes. Panels
 * that left are dropped; panels that arrived are appended to the shortest column, which
 * is a better guess than "always the last one" and needs no user decision.
 */
export function reconcile(layout, docked) {
  const want = new Set(docked)
  let next = { cols: layout.cols.map(c => ({ ...c, items: c.items.filter(it => want.has(it.kind)) })) }
  const have = new Set(panelsOf(next))

  for (const kind of docked) {
    if (have.has(kind)) continue
    if (!next.cols.length) { next = { cols: [{ w: 1, items: [{ kind, h: 1 }] }] }; continue }
    let best = 0
    for (let i = 1; i < next.cols.length; i++) {
      if (next.cols[i].items.length < next.cols[best].items.length) best = i
    }
    const col = next.cols[best]
    next.cols[best] = { ...col, items: [...col.items, { kind, h: 1 / (col.items.length + 1) }] }
  }
  return normalize(next)
}

/** The starting arrangement: two columns, panels dealt alternately. */
export function defaultLayout(docked) {
  if (!docked.length) return { cols: [] }
  const a = [], b = []
  docked.forEach((k, i) => (i % 2 ? b : a).push(k))
  const cols = [a, b].filter(g => g.length).map(g => ({
    w: 1, items: g.map(kind => ({ kind, h: 1 / g.length })),
  }))
  return normalize({ cols })
}

/** Cheap shape check — a layout out of localStorage is untrusted input. */
export function isLayout(v) {
  return !!v && Array.isArray(v.cols) && v.cols.every(c =>
    c && typeof c.w === 'number' && Array.isArray(c.items) &&
    c.items.every(it => it && typeof it.kind === 'string' && typeof it.h === 'number'))
}
