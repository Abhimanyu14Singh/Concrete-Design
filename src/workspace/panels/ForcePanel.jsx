import { useState } from 'react'
import PanelFrame from '../PanelFrame'
import { useFmt } from '../format'

// Moment, shear and torsion along the span, with capacity over demand.
//
// Three diagrams, because the beam has three ULS checks and each one's chip and DCR
// column has to be answerable by a picture. Torsion was the one without: it governs 43
// of this model's 174 beams, and until it was drawn a torsion-governed beam's DCR was a
// number with nothing behind it.
//
// Two things this panel is here to show. First, the same sizing contract as the section
// drawing — it is an SVG built from an explicit box, so detaching it and resizing the
// window has to make the diagram bigger, not stretch a 320px picture. Second, the zoned
// stirrup case: shear capacity is drawn as a STEP, because with `rebar.tieZones` it is
// whatever the zone the demand sits in provides. A flat capacity line there would be the
// wrong drawing, and it is the drawing most tools show.
//
// Colours are the app's own diagram convention: violet moment, cyan shear, amber
// torsion. Capacity LABELS come from the payload, not from here — EC2 has no φ, so the
// same line reads φMn under ACI and M_Rd under EN 1992-1-1, φTn and T_Rd for torsion.
const MOMENT = '#7c3aed'
const SHEAR = '#0891b2'
const TORSION = '#b45309'
const CAP = '#b91c1c'
// The "torsion may be neglected" threshold. Deliberately NOT the capacity red: it is not
// a strength, it is the line below which the code says there is nothing to design for,
// and drawing the two the same colour would say a beam under it had passed a check that
// was never run.
const THRESH = '#94a3b8'

const PAD = { l: 44, r: 12, t: 12, b: 18 }

/**
 * The envelope at an arbitrary point along the span — what the crosshair reads.
 *
 * INTERPOLATED between the bracketing stations rather than snapped to the nearest one.
 * ETABS gives us a handful of stations (often 5 over a 25 ft span), so snapping would
 * make the number jump in 5 ft steps while the line you are pointing at moves smoothly:
 * the readout would disagree with the picture directly above it. Between two stations
 * the envelope IS drawn as a straight segment, so linear interpolation returns exactly
 * the value the polygon has at that x — the readout and the drawing cannot drift.
 *
 * `x` is in the same units as `stations[].x` (stored-imperial everywhere this is used).
 * Off either end it clamps to the end station; with no stations it returns null.
 */
export function envelopeAt(stations, x) {
  if (!stations || !stations.length) return null
  const KEYS = ['Mlo', 'Mhi', 'Vlo', 'Vhi', 'Tlo', 'Thi']
  const pick = st => { const o = { x: st.x }; for (const k of KEYS) o[k] = st[k] ?? 0; return o }
  if (x <= stations[0].x) return pick(stations[0])
  const last = stations[stations.length - 1]
  if (x >= last.x) return pick(last)
  for (let i = 1; i < stations.length; i++) {
    const b = stations[i]
    if (x > b.x) continue
    const a = stations[i - 1]
    const dx = b.x - a.x
    // Two stations at the same x (duplicate in the import) would divide by zero.
    const t = dx > 1e-9 ? (x - a.x) / dx : 0
    const out = { x }
    for (const k of KEYS) out[k] = (a[k] ?? 0) + t * ((b[k] ?? 0) - (a[k] ?? 0))
    return out
  }
  return pick(last)
}

export default function ForcePanel({ series, marker, memberId, ...frame }) {
  // The payload is stored-imperial, as everything that crosses the bus is. Convert once
  // here rather than inside the drawing, so Chart stays a pure "numbers to pixels" and
  // knows nothing about unit systems.
  const { toDisplay, fmtVal, label } = useFmt()
  const D = (v, q) => toDisplay(v, q)
  const S = {
    span: D(series.span, 'spanLength'),
    stations: series.stations.map(st => ({
      x: D(st.x, 'spanLength'), Mlo: D(st.Mlo, 'moment'), Mhi: D(st.Mhi, 'moment'),
      Vlo: D(st.Vlo, 'force'), Vhi: D(st.Vhi, 'force'),
      // Torsion is a MOMENT (kip-ft / kN·m), so it converts on the moment quantity —
      // not the force one the shear beside it uses.
      Tlo: D(st.Tlo ?? 0, 'moment'), Thi: D(st.Thi ?? 0, 'moment'),
    })),
    Mmin: D(series.Mmin, 'moment'), Mmax: D(series.Mmax, 'moment'),
    Vmin: D(series.Vmin, 'force'), Vmax: D(series.Vmax, 'force'),
    Tmin: D(series.Tmin ?? 0, 'moment'), Tmax: D(series.Tmax ?? 0, 'moment'),
    capPos: D(series.capPos, 'moment'), capNeg: D(series.capNeg, 'moment'),
    capT: D(series.capT ?? 0, 'moment'), capTcr: D(series.capTcr ?? 0, 'moment'),
    vZones: series.vZones.map(z => ({
      x0: D(z.x0, 'spanLength'), x1: D(z.x1, 'spanLength'), v: D(z.v, 'force'),
    })),
    // Torsion capacity steps with the links exactly as shear does — same zones, but a
    // MOMENT, so it converts on the moment quantity rather than the force one.
    tZones: (series.tZones ?? []).map(z => ({
      x0: D(z.x0, 'spanLength'), x1: D(z.x1, 'spanLength'), v: D(z.v, 'moment'),
    })),
  }
  const mark = marker === undefined || marker === null ? marker : D(marker, 'spanLength')
  const spanText = `${fmtVal(series.span, 'spanLength')} ${label('spanLength')}`

  // Where the pointer is along the span, as a FRACTION of it. A fraction rather than a
  // position because the three diagrams share one x scale but not one unit — the drawing
  // wants display feet, the readout wants stored-imperial to hand to fmtVal — and a
  // fraction converts to either without a second source of truth.
  const [hoverF, setHoverF] = useState(null)
  const hoverRaw = hoverF == null ? null : hoverF * series.span
  const at = hoverRaw == null ? null : envelopeAt(series.stations, hoverRaw)

  // "−211.2 … 0.0", or one number when the envelope has no width at this station (a
  // single combo, or a quantity that never reverses). Printing "0.0 … 0.0" for the
  // torsion of a beam that has none is noise, not information.
  const range = (lo, hi, q) => {
    const one = v => fmtVal(v, q, 1)
    return Math.abs(hi - lo) < 5e-2 ? one(hi) : `${one(lo)} … ${one(hi)}`
  }
  return (
    <PanelFrame {...frame}
      title="Force Diagram" subtitle={`${memberId} · envelope of ${series.combos} combos`}>
      {box => {
        const LEG = 30
        // Three diagrams share the height now, so the floor has to be per-DIAGRAM rather
        // than for the panel as a whole: the old flat 160 split three ways left 23px of
        // plot inside 30px of padding. Below this a diagram is padding with a sliver of
        // drawing in it, so the box scrolls instead (see overflow on the column).
        const CHART_MIN = 84
        const N = 3
        const w = Math.max(220, box.w)
        const h = Math.max(N * CHART_MIN, box.h - LEG)
        const ch = h / N
        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
            {/* One listener for all three diagrams, on the <svg> rather than per chart.
                The three share an x scale, so pointing at a station on any one of them is
                pointing at the same station on the other two — which is the whole reason
                to draw the crosshair on all three rather than only the one under the
                cursor. Reading clientX against the element's own rect (not offsetX) is
                what makes that work: offsetX is relative to whichever child polygon the
                pointer happens to be over. */}
            <svg width={w} height={h} style={{ display: 'block', flex: 'none' }}
                 onPointerMove={e => {
                   const r = e.currentTarget.getBoundingClientRect()
                   const iw = Math.max(1, w - PAD.l - PAD.r)
                   const f = (e.clientX - r.left - PAD.l) / iw
                   setHoverF(Math.min(1, Math.max(0, f)))
                 }}
                 onPointerLeave={() => setHoverF(null)}>
              <Chart
                x={0} y={0} w={w} h={ch} span={S.span} marker={mark} spanText={spanText}
                lo={S.Mmin} hi={S.Mmax} label={`M  ${label('moment')}`} color={MOMENT}
                band={S.stations.map(st => [st.x, st.Mlo, st.Mhi])}
                caps={[{ v: S.capPos, t: `${series.capLabels.M}+` },
                       { v: -S.capNeg, t: `${series.capLabels.M}−` }]}
                invert
                hover={hoverF} hoverColor={MOMENT}
                hoverAt={at && { lo: D(at.Mlo, 'moment'), hi: D(at.Mhi, 'moment'),
                                 text: range(at.Mlo, at.Mhi, 'moment') }}
              />
              {/* The real shear diagram: signed, so it runs positive at the I-node,
                  crosses zero and goes negative at the J-node. `mirrorSteps` draws each
                  zone's capacity at BOTH ±φVn — a stirrup cage resists shear either way,
                  so a single line above a diagram that dips below the axis would leave
                  the negative half looking uncontrolled. */}
              <Chart
                x={0} y={ch} w={w} h={ch} span={S.span} marker={mark} spanText={spanText}
                lo={S.Vmin} hi={S.Vmax} label={`V  ${label('force')}`} color={SHEAR}
                band={S.stations.map(st => [st.x, st.Vlo, st.Vhi])}
                steps={S.vZones}
                mirrorSteps
                hover={hoverF} hoverColor={SHEAR}
                hoverAt={at && { lo: D(at.Vlo, 'force'), hi: D(at.Vhi, 'force'),
                                 text: range(at.Vlo, at.Vhi, 'force') }}
              />
              {/* Torsion, drawn like shear because it behaves like shear: signed (a
                  spandrel twists one way at one end and the other way at the other), and
                  resisted equally either way by a closed hoop — so φTn is mirrored at
                  ±, and only the positive line carries the number.

                  The threshold below it is the second line, in grey. A demand that never
                  leaves that band is torsion the code allows you to ignore entirely, and
                  that is a different statement from "the cage carries it" — which is why
                  it is not drawn in the capacity colour. Torsion governs 43 of this
                  model's 174 beams, so this is not a diagram for the odd spandrel. */}
              <Chart
                x={0} y={2 * ch} w={w} h={ch} span={S.span} marker={mark} spanText={spanText}
                lo={S.Tmin} hi={S.Tmax} label={`T  ${label('moment')}`} color={TORSION}
                band={S.stations.map(st => [st.x, st.Tlo, st.Thi])}
                // φTn is a STEP, not a line. It is carried by the links, so on a member
                // with tie zones it changes at the third points just as φVn does — B4
                // gives 122.5 kip-ft at the ends and 40.8 through the middle. Drawn flat
                // (off row[0], which sits at x=0 in the tightest zone) it claimed three
                // times the midspan capacity that exists.
                steps={S.tZones}
                mirrorSteps
                // The neglect threshold stays a flat pair: it is a section property, not
                // a cage one, and it really is constant along the span.
                caps={S.capTcr > 0 ? [
                  { v: S.capTcr, t: series.capLabels.Tcr, muted: true },
                  { v: -S.capTcr, muted: true },
                ] : []}
                hover={hoverF} hoverColor={TORSION}
                hoverAt={at && { lo: D(at.Tlo, 'moment'), hi: D(at.Thi, 'moment'),
                                 text: range(at.Tlo, at.Thi, 'moment') }}
              />
            </svg>
            {/* While the pointer is over a diagram the legend gives way to the numbers.
                It is the same strip rather than an extra row because a strip that appears
                on hover would reflow all three charts under the cursor; and the legend is
                what you stop needing the moment you are reading values off a station. */}
            {at ? (
              <div className="demo-fd-legend read">
                <span className="demo-fd-x">x = {fmtVal(hoverRaw, 'spanLength', 2)} {label('spanLength')}</span>
                <span><i style={{ background: MOMENT }} /> M {range(at.Mlo, at.Mhi, 'moment')} {label('moment')}</span>
                <span><i style={{ background: SHEAR }} /> V {range(at.Vlo, at.Vhi, 'force')} {label('force')}</span>
                <span><i style={{ background: TORSION }} /> T {range(at.Tlo, at.Thi, 'moment')} {label('moment')}</span>
              </div>
            ) : (
            <div className="demo-fd-legend">
              <span><i style={{ background: MOMENT }} /> moment envelope</span>
              <span><i style={{ background: SHEAR }} /> shear envelope</span>
              <span><i style={{ background: TORSION }} /> torsion envelope</span>
              <span><i style={{ background: CAP, height: 0, borderTop: `2px dashed ${CAP}` }} /> capacity</span>
              {S.capTcr > 0
                ? <span title="Below this, the code lets torsion be neglected — no torsion design is done at all">
                    <i style={{ background: THRESH, height: 0, borderTop: `2px dashed ${THRESH}` }} /> {series.capLabels.Tcr} threshold
                  </span>
                : null}
              {S.vZones.length > 1
                ? <span style={{ color: '#b45309' }}>{series.capLabels.V} steps at the tie zones</span>
                : null}
              <span className="demo-fd-hint">hover a diagram for M, V and T at that station</span>
            </div>
            )}
          </div>
        )
      }}
    </PanelFrame>
  )
}

/** One diagram: a filled demand envelope, dashed capacity, the selected station, and the
 *  hover crosshair. */
function Chart({ x, y, w, h, span, lo, hi, label, color, band, caps = [], steps, mirrorSteps, marker, invert, spanText,
                 hover, hoverAt, hoverColor }) {
  const iw = Math.max(1, w - PAD.l - PAD.r)
  const ih = Math.max(1, h - PAD.t - PAD.b)
  // Include the capacities in the scale, or a beam with plenty of headroom draws its
  // capacity line off the top of the box and reads as if it had none. Mirrored steps put
  // −φVn in the scale too, so the axis stays symmetric and the negative half of a shear
  // diagram is never clipped.
  const all = [lo, hi, ...caps.map(c => c.v),
    ...(steps || []).flatMap(s => (mirrorSteps ? [s.v, -s.v] : [s.v]))]
  let vmin = Math.min(...all, 0), vmax = Math.max(...all, 0)
  if (vmax - vmin < 1e-6) { vmin -= 1; vmax += 1 }
  const pad = (vmax - vmin) * 0.08
  vmin -= pad; vmax += pad

  const px = v => PAD.l + (v / (span || 1)) * iw
  // Sagging plots downward on a moment diagram, which is the convention every RC
  // drawing uses — hence `invert` rather than a sign flip in the data.
  const py = v => {
    const t = (v - vmin) / (vmax - vmin)
    return PAD.t + (invert ? t : 1 - t) * ih
  }

  const area = band.map(([bx, b0]) => `${px(bx)},${py(b0)}`).join(' ')
    + ' ' + [...band].reverse().map(([bx, , b1]) => `${px(bx)},${py(b1)}`).join(' ')

  return (
    <g transform={`translate(${x},${y})`}>
      <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill="#fafbfc" stroke="#eef0f2" />
      <line x1={PAD.l} y1={py(0)} x2={PAD.l + iw} y2={py(0)} stroke="#cbd5e1" strokeWidth="1" />

      <polygon points={area} fill={color} fillOpacity="0.16" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />

      {/* A capacity line. `muted` marks a line that is not a strength — today that is
          the torsion threshold — so it reads as a reference rather than a limit. An
          entry with NO `t` is the mirror of the one above it: same number, drawn at −v
          so a signed diagram is bounded both ways, and left unlabelled because printing
          the same figure twice on one chart is noise. Shear's stepped capacity makes
          exactly the same choice a few lines down. */}
      {caps.map((c, i) => {
        const col = c.muted ? THRESH : CAP
        return (
          <g key={i}>
            <line x1={PAD.l} y1={py(c.v)} x2={PAD.l + iw} y2={py(c.v)}
                  stroke={col} strokeWidth={c.muted ? 1 : 1.2} strokeDasharray={c.muted ? '3 3' : '5 3'} />
            {c.t ? (
              <text x={PAD.l + iw - 3} y={py(c.v) + (invert ? 10 : -3)} textAnchor="end"
                    fontSize="9" fill={col} fontFamily="var(--mono)">{c.t} {Math.abs(c.v).toFixed(0)}</text>
            ) : null}
          </g>
        )
      })}

      {/* Shear capacity as a step function — one level per tie zone, drawn at +φVn and
          again at −φVn when the diagram is signed. Only the positive level is labelled:
          the two carry the same number and printing it twice is noise. */}
      {(steps || []).flatMap((s, i) => (mirrorSteps ? [1, -1] : [1]).map(sign => (
        <g key={`${i}:${sign}`}>
          <line x1={px(s.x0)} y1={py(sign * s.v)} x2={px(s.x1)} y2={py(sign * s.v)}
                stroke={CAP} strokeWidth="1.4" strokeDasharray="5 3" />
          {i > 0 ? <line x1={px(s.x0)} y1={py(sign * steps[i - 1].v)} x2={px(s.x0)} y2={py(sign * s.v)}
                         stroke={CAP} strokeWidth="1.1" strokeDasharray="2 2" opacity="0.8" /> : null}
          {sign > 0 ? (
            <text x={(px(s.x0) + px(s.x1)) / 2} y={py(s.v) - 3} textAnchor="middle"
                  fontSize="9" fill={CAP} fontFamily="var(--mono)">{s.v.toFixed(0)}</text>
          ) : null}
        </g>
      )))}

      {marker !== undefined && marker !== null ? (
        <line x1={px(marker)} y1={PAD.t} x2={px(marker)} y2={PAD.t + ih}
              stroke="#2563eb" strokeWidth="1.4" />
      ) : null}

      {/* The crosshair. Dashed and grey so it never competes with the blue marker, which
          means something else entirely — that is the station the Calc Sheet is showing,
          and it must stay findable while you sweep the pointer past it.

          The two dots sit on the envelope edges, which is what makes the number
          trustworthy: you can see the value being read off the polygon rather than
          computed somewhere out of sight. When the envelope has no width they land on
          top of each other, and that is the honest picture of a station with one value. */}
      {hover != null && hoverAt ? (() => {
        const hx = px(hover * span)
        const flip = hx > PAD.l + iw * 0.62      // keep the label inside the plot
        // The chip behind the text. The top strip of the plot already carries the capacity
        // step numbers, and a moving label crossing a fixed one leaves both unreadable —
        // so the one that moves gets an opaque backing. Monospace at a known size, so the
        // width is countable rather than measurable (SVG has no layout pass to ask).
        const tw = hoverAt.text.length * 5.75 + 7
        return (
          <g pointerEvents="none">
            <line x1={hx} y1={PAD.t} x2={hx} y2={PAD.t + ih}
                  stroke="#64748b" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={hx} cy={py(hoverAt.lo)} r="2.6" fill={hoverColor || color} />
            <circle cx={hx} cy={py(hoverAt.hi)} r="2.6" fill={hoverColor || color} />
            <rect x={flip ? hx - 2 - tw : hx + 2} y={PAD.t + 1} width={tw} height={12}
                  rx="2" fill="#ffffff" fillOpacity="0.92" />
            <text x={hx + (flip ? -5 : 5)} y={PAD.t + 10} textAnchor={flip ? 'end' : 'start'}
                  fontSize="9.5" fontWeight="700" fill={hoverColor || color} fontFamily="var(--mono)">
              {hoverAt.text}
            </text>
          </g>
        )
      })() : null}

      <text x={4} y={PAD.t + 9} fontSize="9" fill="#94a3b8" fontFamily="var(--mono)">{label}</text>
      <text x={PAD.l} y={h - 5} fontSize="9" fill="#94a3b8" fontFamily="var(--mono)">0</text>
      <text x={PAD.l + iw} y={h - 5} textAnchor="end" fontSize="9" fill="#94a3b8" fontFamily="var(--mono)">{spanText}</text>
    </g>
  )
}
