const { contextBridge, ipcRenderer } = require('electron');

// NOTE: callbacks passed across the contextBridge are wrapped in a fresh proxy
// on every call, so ipcRenderer.removeListener(channel, cb) can never match the
// proxy that on() registered — listeners would accumulate and a single Save/Open
// would fire one native dialog per stale listener ("infinite Save-As windows").
// We sidestep that entirely by keeping at most ONE listener per channel: each
// register call clears the channel first, and the off* calls do the same.
function setSingleListener(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, () => cb());
}

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile:       (opts) => ipcRenderer.invoke('save-file', opts),
  etabs:          (method, args) => ipcRenderer.invoke('etabs', { method, args }),
  openFile:       ()     => ipcRenderer.invoke('open-file'),
  onTriggerSave:  (cb)   => setSingleListener('trigger-save', cb),
  onTriggerOpen:  (cb)   => setSingleListener('trigger-open', cb),
  onNewProject:   (cb)   => setSingleListener('new-project',  cb),
  offTriggerSave: ()     => ipcRenderer.removeAllListeners('trigger-save'),
  offTriggerOpen: ()     => ipcRenderer.removeAllListeners('trigger-open'),
  offNewProject:  ()     => ipcRenderer.removeAllListeners('new-project'),
});
