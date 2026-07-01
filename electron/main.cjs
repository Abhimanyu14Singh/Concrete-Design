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
    backgroundColor: '#030712',
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

// Best-effort auto-detect of the S-Concrete batch paths so the user rarely has
// to enter them by hand. Returns { pythonExe, batchReporter, outDir } — empty
// strings for anything not found. The renderer only fills fields left blank, and
// every value stays overridable, so a wrong guess is harmless.
ipcMain.handle('sconcrete-autodetect', async () => {
  const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
  const firstExisting = (cands) => cands.find(exists) || '';
  const found = { pythonExe: '', batchReporter: '', outDir: '' };

  // Python: PATH first, then common Windows install locations, then the column
  // tool's known sandbox path.
  const pyCandidates = [];
  try {
    const { execFileSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    for (const name of ['python', 'python3', 'py']) {
      try {
        const lines = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 4000 }).split(/\r?\n/);
        for (const line of lines) { const t = line.trim(); if (t) pyCandidates.push(t); }
      } catch { /* not on PATH */ }
    }
  } catch { /* child_process unavailable */ }
  try {
    const la = process.env.LOCALAPPDATA;
    if (la && fs.existsSync(path.join(la, 'Programs', 'Python'))) {
      for (const d of fs.readdirSync(path.join(la, 'Programs', 'Python'))) {
        pyCandidates.push(path.join(la, 'Programs', 'Python', d, 'python.exe'));
      }
    }
  } catch { /* ignore */ }
  pyCandidates.push('C:\\Claude_Sandbox\\Python\\python.exe');
  found.pythonExe = firstExisting(pyCandidates);

  // BatchReporter script: a bundled copy (if we ship one) beats the sandbox path.
  found.batchReporter = firstExisting([
    path.join(process.resourcesPath || '', 'run_batch_reporter.py'),
    path.join(__dirname, '..', 'run_batch_reporter.py'),
    'C:\\Claude_Sandbox\\run_batch_reporter.py',
  ]);

  // Output folder: a stable per-user default under Documents, created on demand.
  try {
    const dir = path.join(app.getPath('documents'), 'S-Concrete Batches');
    fs.mkdirSync(dir, { recursive: true });
    found.outDir = dir;
  } catch { /* leave blank; the user can still pick one */ }

  return found;
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
