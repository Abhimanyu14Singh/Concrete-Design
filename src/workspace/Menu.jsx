import { useLayoutEffect, useRef, useState } from 'react'

// The right-click menu, shared by the main window and every detached one — same markup,
// same classes, so a detached panel's menu looks and behaves exactly like a docked one.
// The only difference is invisible: over there `it.on` posts an index PATH back and the
// real closure runs in the main window.
//
// It CLAMPS ITSELF TO THE VIEWPORT. The caller passes the point the menu was summoned
// from, which is the right anchor but the wrong position whenever the menu would not fit
// below and to the right of it — a right-click near the bottom-right corner, or the
// Export button, which lives at the far right of the top bar and so opened a menu that
// ran off the edge of the screen. Measuring after mount and flipping is the only honest
// way to do this: the width depends on the longest label, which the caller does not know.
//
// An item may carry `children`, which opens a SUBMENU on click rather than running an
// action. That exists because one list — "change this beam's group" — is unbounded: a
// model with forty groups turned a five-item menu into a forty-five item wall. The
// submenu scrolls; the parent menu stays short and readable.
export default function Menu({ menu, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  // Which item's submenu is open. Click to open, click again to close — not hover,
  // because a hover-opened list you have to travel into is a fiddly target and this
  // one is scrollable.
  const [openIdx, setOpenIdx] = useState(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const M = 8   // keep a little air between the menu and the window edge
    // Flip to the other side of the anchor when it would overflow, and only fall back to
    // "pin to the edge" when flipping is not enough either — so a menu near the corner
    // stays beside the thing that opened it rather than jumping to the middle.
    let left = menu.x
    if (left + width > window.innerWidth - M) left = Math.max(M, menu.x - width)
    if (left + width > window.innerWidth - M) left = Math.max(M, window.innerWidth - width - M)
    let top = menu.y
    if (top + height > window.innerHeight - M) top = Math.max(M, menu.y - height)
    if (top + height > window.innerHeight - M) top = Math.max(M, window.innerHeight - height - M)
    setPos({ left, top })
  }, [menu.x, menu.y, menu.items])

  // Reopening the menu somewhere else must not leave a submenu hanging open.
  useLayoutEffect(() => { setOpenIdx(null) }, [menu.items])

  const activate = (it, i) => {
    if (it.disabled) return
    if (it.children) { setOpenIdx(cur => (cur === i ? null : i)); return }   // stays open
    it.on()
    onClose()
  }

  return (
    <>
      <div className="sdash-menu-backdrop" onMouseDown={onClose}
           onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div ref={ref} className="sdash-menu" style={{ left: pos.left, top: pos.top }}
           onMouseDown={e => e.stopPropagation()}>
        {menu.items.map((it, i) => (
          it.sep
            ? <div key={i} className="sdash-menu-sep" />
            : (
              <div key={i}
                   className={'sdash-menu-item'
                     + (it.disabled ? ' disabled' : '')
                     + (it.children ? ' has-sub' : '')
                     + (it.danger ? ' danger' : '')}
                   title={it.title || undefined}
                   onClick={() => activate(it, i)}>
                <span className="sdash-menu-label">{it.label}</span>
                {it.children ? <span className="sdash-menu-caret">▸</span> : null}
                {it.children && openIdx === i && (
                  <Submenu items={it.children} onPick={c => { c.on(); onClose() }} />
                )}
              </div>
            )
        ))}
      </div>
    </>
  )
}

/** The nested list. Opens to the right of its parent item, flips left when that would
 *  run off the screen, and scrolls once it is taller than the space it has. */
function Submenu({ items, onPick }) {
  const ref = useRef(null)
  const [flip, setFlip] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth - 8) setFlip(true)
  }, [items])

  return (
    <div ref={ref}
         className={'sdash-submenu' + (flip ? ' flip' : '')}
         onClick={e => e.stopPropagation()}>
      {items.map((c, j) => (
        c.sep
          ? <div key={j} className="sdash-menu-sep" />
          : (
            <div key={j}
                 className={'sdash-menu-item' + (c.disabled ? ' disabled' : '')}
                 title={c.title || undefined}
                 onClick={() => { if (!c.disabled) onPick(c) }}>
              {c.label}
            </div>
          )
      ))}
    </div>
  )
}
