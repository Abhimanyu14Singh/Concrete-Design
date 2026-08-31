const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
// The APP's S-Concrete bridge, not a copy of it. It writes the .SCO files, drives
// BatchReporter through the bundled SConcreteHelper sidecar and reads the .SCRS back —
// all native work, all of it already written and tested one directory up. Requiring it
// is the whole integration: nothing about the batch is re-implemented for the demo, in
// the same way nothing about the design engine is.
const { registerSconcreteBridge } = require('../../electron/sconcreteBridge.cjs')
// The app's ETABS bridge, for the same reason: the read half (tables, forces) and the
// write half (define sections, assign frames, save-as, run) are already written and
// tested one directory up. A push only lights up when the model in front of you came
// FROM ETABS — see `canPushLive` in App.js — so attaching this to a demo model that
// never did is harmless.
const { registerEtabsBridge } = require('../../electron/etabsBridge.cjs')

// The desktop shell. It adds two things over the browser: a detached panel gets a real
// OS window with its own taskbar entry (which can go behind the main window and onto a
// second monitor), and the S-Concrete batch can actually run, because writing files and
// driving another Windows application are things a browser cannot do. Everything else is
// identical, and deliberately so — the demo is only convincing if the browser and the
// desktop are running the same code.
//
// SERVED OVER HTTP, NOT file://. The popout system uses a BroadcastChannel, and that
// only reaches windows of the SAME ORIGIN. Pages loaded from file:// each get an opaque
// origin, so the channel silently connects to nothing and every detached panel sits on
// "Loading…" for ever. Reusing server.mjs buys a real origin and keeps one server in
// the project rather than two that can drift.
let PORT = 0

const windowOpts = () => ({
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.cjs'),
  },
  show: false,
})

let mainWindow = null
const popoutWindows = new Map()   // kind -> BrowserWindow

function createMain() {
  mainWindow = new BrowserWindow({ width: 1440, height: 900, title: 'S-Dash — Beam Designer', ...windowOpts() })
  attachWindowOpenHandler(mainWindow)
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`)
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
}

function openPopout(kind, title) {
  const existing = popoutWindows.get(kind)
  if (existing && !existing.isDestroyed()) { existing.focus(); return }
  // Deliberately NOT `parent`: a child window is trapped above its parent and cannot be
  // sent behind it or dragged onto another display independently, which is the entire
  // reason to detach a panel in the first place.
  const win = new BrowserWindow({ width: 900, height: 660, title: title || 'Panel', ...windowOpts() })
  attachWindowOpenHandler(win)
  win.loadURL(`http://127.0.0.1:${PORT}/?popout=${encodeURIComponent(kind)}`)
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    console.error(`popout ${kind} failed to load: ${desc} (${code})`))
  win.on('closed', () => popoutWindows.delete(kind))
  popoutWindows.set(kind, win)
}

ipcMain.handle('popout:open', (_evt, kind, title) => {
  if (!kind) return { ok: false }
  try { openPopout(String(kind), title) }
  catch (e) { console.error(`popout ${kind} failed: ${e.message}`); return { ok: false } }
  return { ok: true }
})

// Belt and braces for the renderer's browser path. Without window.desktop the page calls
// window.open('?popout=…'), which Electron DENIES by default — silently, which is exactly
// what a broken popout looks like. Route it through the same code instead.
function attachWindowOpenHandler(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const kind = new URL(url, `http://127.0.0.1:${PORT}`).searchParams.get('popout')
      if (kind) { openPopout(kind, null); return { action: 'deny' } }
    } catch { /* not a popout URL */ }
    return { action: 'deny' }
  })
}

// ── S-Concrete ────────────────────────────────────────────────────────────────────
// The batch itself comes from the app's bridge; these four are the file-system bits it
// leans on, ported from `electron/main.cjs` rather than imported, because that file is
// the whole product shell (menus, ETABS, project save/open) and booting it here to reach
// four handlers would be the tail wagging the dog. They are small and they are the app's:
// same channel names, same return shapes, because `useSconcreteBatch` reads both by name.
ipcMain.handle('pick-path', async (event, { mode, filters } = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: [mode === 'folder' ? 'openDirectory' : 'openFile'],
      ...(filters ? { filters } : {}),
    })
    if (canceled || !filePaths.length) return null
    return { path: filePaths[0], exists: fs.existsSync(filePaths[0]) }
  } catch (e) {
    return { error: e.message || String(e) }
  }
})

ipcMain.handle('open-path', async (_event, { target } = {}) => {
  try {
    if (!target) return { success: false, error: 'No path given' }
    if (!fs.existsSync(target)) return { success: false, error: `Path does not exist: ${target}` }
    const err = await shell.openPath(target)
    return err ? { success: false, error: err } : { success: true }
  } catch (e) {
    return { success: false, error: e.message || String(e) }
  }
})

ipcMain.handle('path-exists', async (_event, { paths } = {}) => {
  const out = {}
  for (const p of paths ?? []) out[p] = !!p && fs.existsSync(p)
  return out
})

// A default output folder so nobody has to pick one before the first run. Same path the
// app uses, deliberately: run the batch here and the .SCO / .SCRS land where the product
// would have put them, so the two are looking at one folder rather than two.
ipcMain.handle('sconcrete-autodetect', async () => {
  try {
    const dir = path.join(app.getPath('documents'), 'S-Concrete Batches')
    fs.mkdirSync(dir, { recursive: true })
    return { outDir: dir }
  } catch {
    return { outDir: '' }
  }
})

registerSconcreteBridge(ipcMain)
registerEtabsBridge(ipcMain)

// Closing the app takes its panels with it.
app.on('before-quit', () => {
  for (const w of popoutWindows.values()) if (w && !w.isDestroyed()) w.destroy()
  popoutWindows.clear()
})

app.whenReady().then(async () => {
  // server.mjs is ESM and this file is CJS, so it comes in by dynamic import. Same
  // server the browser demo runs — one copy, no chance of the two drifting.
  const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')).href)
  // Port 0 → let the OS pick, so two runs of the shell cannot clash. PORT pins it when
  // you want to point a browser at the same server the desktop app is using.
  PORT = await startServer(Number(process.env.PORT || 0))
  console.log(`serving http://127.0.0.1:${PORT}`)
  createMain()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMain() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
