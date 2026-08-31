import { useRef, useState } from 'react'
import Menu from './Menu'

// File · View · Help — the app's application menu, in the page.
//
// The product's lives in `electron/main.cjs` as a native `Menu.buildFromTemplate`, which
// is right for a desktop app and invisible in a browser. The demo is served over
// http://127.0.0.1 and that is where it is read, so the same three menus are rendered
// here instead — same labels, same order, same accelerators, so muscle memory carries.
//
// It reuses the demo's own `Menu` component, the one the right-click menus use. That is
// not thrift: it means a menu item is one shape everywhere (label · disabled · sep · on),
// which is the same shape that survives the popout bus, and it means the menus already
// share the shell's styling and dismissal behaviour rather than growing a second set.
//
// Items that cannot mean anything here are DISABLED with a reason on hover, never hidden.
// A menu that quietly drops "Save Project" teaches that the app has no such thing; one
// that greys it out and says "the demo's model is data.js" tells the truth about both.

const ACCEL = { new: 'Ctrl+N', open: 'Ctrl+O', save: 'Ctrl+S', saveAs: 'Ctrl+Shift+S', help: 'F1', perf: 'Ctrl+Alt+P' }

export default function MenuBar({ onNewProject, onOpenProject, onSaveProject, onSaveProjectAs, onImportEtabs, onOpenHelp, onReset, onPreferences, onTogglePerf }) {
  const [open, setOpen] = useState(null)          // {label, x, y, items}
  const barRef = useRef(null)

  // Anchored under the button that opened it, not at the cursor: a menu BAR drops from
  // its own label. Measured at click time because the bar moves with the window.
  const openAt = (label, el, items) => {
    const r = el.getBoundingClientRect()
    setOpen({ label, x: r.left, y: r.bottom + 2, items })
  }

  const MENUS = {
    // These are the product's real flows now — App owns them because they touch disk and
    // ETABS; the bar only offers them. An item with no handler is DISABLED rather than
    // hidden, so a build wired without one says so instead of quietly lacking it.
    File: () => [
      { label: `New Project        ${ACCEL.new}`, on: onNewProject, disabled: !onNewProject },
      { label: `Open Project…      ${ACCEL.open}`, on: onOpenProject, disabled: !onOpenProject },
      { label: `Save Project       ${ACCEL.save}`, on: onSaveProject, disabled: !onSaveProject },
      { label: `Save Project As…   ${ACCEL.saveAs}`, on: onSaveProjectAs, disabled: !onSaveProjectAs },
      { sep: true },
      { label: 'Import from ETABS…', on: onImportEtabs, disabled: !onImportEtabs },
      { sep: true },
      { label: 'Reset the workspace', on: onReset },
    ],
    View: () => [
      { label: `Performance meter      ${ACCEL.perf}`, on: onTogglePerf, disabled: !onTogglePerf },
      { sep: true },
      { label: 'Reload', on: () => window.location.reload() },
      { sep: true },
      {
        label: 'Toggle Full Screen',
        on: () => {
          const d = document
          if (d.fullscreenElement) d.exitFullscreen?.()
          else d.documentElement.requestFullscreen?.()
        },
      },
    ],
    // Between View and Help, because it belongs with them: View changes what is on
    // screen NOW, Preferences changes how it is drawn from now on. Neither touches the
    // model — that is the gear, and it is deliberately not in this bar.
    Preferences: () => [
      { label: 'Model appearance…', on: onPreferences, disabled: !onPreferences },
    ],
    Help: () => [
      { label: `Doc Resources        ${ACCEL.help}`, on: () => onOpenHelp('guide') },
      { label: 'Your First Model', on: () => onOpenHelp('start') },
      { label: 'Keyboard Shortcuts', on: () => onOpenHelp('keys') },
      { label: 'FAQ & Troubleshooting', on: () => onOpenHelp('faq') },
      { sep: true },
      { label: 'About S-Dashboard', on: () => onOpenHelp('about') },
    ],
  }

  return (
    <div className="demo-menubar" ref={barRef}>
      {Object.keys(MENUS).map(label => (
        <button
          key={label}
          className={'demo-menubtn' + (open && open.label === label ? ' on' : '')}
          // Pointer-down, not click: a menu bar opens on press, and the shell's own
          // mousedown-to-dismiss would otherwise close this in the same gesture.
          onPointerDown={e => {
            e.stopPropagation()
            if (open && open.label === label) { setOpen(null); return }
            openAt(label, e.currentTarget, MENUS[label]())
          }}
          // Hovering across the bar with one open switches menus, the way every menu bar
          // behaves. Without it you have to close and re-open to read the next one.
          onPointerEnter={e => { if (open && open.label !== label) openAt(label, e.currentTarget, MENUS[label]()) }}
        >
          {label}
        </button>
      ))}
      {open && <Menu menu={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
