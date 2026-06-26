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
  openFile:       ()     => ipcRenderer.invoke('open-file'),
  onTriggerSave:  (cb)   => setSingleListener('trigger-save', cb),
  onTriggerOpen:  (cb)   => setSingleListener('trigger-open', cb),
  onNewProject:   (cb)   => setSingleListener('new-project',  cb),
  offTriggerSave: ()     => ipcRenderer.removeAllListeners('trigger-save'),
  offTriggerOpen: ()     => ipcRenderer.removeAllListeners('trigger-open'),
  offNewProject:  ()     => ipcRenderer.removeAllListeners('new-project'),
});
