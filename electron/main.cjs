const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { registerEtabsBridge, killHelper } = require('./etabsBridge.cjs');
const { registerSconcreteBridge } = require('./sconcreteBridge.cjs');
const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'S-Dashboard',
    icon: path.join(__dirname, '../public/favicon.svg'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    backgroundColor: '#f3f4f6', // match the light app shell (no dark startup flash)
    show: false,
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Project',    accelerator: 'CmdOrCtrl+N', click: () => win.webContents.send('new-project')   },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => win.webContents.send('trigger-open') },
        { label: 'Save Project',  accelerator: 'CmdOrCtrl+S', click: () => win.webContents.send('trigger-save') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Help', submenu: [{ label: 'About S-Dashboard', click: () => {} }] },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── IPC: native file dialogs ─────────────────────────────────────────────────

// Dialogs are parented to the sender's window so they open modal and on top
// (an unparented dialog can appear BEHIND the app window on Windows, which
// looks like the Save/Open button did nothing).
function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender)
    ?? BrowserWindow.getFocusedWindow()
    ?? undefined;
}

ipcMain.handle('save-file', async (event, { content, defaultName }) => {
  try {
    const win = windowFor(event);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'S-Concrete Project', extensions: ['scdb'] }],
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

ipcMain.handle('open-file', async (event) => {
  try {
    const win = windowFor(event);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'S-Concrete Project', extensions: ['scdb', 'json'] }],
    });
    if (canceled || !filePaths.length) return null;
    const content = fs.readFileSync(filePaths[0], 'utf8');
    return { content };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

// Pick a file or a folder — for the S-Concrete path config (Python, BatchReporter,
// output folder). mode: 'file' | 'folder'. Returns { path } or null when cancelled.
ipcMain.handle('pick-path', async (event, { mode, filters } = {}) => {
  try {
    const win = windowFor(event);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: [mode === 'folder' ? 'openDirectory' : 'openFile'],
      ...(filters ? { filters } : {}),
    });
    if (canceled || !filePaths.length) return null;
    return { path: filePaths[0], exists: fs.existsSync(filePaths[0]) };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

// Open a folder/file in the OS file manager (so the re-run / edit-.SCO loop stays
// in-app: click, land in the output folder, tweak, come back and re-run).
ipcMain.handle('open-path', async (_event, { target } = {}) => {
  try {
    if (!target) return { success: false, error: 'No path given' };
    if (!fs.existsSync(target)) return { success: false, error: `Path does not exist: ${target}` };
    const err = await shell.openPath(target);
    return err ? { success: false, error: err } : { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// Check whether paths exist (validate the S-Concrete config without running).
ipcMain.handle('path-exists', async (_event, { paths } = {}) => {
  const out = {};
  for (const p of paths ?? []) out[p] = !!p && fs.existsSync(p);
  return out;
});

// Auto-fill a default S-Concrete output folder so the user doesn't have to pick
// one. The batch runs via the bundled SConcreteHelper.exe (no Python), so the
// output folder is the only setting — a stable per-user path under Documents,
// created on demand. Returned as { outDir }; the renderer only fills it if blank.
ipcMain.handle('sconcrete-autodetect', async () => {
  try {
    const dir = path.join(app.getPath('documents'), 'S-Concrete Batches');
    fs.mkdirSync(dir, { recursive: true });
    return { outDir: dir };
  } catch {
    return { outDir: '' };
  }
});

// ── IPC: ETABS CSI OAPI bridge (Windows + ETABS running; errors elsewhere) ───

registerEtabsBridge(ipcMain);

// ── IPC: S-Concrete batch runner (Windows + S-Concrete; errors elsewhere) ────

registerSconcreteBridge(ipcMain);

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => killHelper());
