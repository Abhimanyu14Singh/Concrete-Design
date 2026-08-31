import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Portal from './Portal'

// The plan's Filter: what is drawn, in one control.
//
// It replaces the storey dropdown, which could only answer "one storey, or all". A model
// has more than storeys in it, and the questions people actually ask of a plan are
// combinations — "L2 and L3 only", "hide the slab so I can see the framing", "grids off
// for a screenshot". A single-select cannot express any of those.
//
// Storeys are CHECKBOXES for the same reason: two adjacent floors compared side by side
// is the common case, and a dropdown makes it impossible.
//
// Portalled and fixed-positioned because the panel body is `overflow: hidden` — an
// absolutely-positioned popover inside the toolbar is clipped the moment it is taller
// than the bar, which is always.

const ELEMENTS = [
  ['columns', 'Columns', 'Vertical frames — drawn in 3D only; in plan a column is a point'],
  ['walls', 'Walls', 'Core / shear walls, hatched'],
  ['floors', 'Floors', 'Slab plates, drawn behind the framing'],
  ['grids', 'Gridlines', 'Grid lines and their bubbles'],
]

export default function PlanFilter({
  stories, hiddenStories, elements, onHiddenStories, onElements,
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setPos({ left: r.left, top: r.bottom + 4 })
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const away = e => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const esc = e => { if (e.key === 'Escape') setOpen(false) }
    // `true` — capture. A click inside the SVG canvas stops propagation on its way up,
    // so a bubble-phase listener never sees it and the popover stays open over the plan.
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const hidden = new Set(hiddenStories)
  const toggleStory = s => {
    const next = new Set(hidden)
    if (next.has(s)) next.delete(s); else next.add(s)
    // Never hide everything: an empty plan reads as a broken panel, not as a filter
    // doing its job. The last visible storey simply will not turn off.
    if (next.size >= stories.length) return
    onHiddenStories([...next])
  }
  const setAll = on => onHiddenStories(on ? [] : stories.slice(1))

  // ELEMENTS only. Storeys are already named in the panel's subtitle, and counting them
  // here would put "Filter · 4 off" on the button the moment the plan opens on one floor
  // — which is the normal state, not a warning.
  const offCount = ELEMENTS.filter(([k]) => !elements[k]).length

  return (
    <>
      <button ref={btnRef}
              className={'sdash-loads-chip' + (offCount ? ' on' : '')}
              onClick={() => setOpen(o => !o)}
              title="What the plan draws — storeys and element types">
        Filter{offCount ? ` · ${offCount} off` : ''}
      </button>

      {open && pos && (
        <Portal>
          <div ref={popRef} className="demo-filterpop" style={{ left: pos.left, top: pos.top }}>
            <div className="demo-filterhead">
              <span>Storeys</span>
              <button className="demo-filterlink" onClick={() => setAll(true)}>all</button>
              <button className="demo-filterlink" onClick={() => setAll(false)}>only top</button>
            </div>
            {stories.map(s => (
              <label key={s} className="demo-filterrow">
                <input type="checkbox" checked={!hidden.has(s)} onChange={() => toggleStory(s)} />
                <span>{s}</span>
              </label>
            ))}

            <div className="demo-filterhead" style={{ marginTop: 6 }}><span>Elements</span></div>
            {ELEMENTS.map(([k, lbl, tip]) => (
              <label key={k} className="demo-filterrow" title={tip}>
                <input type="checkbox" checked={!!elements[k]}
                       onChange={e => onElements({ ...elements, [k]: e.target.checked })} />
                <span>{lbl}</span>
              </label>
            ))}
          </div>
        </Portal>
      )}
    </>
  )
}
