/**
 * Preload — the only bridge between the sandboxed renderer and the main process.
 *
 * `contextIsolation` is on, so the renderer cannot require Electron or Node. Every
 * capability it has is a function listed here, and each one is a thin `invoke`/`send`
 * over a named channel — no logic, no state, nothing the renderer could subvert into
 * arbitrary filesystem or COM access.
 *
 * Two surfaces are exposed, for the reason explained on `desktop` below. The typed view
 * of `electronAPI` that the app codes against lives in `src/utils/electronBridge.ts`;
 * adding a method here means adding it there too, or the renderer can't see it.
 *
 * Every `on*` subscriber clears its channel before subscribing, and has a matching
 * `off*`. React effects re-run (StrictMode double-invokes them in dev), and a listener
 * left behind fires the callback twice — which for the file channels means two Save
 * dialogs from one Ctrl+S.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Keep at most ONE listener per channel to avoid duplicate dialogs on re-register.
function setSingleListener(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, () => cb());
}

// ── The workspace panel bridge ────────────────────────────────────────────────
// A separate surface from `electronAPI` below, and deliberately so: `src/workspace`
// reads BOTH keys by name (`popoutBus.isDesktop` tests `window.desktop.isDesktop`,
// `usePopoutHost.openWindow` calls `window.desktop.popout`), so the shape is fixed by
// that code rather than ours to tidy into the bigger object.
//
// Without this the workspace found no `window.desktop`, decided it was in a browser,
// and fell back to `window.open('…?popout=<kind>')` — which inside Electron means the
// default window-open behaviour and a brand-new window on the app root. Two panels of
// state and a full second app, in place of the one panel that was asked for.
//
// Everything else — props, callbacks, the context-menu round trip — travels on the
// BroadcastChannel the two renderer windows share, so the main process never sees
// application state and there is nothing here to keep in sync with the app.
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  // `kind` here is a WINDOW id (`w1`, `w2`, …), not a panel kind — a detached window is a
  // container that may hold several panels. The name is kept for the workspace code that
  // already calls it.
  popout: (kind, title) => ipcRenderer.invoke('popout:open', kind, title),
  // Cross-window docking: where every dockable window is on screen (the main window
  // included, as `dock`), so a drag can hit-test the pointer against them; and the two
  // commands that follow a drop.
  popoutBounds: () => ipcRenderer.invoke('popout:bounds'),
  popoutFocus: (id) => ipcRenderer.invoke('popout:focus', id),
  popoutClose: (id) => ipcRenderer.invoke('popout:close', id),
});

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile:       (opts) => ipcRenderer.invoke('save-file', opts),
  etabs:          (method, args) => ipcRenderer.invoke('etabs', { method, args }),
  sconcrete:      (method, args) => ipcRenderer.invoke('sconcrete', { method, args }),
  pickPath:       (opts) => ipcRenderer.invoke('pick-path', opts),
  openPath:       (target) => ipcRenderer.invoke('open-path', { target }),
  pathExists:     (paths) => ipcRenderer.invoke('path-exists', { paths }),
  sconcreteAutodetect: () => ipcRenderer.invoke('sconcrete-autodetect'),
  onSconcreteProgress: (cb) => { ipcRenderer.removeAllListeners('sconcrete-progress'); ipcRenderer.on('sconcrete-progress', (_e, line) => cb(line)); },
  offSconcreteProgress: () => ipcRenderer.removeAllListeners('sconcrete-progress'),
  openFile:       ()     => ipcRenderer.invoke('open-file'),
  // Diagnostics: is Chromium hardware-accelerated? See main.cjs on why the renderer
  // cannot answer this itself.
  gpuStatus:      ()     => ipcRenderer.invoke('gpu-status'),

  // ── Usage log ──────────────────────────────────────────────────────────────
  // Local-only; nothing here reaches the network. `usageEvents` takes a BATCH because
  // the renderer emits an event per interaction and a round trip apiece would add
  // latency to the very interactions being measured (see src/utils/usage.ts).
  usageEvents:      (batch) => ipcRenderer.invoke('usage:events', batch),
  usageState:       ()     => ipcRenderer.invoke('usage:state'),
  usageSetConsent:  (on)   => ipcRenderer.invoke('usage:set-consent', on),
  usageExport:      ()     => ipcRenderer.invoke('usage:export'),
  usageOpenFolder:  ()     => ipcRenderer.invoke('usage:open-folder'),

  onTriggerSave:  (cb)   => setSingleListener('trigger-save', cb),
  onTriggerSaveAs:(cb)   => setSingleListener('trigger-save-as', cb),
  onTriggerOpen:  (cb)   => setSingleListener('trigger-open', cb),
  onNewProject:   (cb)   => setSingleListener('new-project',  cb),
  onImportEtabs:  (cb)   => setSingleListener('import-etabs', cb),
  onResetWorkspace: (cb) => setSingleListener('reset-workspace', cb),
  onTogglePerf:   (cb)   => setSingleListener('toggle-perf', cb),
  offTriggerSave: ()     => ipcRenderer.removeAllListeners('trigger-save'),
  offTriggerSaveAs:()    => ipcRenderer.removeAllListeners('trigger-save-as'),
  offTriggerOpen: ()     => ipcRenderer.removeAllListeners('trigger-open'),
  offNewProject:  ()     => ipcRenderer.removeAllListeners('new-project'),
  offImportEtabs: ()     => ipcRenderer.removeAllListeners('import-etabs'),
  offResetWorkspace: ()  => ipcRenderer.removeAllListeners('reset-workspace'),
  offTogglePerf:  ()     => ipcRenderer.removeAllListeners('toggle-perf'),
  // Native Preferences menu → open the model-appearance dialog. Cleared before
  // subscribing like every other channel here, so a re-mount cannot open it twice.
  onOpenPreferences:  (cb) => { ipcRenderer.removeAllListeners('open-preferences'); ipcRenderer.on('open-preferences', () => cb()); },
  offOpenPreferences: ()   => ipcRenderer.removeAllListeners('open-preferences'),
  // Native Help menu → open the Help tab at a sub-tab (payload: 'guide' | 'start' | 'keys' | 'faq').
  onOpenHelp:     (cb)   => { ipcRenderer.removeAllListeners('open-help'); ipcRenderer.on('open-help', (_e, tab) => cb(tab)); },
  offOpenHelp:    ()     => ipcRenderer.removeAllListeners('open-help'),

  // ── Group Dashboard pop-out window (relayed through the main process) ──────
  openDashboardWindow:   ()   => ipcRenderer.invoke('dashboard:open'),
  closeDashboardWindow:  ()   => ipcRenderer.invoke('dashboard:close'),
  // main window → dashboard window
  sendDashboardState:    (p)  => ipcRenderer.send('dashboard:state', p),
  onDashboardState:      (cb) => { ipcRenderer.removeAllListeners('dashboard:state'); ipcRenderer.on('dashboard:state', (_e, p) => cb(p)); },
  offDashboardState:     ()   => ipcRenderer.removeAllListeners('dashboard:state'),
  // dashboard window → main window
  sendDashboardCommand:  (c)  => ipcRenderer.send('dashboard:command', c),
  onDashboardCommand:    (cb) => { ipcRenderer.removeAllListeners('dashboard:command'); ipcRenderer.on('dashboard:command', (_e, c) => cb(c)); },
  offDashboardCommand:   ()   => ipcRenderer.removeAllListeners('dashboard:command'),
  dashboardReady:        ()   => ipcRenderer.send('dashboard:ready'),
  onDashboardReady:      (cb) => { ipcRenderer.removeAllListeners('dashboard:ready'); ipcRenderer.on('dashboard:ready', () => cb()); },
  offDashboardReady:     ()   => ipcRenderer.removeAllListeners('dashboard:ready'),
  onDashboardPoppedOut:  (cb) => { ipcRenderer.removeAllListeners('dashboard-popped-out'); ipcRenderer.on('dashboard-popped-out', (_e, v) => cb(v)); },
  offDashboardPoppedOut: ()   => ipcRenderer.removeAllListeners('dashboard-popped-out'),
});
