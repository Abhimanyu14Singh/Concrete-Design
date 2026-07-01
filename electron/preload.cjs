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
});
