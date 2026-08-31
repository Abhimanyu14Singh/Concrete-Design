import { useState } from 'react'
import { DEFAULT_ELEMENT_STYLES } from '../components/ModelMap/elementStyle.ts'

// Preferences — how the model is DRAWN, as opposed to what it is made of.
//
// It sits between View and Help for that reason. Project settings (the gear) change the
// MODEL — materials, cover, code — and re-run every calculation. Nothing here touches a
// number: it is the pen the plan is drawn with, and it is per-machine, not per-project,
// so it is saved with the workspace layout rather than into the .scdb.
//
// The four kinds are the four things the map draws. Beams and columns are strokes, so
// they get colour and opacity; floors and walls are polygons and also get a fill, because
// the drafting convention the map follows (hatch = cut material) is exactly the thing an
// office may have its own standard for.

const KINDS = [
  ['beam', 'Beams', 'The framing — the plan\u2019s subject. Used whenever the colour scheme is None.'],
  ['column', 'Columns', 'Context only, drawn in the 3D view. Never designed here.'],
  ['floor', 'Floors / slabs', 'The ground the plan sits on \u2014 a wash you read across.'],
  ['wall', 'Walls', 'Cut material, so hatched by drafting convention.'],
]

const FILLS = [
  ['solid', 'Solid'],
  ['hatch', 'Hatch'],
  ['outline', 'Outline only'],
]

function Row({ kind, label, hint, style, onChange }) {
  const showFill = style.fill !== undefined
  return (
    <div className="demo-prefrow">
      <div className="demo-prefname">
        <b>{label}</b>
        <span>{hint}</span>
      </div>
      <div className="demo-prefctl">
        <label title="Colour">
          <input type="color" value={style.color}
                 onChange={e => onChange(kind, { color: e.target.value })} />
        </label>
        <label title="Opacity" className="demo-prefop">
          <input type="range" min="0" max="100" step="5"
                 value={Math.round(style.opacity * 100)}
                 onChange={e => onChange(kind, { opacity: Number(e.target.value) / 100 })} />
          <span>{Math.round(style.opacity * 100)}%</span>
        </label>
        {showFill ? (
          <select value={style.fill} title="Shade fill"
                  onChange={e => onChange(kind, { fill: e.target.value })}>
            {FILLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ) : (
          // Kept as a placeholder so the four rows stay aligned; a stroke has no fill,
          // and an enabled control that did nothing would be worse than an absent one.
          <span className="demo-preffill-na" title="Beams and columns are lines — there is nothing to fill">—</span>
        )}
      </div>
    </div>
  )
}

export default function PreferencesDialog({ styles, onChange, onClose }) {
  const [local, setLocal] = useState(styles)

  // Applied LIVE, not on a Save button: this is appearance, the plan is visible behind
  // the dialog, and the only way to judge a colour is against the drawing it is for.
  const set = (kind, patch) => {
    const next = { ...local, [kind]: { ...local[kind], ...patch } }
    setLocal(next)
    onChange(next)
  }
  const reset = () => { setLocal(DEFAULT_ELEMENT_STYLES); onChange(DEFAULT_ELEMENT_STYLES) }

  return (
    <div className="demo-prefback" onMouseDown={onClose}>
      <div className="demo-prefdlg" onMouseDown={e => e.stopPropagation()}>
        <div className="demo-prefhead">
          <b>Preferences</b>
          <span>How the model is drawn. Saved on this machine, not in the project.</span>
          <button className="demo-winbtn x" onClick={onClose} title="Close">✕</button>
        </div>
        {KINDS.map(([kind, label, hint]) => (
          <Row key={kind} kind={kind} label={label} hint={hint}
               style={local[kind]} onChange={set} />
        ))}
        <div className="demo-preffoot">
          <button className="demo-prefreset" onClick={reset}>Restore defaults</button>
          <span style={{ flex: 1 }} />
          <button className="demo-prefdone" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
