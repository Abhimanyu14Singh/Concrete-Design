const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { registerEtabsBridge, killHelper } = require('./etabsBridge.cjs');
const { registerSconcreteBridge } = require('./sconcreteBridge.cjs');
// Dev mode = load the Vite dev server instead of the built dist/.
// `NODE_ENV=development` only works on a POSIX shell; npm scripts run through
// cmd.exe on Windows, where that prefix is a syntax error. The `--dev` flag is
// shell-independent, so it is what `npm run electron:dev` passes. The env var is
// still honoured for anyone (or any tooling) that already sets it.
// `!app.isPackaged` gates both: an INSTALLED app must never chase localhost:5173
// just because the machine happens to export NODE_ENV=development.
const isDev = !app.isPackaged
  && (process.env.NODE_ENV === 'development' || process.argv.includes('--dev'));

// The single main window + an optional popped-out Group Dashboard window. The two
// renderers can't message each other directly, so the main process relays between
// them (see the `dashboard:*` IPC handlers below).
let mainWin = null;
let dashboardWin = null;

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
  mainWin = win;
  win.on('closed', () => { mainWin = null; if (dashboardWin && !dashboardWin.isDestroyed()) dashboardWin.close(); });

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
    {
      label: 'Help',
      submenu: [
        { label: 'Doc Resources',      accelerator: 'F1', click: () => win.webContents.send('open-help', 'guide') },
        { label: 'Your First Model',                      click: () => win.webContents.send('open-help', 'start') },
        { label: 'Keyboard Shortcuts',                    click: () => win.webContents.send('open-help', 'keys')  },
        { label: 'FAQ & Troubleshooting',                 click: () => win.webContents.send('open-help', 'faq')   },
        { type: 'separator' },
        {
          label: 'About S-Dashboard',
          click: () =>
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About S-Dashboard',
              message: 'S-Dashboard',
              detail: `Version ${app.getVersion()}\n\nETABS → Design → S-Concrete verification for reinforced-concrete frames.`,
              buttons: ['OK'],
            }),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── Popped-out Group Dashboard window ────────────────────────────────────────
function createDashboardWindow() {
  if (dashboardWin && !dashboardWin.isDestroyed()) { dashboardWin.focus(); return; }
  dashboardWin = new BrowserWindow({
    width: 960, height: 900, minWidth: 480, minHeight: 400,
    title: 'Group Dashboard — S-Dashboard',
    icon: path.join(__dirname, '../public/favicon.svg'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    backgroundColor: '#f3f4f6',
    show: false,
  });
  dashboardWin.removeMenu();
  dashboardWin.once('ready-to-show', () => dashboardWin.show());
  if (isDev) {
    dashboardWin.loadURL('http://localhost:5173/#dashboard');
  } else {
    dashboardWin.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'dashboard' });
  }
  dashboardWin.on('closed', () => {
    dashboardWin = null;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('dashboard-popped-out', false);
  });
}

// IPC: pop-out lifecycle + relays. The two windows never talk directly — the main
// process forwards state (main→dash) and commands (dash→main).
ipcMain.handle('dashboard:open', () => {
  createDashboardWindow();
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('dashboard-popped-out', true);
});
ipcMain.handle('dashboard:close', () => { if (dashboardWin && !dashboardWin.isDestroyed()) dashboardWin.close(); });
ipcMain.on('dashboard:state', (_e, payload) => {
  if (dashboardWin && !dashboardWin.isDestroyed()) dashboardWin.webContents.send('dashboard:state', payload);
});
ipcMain.on('dashboard:command', (_e, cmd) => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('dashboard:command', cmd);
    // Opening a member navigates the MAIN window to its Member screen — bring it to
    // the front so the user sees it (they double-clicked in the dashboard window).
    if (cmd && cmd.type === 'open-member') {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  }
});
ipcMain.on('dashboard:ready', () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('dashboard:ready');
});

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
