import { useRef, useState } from 'react'
import PanelFrame from '../PanelFrame'
import { dcrTone, fmtDcr } from '../design'
import { useFmt } from '../format'
import { useMeasure } from '../useFillWindow'
import Portal from '../Portal'
import { Icon } from '../../components/common/Icon.tsx'
import { BiaxialChart, PMSpark } from '../../components/Results/InteractionChart.tsx'
import PMDialog from '../../components/Results/PMDialog.tsx'

// The Calc Sheet, drawn with the Template's own `.sdash-calc-*` classes — a dark navy
// header band with the clause reference on the right, mono derivation lines under it.
// The content is the app's generateBreakdown() output, unedited.
//
// It shows the SELECTED row, never the governing one. That distinction is the app's and
// it matters: the chips report the worst row for each check, the sheet shows the row you
// are looking at, and clicking a chip moves the selection to that check's governing row
// so the two agree. Wired that way here, across panels and across windows.
//
// ── the demand band ──────────────────────────────────────────────────────────────
// The band under the header is THIS BEAM'S ACTUAL FORCES for the selected row — the
// same LoadCase object the sheet below was derived from (App passes `row` and
// `breakdownFor(design, row)` together, so they cannot drift apart), and the same
// numbers the Loads table lists. It names the beam, the combination and the station,
// because "which forces is this sheet for" is the first question anyone asks of it and
// a row id alone does not answer it.
//
// Every demand goes through the unit system — fmtVal/label, like the Loads table and
// like the app's own CalcBreakdownModal. It used to print `.toFixed(1)` against a
// baked-in "kip-ft"/"k"/"ft", which was a WRONG LABEL on a real number the moment
// anyone pressed mm·kN: the value stayed imperial while the unit said otherwise. See
// the rule at the top of format.js.
//
// The derivation lines below are imperial throughout, and deliberately: generateBreakdown
// writes its own strings ("d = 21.5 in", "f'c = 4000 psi"), because an ACI derivation is
// an imperial derivation and re-labelling its intermediate steps would misstate the code
// it is quoting. The app's own Calc Sheet does exactly the same.

export default function CalcPanel({
  memberId, code, sections, row, checks, pm, pmNeg, pmRows, biaxial,
  section, rebar, material, onSelectRow, ...frame
}) {
  const { fmtVal, label } = useFmt()
  // Which chart the header icon opened. Local to the panel: it is a way of LOOKING at
  // the row, not a fact about the model, so it must not travel the popout bus — a
  // detached Calc Sheet opening a chart in the main window would be nonsense.
  const [chart, setChart] = useState(null)
  const govFor = checks.filter(c => c.rowId === row.id).map(c => c.label)
  const M = label('moment'), F = label('force'), L = label('spanLength')
  // row.label is "combo @ x=…"; the combo alone is the useful half in a narrow header.
  const combo = row.label.replace(/\s*@.*$/, '')

  return (
    <PanelFrame {...frame} title="Calc Sheet"
      subtitle={`${memberId} · ${combo}${row.x !== undefined ? ` · x = ${fmtVal(row.x, 'spanLength')} ${L}` : ''}`}
      /* The member's P-M surface, live in the header beside the window controls. It is
         the real curve at 46x20, not an icon standing for one — so the panel always
         carries the answer to "how much axial could this section take, and where does
         this row sit on it", and the click is only for reading it properly.
         Present for EVERY beam: the surface belongs to the section and its cage, not to
         the load, so a beam at Pu = 0 has one too and its marker sits on the P = 0 axis. */
      actions={pm ? (
        <button className="demo-winbtn demo-pmbtn"
                title={`P-M interaction for ${memberId} — click to enlarge`}
                aria-label="Show the P-M interaction diagram"
                onPointerDown={e => e.stopPropagation()}
                onClick={() => setChart('pm')}>
          <PMSpark points={pm.points} Pu={row.Pu ?? 0} Mu={row.Mu_pos} />
        </button>
      ) : null}>
      <div className="demo-scroll sdash-calc-body" style={{ display: 'block' }}>
        <div className="sdash-calc-card" style={{ marginBottom: 8 }}>
          <div className="sdash-calc-hdr">
            <span>{memberId} · {combo}{row.x !== undefined ? ` · x = ${fmtVal(row.x, 'spanLength')} ${L}` : ''}</span>
            <span className="ref">{code}</span>
          </div>
          <div className="sdash-calc-dcr" style={{ borderTop: 0 }}>
            <span>
              M<sub>u</sub>+ {fmtVal(row.Mu_pos, 'moment')} · M<sub>u</sub>− {fmtVal(row.Mu_neg, 'moment')} {M}
              &nbsp;·&nbsp; V<sub>u</sub> {fmtVal(row.Vu, 'force')} {F}
              &nbsp;·&nbsp; T<sub>u</sub> {fmtVal(row.Tu, 'moment')} {M}
              {/* Axial. Shown ALWAYS, including at zero — unlike the member panel, which
                  hides it when there is none. This band is the sheet's statement of what
                  the row's forces were, and a quantity that silently disappears leaves
                  "no axial" and "axial not carried through the import" looking identical.
                  The P-M spark in this panel's own title bar is positioned by this
                  number, so the sheet should say what it is. */}
              &nbsp;·&nbsp; <span title="Axial force on the section — positive is compression. This is what places the marker on the P-M interaction diagram in the header.">
                N<sub>u</sub> {fmtVal(row.Pu ?? 0, 'force')} {F}
              </span>
            </span>
            <span className="gov">{govFor.length ? `governs ${govFor.join(', ')}` : 'not governing'}</span>
          </div>
        </div>

        {sections.map((sec, i) => (
          <div key={i} className="sdash-calc-card" style={{ marginBottom: 8 }}>
            <div className="sdash-calc-hdr">
              <span>{sec.title}</span>
              {/* The chart hook. generateBreakdown marks the sections that have a
                  picture worth seeing (P-M, and the biaxial contour); everything else
                  renders exactly as before, so the sheet is unchanged for the 174
                  members that carry neither. */}
              {sec.chart && (pm || biaxial) && (
                <span className="demo-calcchart" role="button" tabIndex={0}
                      title={sec.chart.label} aria-label={sec.chart.label}
                      onClick={() => setChart(sec.chart.kind)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setChart(sec.chart.kind) } }}>
                  <Icon name="pmInteraction" size={13} />
                </span>
              )}
            </div>
            <div className="sdash-calc-lines">
              {sec.steps.map((st, j) => (
                <div key={j} style={{ marginBottom: 7 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ flex: 1, fontFamily: 'var(--sans)', fontWeight: 600, color: '#334155' }}>{st.label}</span>
                    {st.ref ? <span style={{ fontFamily: 'var(--sans)', fontSize: 10, color: '#94a3b8', whiteSpace: 'nowrap' }}>{st.ref}</span> : null}
                  </div>
                  {st.equation ? <div style={{ color: '#475569' }}>{st.equation}</div> : null}
                  {st.substitution ? <div style={{ color: '#64748b' }}>= {st.substitution}</div> : null}
                  {st.result ? <div style={{ fontWeight: 700, color: '#0f172a' }}>= {st.result}</div> : null}
                  {st.note ? <div style={{ fontFamily: 'var(--sans)', fontSize: 10, color: '#94a3b8', lineHeight: 1.4, marginTop: 2 }}>{st.note}</div> : null}
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* The footer is the check summary FOR THIS ROW — the same numbers the chips
            aggregate, so you can see the row's contribution to each envelope. */}
        <div className="sdash-calc-card">
          <div className="sdash-calc-hdr"><span>This row</span><span className="ref">DCR</span></div>
          {checks.map(c => (
            <div key={c.key} className="sdash-calc-dcr">
              <span>{c.label}</span>
              <span style={{ fontWeight: 700, color: TONE[dcrTone(c.rowDcr)] }}>{fmtDcr(c.rowDcr)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Portalled to <body>: the panel can be docked inside a transformed workspace or
          floating, and a fixed overlay inside either would be positioned against the
          wrong containing block. Same rule every popover in this app follows. */}
      {chart && (
        <Portal>
          <div className="demo-chartback" onClick={() => setChart(null)}>
            {/* The N-vs-M window is a WINDOW, wide enough for its three columns; the
                biaxial contour is still a single chart and keeps the narrow box. Same
                overlay, two sizes, rather than one box that is wrong for both. */}
            <div className={`demo-chartbox${chart === 'pm' ? ' wide' : ''}`} onClick={e => e.stopPropagation()}>
              <div className="demo-charthead">
                <b>{chart === 'pm' ? 'N vs M Diagram' : 'P–M–M interaction contour'}</b>
                <span>{memberId} · {combo}</span>
                <span style={{ flex: 1 }} />
                <button className="sdash-loads-chip" onClick={() => setChart(null)}>✕</button>
              </div>
              {chart === 'pm' && pm && (
                <PMWindow
                  points={pm.points} pointsNeg={pmNeg ? pmNeg.points : undefined}
                  section={section} rebar={rebar} material={material}
                  memberLabel={memberId} loadLabel={combo} code={code}
                  Pu={row.Pu ?? 0} Mu={row.Mu_pos} Mu_neg={row.Mu_neg}
                  phiPnAtRay={pm.phiPnAtRay} phiMnAtRay={pm.phiMnAtRay} util={pm.nmUtil}
                  phiPnAtRayNeg={pmNeg && pmNeg.phiPnAtRay} phiMnAtRayNeg={pmNeg && pmNeg.phiMnAtRay}
                  utilNeg={pmNeg && pmNeg.nmUtil}
                  rows={pmRows} selectedRowId={row.id}
                  /* Clicking a demand dot moves the SELECTION — the same selectRow every
                     other panel calls, so the sheet under this window, the Loads table
                     and the force diagram's marker all follow. Across windows too: the
                     call goes over the popout bus like any other. */
                  onPickRow={onSelectRow}
                />
              )}
              {chart === 'biaxial' && biaxial && (
                <BiaxialChart Mux={biaxial.Mux} Muy={biaxial.Muy}
                              phiMnx={biaxial.phiMnx} phiMny={biaxial.phiMny}
                              alpha={biaxial.alpha} util={biaxial.util} />
              )}
            </div>
          </div>
        </Portal>
      )}
    </PanelFrame>
  )
}

const TONE = { ok: '#15803d', warn: '#b45309', fail: '#b91c1c', none: '#6b7280' }

/**
 * PMDialog sized to the box it is in.
 *
 * The dialog draws an SVG, and an SVG has to be told its width and height — CSS
 * stretching the wrapper leaves the picture at whatever size it was built at. Same rule
 * every panel in this demo follows (see useFillWindow), so the same measurement is used:
 * observe the content box and hand it down.
 *
 * It is its own component rather than a ref inside CalcPanel because the box only exists
 * while the window is open. A hook at the top of CalcPanel would attach its observer on
 * the panel's mount, when there is nothing to observe, and never re-attach.
 */
function PMWindow(props) {
  const ref = useRef(null)
  const [box, setBox] = useState({ w: 980, h: 560 })
  useMeasure(ref, setBox)
  return (
    <div ref={ref} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <PMDialog {...props} width={box.w} height={box.h} />
    </div>
  )
}
