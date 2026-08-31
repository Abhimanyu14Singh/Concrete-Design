import PanelFrame from '../PanelFrame.js'
import { useFmt } from '../format.js'

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
            <svg width={w} height={h} style={{ display: 'block', flex: 'none' }}>
              <Chart
                x={0} y={0} w={w} h={ch} span={S.span} marker={mark} spanText={spanText}
                lo={S.Mmin} hi={S.Mmax} label={`M  ${label('moment')}`} color={MOMENT}
                band={S.stations.map(st => [st.x, st.Mlo, st.Mhi])}
                caps={[{ v: S.capPos, t: `${series.capLabels.M}+` },
                       { v: -S.capNeg, t: `${series.capLabels.M}−` }]}
                invert
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
              />
            </svg>
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
            </div>
          </div>
        )
      }}
    </PanelFrame>
  )
}

/** One diagram: a filled demand envelope, dashed capacity, and the selected station. */
function Chart({ x, y, w, h, span, lo, hi, label, color, band, caps = [], steps, mirrorSteps, marker, invert, spanText }) {
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

      <text x={4} y={PAD.t + 9} fontSize="9" fill="#94a3b8" fontFamily="var(--mono)">{label}</text>
      <text x={PAD.l} y={h - 5} fontSize="9" fill="#94a3b8" fontFamily="var(--mono)">0</text>
      <text x={PAD.l + iw} y={h - 5} textAnchor="end" fontSize="9" fill="#94a3b8" fontFamily="var(--mono)">{spanText}</text>
    </g>
  )
}
