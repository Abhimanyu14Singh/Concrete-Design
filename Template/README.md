# UI Starter

A dark, dense, panel-based desktop UI. The design system and the popout architecture
lifted out of an engineering app, with the engineering removed and a small demo left in
its place.

The idea worth taking: **a panel is one component that renders either inside the page or
in its own OS window, and never knows which.** In a browser it floats in the page; on the
desktop it becomes a real window you can drag onto another monitor. Same component, same
props, one bundle.

## Run it

```
npm install
npm start          # builds, then opens the Electron shell
```

Or in a browser — panels stay in-page, which is the whole fallback:

```
npm run dev        # esbuild --watch
# then serve the folder and open index.html (any static server; see the note below)
```

Click the two toolbar buttons to open the Chart and Notes panels. On the desktop each
gets its own window; drag one to a second monitor and resize it. Right-click a table row
or a chart bar for the context menu.

## Layout

```
index.html            loads dist/bundle.js
src/
  index.jsx           entry — routes to App or to a single popped-out panel
  App.jsx             the main window: owns ALL state, hands panels props
  ChartPanel.jsx      demo panel WITH a drawing — copy this one for SVG/canvas
  NotesPanel.jsx      demo panel without one — the minimal shape
  primitives.jsx      Toggle, Pill, PillRow, Range, ConfirmDialog
  icons.jsx           the icon set (~70 line icons, sized by prop)
  ui.css              the design system — colours, panels, menus, sliders, dialogs
  starter.css         demo-only shell (toolbar, table). Delete once you have your own.
  Portal.jsx          renders to <body>, so nothing can bury a panel
  popoutBus.js        the panel registry + what may cross between windows
  usePopoutHost.js    main-window half of the bus
  Popout.jsx          popped-out-window half of the bus
  useFillWindow.js    who decides a panel's size: the page, or the OS window
electron/
  main.js             windows, popouts, and a tiny static server (see below)
  preload.js          the desktop bridge — one flag and one call
```

## Adding a panel

1. Write the component. Take `open` and every callback as **props**; never reach for app
   state. Follow `ChartPanel.jsx` — position/size in state, `useFillWindow(setSize)`,
   `winStyle(fill, pos, size, open)` on the root.
2. Register it in `popoutBus.js`:
   ```js
   myPanel: { title: "My Panel", fns: ["onClose", "onEdit"], reqs: ["itemsFor"] },
   ```
   `fns` are fire-and-forget. `reqs` are calls that must **return** something.
3. Add it to `COMPONENTS` in `Popout.jsx`.
4. In `App.jsx`, publish it and render it when told to:
   ```js
   const show = popHost.publish("myPanel", isOpen, { data }, { onClose, onEdit });
   {show && <Portal><MyPanel data={data} open onClose={onClose} onEdit={onEdit} /></Portal>}
   ```

## Four things that will bite you

These are all things that went wrong in the app this came from. They are not obvious and
they all fail quietly.

**Props are structured-cloned, so functions cannot travel.** Sending one throws
`DataCloneError` and the panel receives nothing at all — it shows "Loading…" for ever with
no error. `cloneable()` in `popoutBus.js` strips them defensively, but the fix is to send
plain data and rebuild the callable thing on the other side: send `"metric"`, not a
formatter object. Anything callable belongs in `fns`/`reqs`, not props.

**Anything a panel calls that is not registered arrives `undefined`.** Calling it throws
out of an event handler, which can leave a gesture stuck mid-drag — a crash that looks
like a frozen UI. Guard optional handlers at the call site.

**A call that needs an answer needs `reqs`, not `fns`.** A context menu's items are built
in the main window and each carries a closure over its state; neither can be posted. So
the labels travel, the popout renders them, and the chosen index comes back — the closure
runs where it was made. That round trip is in `usePopoutHost.js` under `"req"`/`"invoke"`.

**A panel's content is drawn from `size`, so `size` must follow the window.** Stretching
the frame with CSS is not enough: the frame grows and the drawing inside it does not.
That is what `useFillWindow` is for.

## Notes

- **Why a static server in `main.js`.** `BroadcastChannel` only reaches same-origin
  windows, and `file://` pages each get an opaque origin — so popouts would connect to
  nothing. Serving over `http://127.0.0.1` buys a real origin. Replace it with your own
  backend when you have one; the renderer only cares that there is a single origin.
- **`--keep-names` is on in the build** and costs a little bundle size. It is there so a
  stack trace from a minified bundle names the function it threw in, which is the
  difference between finding a bug in one reproduction and not finding it at all.
- **`ui.css` is the app's full stylesheet.** It carries classes for panels this starter
  does not include. Harmless, and a useful catalogue — but prune it once your own set of
  panels settles.
