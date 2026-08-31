import { useEffect, useMemo, useRef, useState } from 'react'

// The distribution of the model, in the corner of the Model view.
//
// The map answers "where"; this answers "how many". Colouring a floor by DCR tells you
// which beams are in trouble but not whether that is three of them or a third of the
// model — and at model scale those look identical.
//
// IT BINS WHAT THE MAP IS COLOURED BY. There is no axis picker here any more: the
// dropdown above the map chooses both. The chart and the picture are therefore always
// answering the same question, which is what makes reading one against the other mean
// anything. Categorical modes (design group, section, pass/fail) have no numeric axis,
// so the caller passes `series = null` and this renders nothing at all.
//
// The Y axis is always a COUNT OF BEAMS. It used to be selectable (count / weight /
// length); one axis with ticks you can actually read beats three you have to hover to
// identify.
//
// Hand-drawn SVG rather than a chart library. It is ~30 rectangles, two axes and a hover
// readout; the app's charting dependency would bring its own tooltip, which has to be
// positioned inside a container the app puts a `transform: scale` on (see CLAUDE.md) —
// the exact case where a library's absolutely-positioned popover lands somewhere else.
//
// Everything arrives PRE-CONVERTED to display units, label and unit included: this
// component never formats a number with a unit, because it has no access to the unit
// system.

const NUM_BINS = 24

/** Round a step to a 1 / 2 / 5 × 10ⁿ value, so tick labels read as numbers a person
 *  would choose rather than 0.0834. */
function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag
}

/** At most `max` count ticks, on a nice step, never fractional — half a beam is not a
 *  thing, so a peak of 3 gets ticks at 1/2/3 rather than 0.75/1.5/2.25. */
export function countTicks(peak, max = 4) {
  if (!(peak > 0)) return [0]
  const step = Math.max(1, Math.round(niceStep(peak / max)))
  const out = []
  for (let v = 0; v <= peak + 1e-9; v += step) out.push(v)
  if (out[out.length - 1] < peak) out.push(out[out.length - 1] + step)
  return out
}

/**
 * Bin `values` between `lo` and `hi`, counting beams.
 *
 * OUT-OF-RANGE VALUES ARE CLAMPED into the end bins rather than dropped, and the two end
 * bins are flagged so the axis can mark them ≤ / ≥. Dropping them would make the total
 * stop matching the model — you would tighten the limits to look at a cluster and quietly
 * lose the beams you were most worried about. Clamping keeps every beam on the chart; the
 * flag is what stops the end bar from lying about its own width.
 *
 * Non-finite values are dropped: a beam with no result yet is missing data, and piling it
 * into the first bin reads as a cluster of zero-DCR beams that do not exist.
 */
export function buildBins(items, lo, hi, nBins = NUM_BINS) {
  const good = (items || []).filter(it => it && typeof it.v === 'number' && Number.isFinite(it.v))
  if (!good.length) return { bins: [], total: 0, under: 0, over: 0 }
  const span = hi - lo || Math.abs(hi) || 1
  const step = span / nBins
  const bins = Array.from({ length: nBins }, (_, i) => ({
    x0: lo + i * step, x1: lo + (i + 1) * step, n: 0, ids: [],
  }))
  let under = 0, over = 0
  for (const it of good) {
    if (it.v < lo) under += 1
    else if (it.v > hi) over += 1
    const i = Math.min(nBins - 1, Math.max(0, Math.floor((it.v - lo) / step)))
    bins[i].n += 1
    // The ids are what lets the map answer "WHERE are these beams" when the bar is
    // hovered. Carried alongside the count rather than recomputed from the value range:
    // the end bars are clamped, so their members are not the ones a [x0, x1] test finds.
    if (it.id !== undefined) bins[i].ids.push(it.id)
  }
  return { bins, total: good.length, under, over }
}

/** The data range, padded to a nice step so the default limits are round numbers. */
export function defaultLimits(items) {
  const vals = (items || [])
    .map(it => (it && typeof it === 'object' ? it.v : it))
    .filter(v => typeof v === 'number' && Number.isFinite(v))
  if (!vals.length) return { lo: 0, hi: 1 }
  let min = Infinity, max = -Infinity
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v }
  if (max - min < 1e-9) { const p = Math.abs(max) * 0.1 || 0.5; return { lo: min - p, hi: max + p } }
  const step = niceStep((max - min) / 8)
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step }
}

const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—')

/** The colour most of a bin's members are drawn in, or undefined if none of them have
 *  one. Ties break toward whichever was counted first, which is stable across renders
 *  because the bin's id order is. */
function majorityColor(ids, colorOfMember) {
  const tally = new Map()
  for (const id of ids || []) {
    const c = colorOfMember(id)
    if (c) tally.set(c, (tally.get(c) ?? 0) + 1)
  }
  let best, bestN = 0
  for (const [c, n] of tally) if (n > bestN) { best = c; bestN = n }
  return best
}

/**
 * @param series {{ items:{id:string,v:number}[], label:string, unit:string, decimals:number }|null}
 *   null when the active colour mode is categorical — the panel does not render.
 * @param raised true when something else already occupies the bottom-left corner of the
 *   map (the DCR scale legend), so this sits one row above it.
 * @param colorOfMember (id) => the css colour the MAP draws that beam in. Given, a bar
 *   is filled the colour of the beams inside it, so the chart and the model share one
 *   palette and a red cluster in the histogram IS the red beams on the plan. Colouring
 *   from the members rather than from the bar's own value range is what makes the match
 *   exact — a bin spans a range of values, and its centre is nobody's colour. Omitted →
 *   plain bars.
 * @param onHoverMembers called with the member ids under the pointer (empty on leave) —
 *   the panel draws those beams heavy so you can see where the bar's beams actually are.
 */
export default function PlanHistogram({
  series, collapsed, onCollapsed, raised, colorOfMember, onHoverMembers,
}) {
  const [limits, setLimits] = useState(null)     // null = follow the data
  const [draft, setDraft] = useState(null)       // what is in the two inputs
  const [hover, setHover] = useState(null)
  const seriesKey = series ? series.label : ''
  const lastKey = useRef(seriesKey)

  // Changing what is binned invalidates limits chosen for the previous quantity — 0–2
  // makes sense for DCR and nothing at all for steel weight.
  useEffect(() => {
    if (lastKey.current !== seriesKey) {
      lastKey.current = seriesKey; setLimits(null); setHover(null); onHoverMembers?.([])
    }
  }, [seriesKey, onHoverMembers])

  const items = series?.items ?? []
  const auto = useMemo(() => defaultLimits(items), [items])
  const lo = limits?.lo ?? auto.lo
  const hi = limits?.hi ?? auto.hi
  const { bins, total, under, over } = useMemo(() => buildBins(items, lo, hi), [items, lo, hi])

  // One place to move the hover, so the readout and the map's emphasis can never end up
  // pointing at different bars — including on the two container-level leave handlers.
  const enter = i => { setHover(i); onHoverMembers?.(i == null ? [] : (bins[i]?.ids ?? [])) }
  const leave = () => { setHover(null); onHoverMembers?.([]) }

  // Categorical mode, or nothing to draw: the panel is absent rather than empty.
  if (!series || !items.length) return null

  if (collapsed) {
    return (
      <button className={'demo-histbtn' + (raised ? ' raised' : '')}
              onClick={() => onCollapsed?.(false)}
              title="Show the distribution of the model">
        ▴ {series.label}
      </button>
    )
  }

  const d = series.decimals
  const unit = series.unit ? ` ${series.unit}` : ''
  const peak = bins.reduce((m, b) => Math.max(m, b.n), 0) || 1
  const ticks = countTicks(peak)
  const top = ticks[ticks.length - 1]

  const PAD_L = 20, PAD_B = 12, W = 230, H = 76        // PAD_L holds the count ticks
  const plotW = W - PAD_L, plotH = H - PAD_B
  const bw = plotW / bins.length

  const commit = () => {
    const l = parseFloat(draft?.lo), h = parseFloat(draft?.hi)
    if (Number.isFinite(l) && Number.isFinite(h) && h > l) setLimits({ lo: l, hi: h })
    setDraft(null)
  }

  return (
    <div className={'demo-hist' + (raised ? ' raised' : '')} onMouseLeave={leave}>
      <div className="demo-hist-head">
        {/* Names what is binned; it is not a control, because the map's colour-by is. */}
        <span className="demo-hist-title">{series.label}</span>
        <span className="demo-hist-by">· {total} beam{total === 1 ? '' : 's'}</span>
        <span style={{ flex: 1 }} />
        <button className="demo-hist-x" onClick={() => onCollapsed?.(true)} title="Hide">▾</button>
      </div>

      <svg width={W} height={H} className="demo-hist-svg" onMouseLeave={leave}>
        {/* Count axis — gridlines behind the bars, labels outside the plot. */}
        {ticks.map(t => {
          const y = plotH - (t / top) * plotH
          return (
            <g key={t}>
              <line x1={PAD_L} x2={W} y1={y} y2={y} className="demo-hist-grid" />
              <text x={PAD_L - 3} y={y + 3} className="demo-hist-tick" textAnchor="end">{t}</text>
            </g>
          )
        })}
        {bins.map((b, i) => {
          const h = b.n > 0 ? Math.max(1.5, (b.n / top) * plotH) : 0
          const end = (i === 0 && under > 0) || (i === bins.length - 1 && over > 0)
          // The colour of the beams in this bar. By majority, because a bin spans a range
          // and the clamped end bars span an unbounded one — but the bins are narrow, so
          // outside those two ends a bin's members are all but the same colour anyway,
          // and the majority is the honest answer to "what colour are these on the map".
          const fill = colorOfMember ? majorityColor(b.ids, colorOfMember) : undefined
          return (
            <rect key={i}
                  x={PAD_L + i * bw} y={plotH - h} width={Math.max(1, bw - 1)} height={h}
                  className={'demo-hist-bar' + (hover === i ? ' on' : '') + (end ? ' clamped' : '')
                    + (fill ? ' mapped' : '')}
                  style={fill ? { fill } : undefined}
                  onMouseEnter={() => enter(i)} />
          )
        })}
        <line x1={PAD_L} x2={W} y1={plotH} y2={plotH} className="demo-hist-axis" />
        {/* ≤ / ≥ mark the bars that absorbed everything outside the limits. */}
        <text x={PAD_L} y={H - 2} className="demo-hist-tick">
          {under > 0 ? '≤' : ''}{fmt(lo, d)}
        </text>
        <text x={W} y={H - 2} className="demo-hist-tick" textAnchor="end">
          {over > 0 ? '≥' : ''}{fmt(hi, d)}{unit}
        </text>
      </svg>

      <div className="demo-hist-read">
        {hover != null && bins[hover] ? (
          <>
            <b>{fmt(bins[hover].x0, d)}–{fmt(bins[hover].x1, d)}{unit}</b>
            {' · '}{bins[hover].n} beam{bins[hover].n === 1 ? '' : 's'}
          </>
        ) : (under || over) ? (
          <>{under ? `${under} below` : ''}{under && over ? ' · ' : ''}{over ? `${over} above` : ''}
            {' — stacked in the end bar'}</>
        ) : (
          <>{fmt(lo, d)}–{fmt(hi, d)}{unit} · full range</>
        )}
      </div>

      {/* The limits. Typed, committed on blur or Enter, and reset to the data range —
          zooming into 0.8–1.2 on a DCR chart is the whole point of having them. */}
      <div className="demo-hist-lim">
        <span>x</span>
        <input value={draft ? draft.lo : fmt(lo, d)} spellCheck={false}
               onChange={e => setDraft({ lo: e.target.value, hi: draft ? draft.hi : fmt(hi, d) })}
               onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} />
        <span>–</span>
        <input value={draft ? draft.hi : fmt(hi, d)} spellCheck={false}
               onChange={e => setDraft({ lo: draft ? draft.lo : fmt(lo, d), hi: e.target.value })}
               onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} />
        <button className="demo-hist-x" title="Back to the full data range"
                onClick={() => { setLimits(null); setDraft(null) }}>reset</button>
      </div>
    </div>
  )
}
