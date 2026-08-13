const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')

// SERVED OVER HTTP, NOT file://
//
// The popout system uses a BroadcastChannel to keep a panel's window in step with the
// main one, and that only reaches windows of the SAME ORIGIN. Pages loaded from file://
// each get an opaque origin, so the channel silently connects to nothing and every
// popped-out panel sits on "Loading…" for ever. A few lines of static server buys a real
// origin and the whole thing works. Swap this for your own backend when you have one —
// the renderer does not care what is serving, only that it is one origin.
const ROOT = path.join(__dirname, '..')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
let PORT = 0

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = decodeURIComponent((req.url || '/').split('?')[0])
            const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '')
            const file = path.join(ROOT, rel)
            // never serve outside the project directory
            if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return }
            fs.readFile(file, (err, buf) => {
                if (err) { res.writeHead(404).end('not found'); return }
                res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
                res.end(buf)
            })
        })
        server.listen(0, '127.0.0.1', () => { PORT = server.address().port; resolve() })
    })
}

const windowOpts = () => ({
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
})

let mainWindow = null

function createMain() {
    mainWindow = new BrowserWindow({ width: 1200, height: 800, title: 'UI Starter', ...windowOpts() })
    attachWindowOpenHandler(mainWindow)
    mainWindow.loadURL(`http://127.0.0.1:${PORT}/`)
    mainWindow.setMenuBarVisibility(false)
    mainWindow.once('ready-to-show', () => mainWindow.show())
    mainWindow.on('closed', () => { mainWindow = null })
}

// A panel gets its own window by loading the SAME page with ?popout=<kind>, so there is
// one bundle and one entry point. No state is handed over through IPC: props travel on
// the BroadcastChannel both windows share, and callbacks travel back the same way.
const popoutWindows = new Map()   // kind -> BrowserWindow

function openPopout(kind, title) {
    const existing = popoutWindows.get(kind)
    if (existing && !existing.isDestroyed()) { existing.focus(); return }
    const win = new BrowserWindow({ width: 900, height: 640, title: title || 'Panel', ...windowOpts() })
    // deliberately NOT `parent`: a child window is trapped above its parent and cannot
    // be sent behind it or dragged onto another display independently
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

// Belt and braces for the renderer's fallback path. Without window.desktop the page
// calls window.open('?popout=…'), which Electron DENIES by default — silently, which is
// exactly what a broken popout looks like. Route it through the same code instead.
function attachWindowOpenHandler(win) {
    win.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const kind = new URL(url, `http://127.0.0.1:${PORT}`).searchParams.get('popout')
            if (kind) { openPopout(kind, null); return { action: 'deny' } }
        } catch (e) { /* not a popout URL */ }
        return { action: 'deny' }
    })
}

// closing the app takes its panels with it
app.on('before-quit', () => {
    for (const w of popoutWindows.values()) if (w && !w.isDestroyed()) w.destroy()
    popoutWindows.clear()
})

app.whenReady().then(async () => {
    await serve()
    createMain()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMain() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
