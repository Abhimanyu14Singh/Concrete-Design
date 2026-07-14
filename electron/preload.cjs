const { contextBridge, ipcRenderer } = require('electron');

// Keep at most ONE listener per channel to avoid duplicate dialogs on re-register.
function setSingleListener(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, () => cb());
}

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
  onTriggerSave:  (cb)   => setSingleListener('trigger-save', cb),
  onTriggerOpen:  (cb)   => setSingleListener('trigger-open', cb),
  onNewProject:   (cb)   => setSingleListener('new-project',  cb),
  offTriggerSave: ()     => ipcRenderer.removeAllListeners('trigger-save'),
  offTriggerOpen: ()     => ipcRenderer.removeAllListeners('trigger-open'),
  offNewProject:  ()     => ipcRenderer.removeAllListeners('new-project'),
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
