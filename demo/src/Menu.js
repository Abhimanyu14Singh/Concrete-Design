// The right-click menu, shared by the main window and every detached one — same markup,
// same classes, so a detached panel's menu looks and behaves exactly like a docked one.
// The only difference is invisible: over there `it.on` posts an index back and the real
// closure runs in the main window.
export default function Menu({ menu, onClose }) {
  return (
    <>
      <div className="sdash-menu-backdrop" onMouseDown={onClose}
           onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div className="sdash-menu" style={{ left: menu.x, top: menu.y }}
           onMouseDown={e => e.stopPropagation()}>
        {menu.items.map((it, i) => (
          it.sep
            ? <div key={i} className="sdash-menu-sep" />
            : (
              <div key={i} className={'sdash-menu-item' + (it.disabled ? ' disabled' : '')}
                   onClick={() => { if (!it.disabled) { it.on(); onClose() } }}>
                {it.label}
              </div>
            )
        ))}
      </div>
    </>
  )
}
