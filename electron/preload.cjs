const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile:       (opts) => ipcRenderer.invoke('save-file', opts),
  etabs:          (method, args) => ipcRenderer.invoke('etabs', { method, args }),
  openFile:       ()     => ipcRenderer.invoke('open-file'),
  onTriggerSave:  (cb)   => ipcRenderer.on('trigger-save', cb),
  onTriggerOpen:  (cb)   => ipcRenderer.on('trigger-open', cb),
  onNewProject:   (cb)   => ipcRenderer.on('new-project',  cb),
  offTriggerSave: (cb)   => ipcRenderer.removeListener('trigger-save', cb),
  offTriggerOpen: (cb)   => ipcRenderer.removeListener('trigger-open', cb),
  offNewProject:  (cb)   => ipcRenderer.removeListener('new-project',  cb),
});
