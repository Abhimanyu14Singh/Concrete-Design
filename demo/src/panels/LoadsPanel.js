import PanelFrame from '../PanelFrame.js'
import { dcrTone } from '../design.js'
import { useFmt } from '../format.js'

// Every load row the member has, which is the point of the panel.
//
// A member is not one load case. The ETABS import expands to one row per station per
// combination, and different rows govern different checks — the largest V and the
// largest M are rarely the same row, and with zoned links the worst shear row is not
// even the largest V, because capacity is read at the spacing of the zone the station
// sits in. So the table shows all of them, marks which check each row governs, and lets
// you click one to point the Calc Sheet at it.
//
// Styling is the Template's `.sdash-loads-table`: sticky mono headers, tabular numerals,
// tinted bands for the moment and shear column groups.

const TONE = { ok: '#15803d', warn: '#b45309', fail: '#b91c1c', none: '#9ca3af' }
const cell = d => ({ color: TONE[dcrTone(d)], fontWeight: d > 0.9 ? 700 : 400 })

export default function LoadsPanel({ rows, selectedId, onSelectRow, memberId, ...frame }) {
  // Every demand here is stored imperial and displayed through the unit system, so the
  // header carries the CURRENT unit rather than a baked-in "kip-ft".
  const { fmtVal, label } = useFmt()
  const M = label('moment'), F = label('force'), L = label('spanLength')
  return (
    <PanelFrame {...frame} title="Loads" subtitle={`${memberId} · ${rows.length} rows`}>
      <div className="sdash-loads-body" style={{ height: '100%' }}>
        <div className="sdash-loads-tablewrap">
          <table className="sdash-loads-table">
            <thead>
              <tr>
                <th>#</th><th>Combo</th><th>x<br /><em>{L}</em></th><th>Governs</th>
                <th className="bx">Mu+<br /><em>{M}</em></th><th className="bx">Mu−<br /><em>{M}</em></th>
                <th className="rx">Vu<br /><em>{F}</em></th><th>Tu<br /><em>{M}</em></th>
                <th>Flex</th><th>Shear</th><th>Tors</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={r.id === selectedId ? 'sel' : undefined}
                    onClick={() => onSelectRow && onSelectRow(r.id)}>
                  <td>{i + 1}</td>
                  <td className="cmb" title={r.combo}>{r.combo}</td>
                  <td>{r.x === undefined ? '—' : fmtVal(r.x, 'spanLength')}</td>
                  <td>{r.governs.length
                    ? r.governs.map(g => <span key={g} className="demo-govtag">{g}</span>)
                    : <span style={{ color: '#cbd5e1' }}>·</span>}</td>
                  <td className="bx">{fmtVal(r.Mu_pos, 'moment')}</td>
                  <td className="bx">{fmtVal(r.Mu_neg, 'moment')}</td>
                  <td className="rx">{fmtVal(r.Vu, 'force')}</td>
                  <td>{fmtVal(r.Tu, 'moment')}</td>
                  <td style={cell(r.flex)}>{r.flex.toFixed(2)}</td>
                  <td style={cell(r.shear)}>{r.shear.toFixed(2)}</td>
                  <td style={cell(r.torsion)}>{r.torsion.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sdash-loads-note">
          {rows.length} rows from {new Set(rows.map(r => r.combo)).size} combinations · x is the station
          from the I-node · a check's chip reports the worst row, not this one.
        </div>
      </div>
    </PanelFrame>
  )
}
