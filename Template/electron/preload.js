// The desktop bridge. Everything the renderer can ask the main process to do, and
// nothing else — the renderer has no Node access and no filesystem.
//
// isDesktop is what the UI branches on: present means panels can own real OS windows,
// absent means it is a browser and they stay as floating panels in the page. That one
// flag is why the same bundle serves both.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
    isDesktop: true,
    // Give a panel its own OS window. Only the panel's NAME crosses the bridge; its
    // props and callbacks travel on the BroadcastChannel the two windows share.
    popout: (kind, title) => ipcRenderer.invoke('popout:open', kind, title),
})
