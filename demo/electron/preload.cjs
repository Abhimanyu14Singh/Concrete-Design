const { contextBridge, ipcRenderer } = require('electron')

// The panel bridge: one flag and one call.
//
// Everything else — props, callbacks, the context-menu round trip — travels on the
// BroadcastChannel the two renderer windows share, so the main process never sees
// application state and there is nothing here to keep in sync with the app.
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  popout: (kind, title) => ipcRenderer.invoke('popout:open', kind, title),
})

// The S-Concrete bridge, under the name the APP's hook looks for (`window.electronAPI`).
// It is a different surface from `desktop` above and deliberately so: that one is this
// shell's own invention, this one is a contract owned by `src/utils/sco/useSconcreteBatch`
// — every key here is read by name over there, so the shape is not ours to tidy.
//
// Only the S-Concrete half is exposed. `etabs` is absent on purpose: the hook derives
// `hasEtabs` from its presence and disables "Push to ETABS" with an explanation, which is
// the honest state — there is no live ETABS model behind this demo to push into. Adding
// the key without the COM bridge would offer a button that fails after the click.
contextBridge.exposeInMainWorld('electronAPI', {
  sconcrete: (method, args) => ipcRenderer.invoke('sconcrete', { method, args }),
  pickPath: (opts) => ipcRenderer.invoke('pick-path', opts),
  openPath: (target) => ipcRenderer.invoke('open-path', { target }),
  pathExists: (paths) => ipcRenderer.invoke('path-exists', { paths }),
  sconcreteAutodetect: () => ipcRenderer.invoke('sconcrete-autodetect'),
  // One listener per channel: the hook re-registers on mount, and a duplicate would
  // double every progress line in the panel.
  onSconcreteProgress: (cb) => {
    ipcRenderer.removeAllListeners('sconcrete-progress')
    ipcRenderer.on('sconcrete-progress', (_e, line) => cb(line))
  },
  offSconcreteProgress: () => ipcRenderer.removeAllListeners('sconcrete-progress'),
})
