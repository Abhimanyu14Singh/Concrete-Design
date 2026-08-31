/**
 * Electron main process — the app's only privileged context.
 *
 * The renderer runs with `nodeIntegration: false` and `contextIsolation: true`, so it
 * has no filesystem, no child processes and no COM. Everything that needs the OS is an
 * IPC handler registered here, and the renderer reaches it through the narrow surface
 * `preload.cjs` exposes. Four responsibilities, in the order they appear below:
 *
 *  1. WINDOWS — the main window, an optional popped-out Group Dashboard, and any number
 *     of torn-off workspace panels (one per kind). Windows never message each other
 *     directly; the main process relays (see the `dashboard:*` handlers).
 *  2. NATIVE MENU — File/View/Help. Menu items don't act, they `send()` to the renderer,
 *     which owns the project state and decides what the command means.
 *  3. FILE DIALOGS + PATH HELPERS — save/open a .scdb, pick S-Concrete paths, reveal a
 *     folder in Explorer.
 *  4. BRIDGES — the ETABS OAPI bridge and the S-Concrete batch runner, each registered
 *     from its own module so this file stays about windows and wiring.
 *
 * IPC handlers here return a `{ success | ok, error? }` object rather than throwing:
 * a rejected `invoke` crosses the process boundary as an opaque "Error invoking remote
 * method", which tells the user nothing. Every handler catches and reports its own
 * message instead.
 */

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { pathToFileURL } = require('url');
const { registerEtabsBridge, killHelper } = require('./etabsBridge.cjs');
const { registerSconcreteBridge } = require('./sconcreteBridge.cjs');
const usage = require('./usageLog.cjs');

// Time every IPC channel by wrapping the registrar, which means this call has to happen
// BEFORE the first `ipcMain.handle` below — a handler registered earlier is registered
// against the original function and is never seen again. See usageLog.cjs on why the
// instrumentation lives at the registrar rather than in each handler.
usage.instrumentIpc(ipcMain);
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
// Torn-off panel windows, keyed by WINDOW ID (`w1`, `w2`, …) — not by panel kind.
//
// A detached window is a CONTAINER: it can hold several panels in its own column layout,
// and panels move between windows by drag or menu. Keying by kind (as this did when a
// window could only ever hold one panel) made "which window is this" and "which panel is
// this" the same question, which is exactly what has to come apart for docking to work.
// The renderer allocates the ids and owns the mapping of panel → window; this map only
// needs to find a window again to focus it, close it, or report its bounds.
const popoutWins = new Map();

/**
 * Open (or focus) a panel window.
 *
 * The URL carries `?popout=<winId>`, which `src/main.tsx` branches on to mount the slim
 * `Popout` root instead of the whole app; the window then asks the renderer over the
 * BroadcastChannel bus which panels it is holding. Dev and packaged differ only in how
 * the page is addressed — the query has to survive both, which is why the packaged
 * branch builds the file URL explicitly rather than relying on loadFile's option shape.
 *
 * Deliberately NOT a `parent` window: a child is trapped above its parent and cannot be
 * sent behind it or dragged onto another display independently, which is the entire
 * reason to detach a panel.
 */
function openPanelWindow(kind, title) {
  if (!kind) return;
  const existing = popoutWins.get(kind);
  if (existing && !existing.isDestroyed()) { existing.focus(); return; }
  const win = new BrowserWindow({
    width: 900, height: 660, minWidth: 360, minHeight: 300,
    title: title || 'Panel',
    icon: path.join(__dirname, '../public/favicon.svg'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    backgroundColor: '#f3f4f6',
    show: false,
  });
  win.removeMenu();
  attachWindowOpenHandler(win);
  usage.attachWindow(win, 'panel');
  win.once('ready-to-show', () => win.show());
  const q = `popout=${encodeURIComponent(kind)}`;
  if (isDev) {
    win.loadURL(`http://localhost:5173/?${q}`);
  } else {
    const u = pathToFileURL(path.join(__dirname, '../dist/index.html'));
    u.search = q;
    win.loadURL(u.href);
  }
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    console.error(`popout ${kind} failed to load: ${desc} (${code})`));
  win.on('closed', () => popoutWins.delete(kind));
  popoutWins.set(kind, win);
}

/**
 * Nothing opens a window on its own.
 *
 * Electron's DEFAULT for `window.open` is to spawn a full BrowserWindow on whatever URL
 * it was given — which, for a workspace running in a browser-shaped fallback, meant a
 * second complete copy of the app every time a panel was torn off. Every window gets
 * this handler: a `?popout=` URL is routed to a real panel window, and everything else
 * is denied rather than quietly becoming another app instance.
 */
function attachWindowOpenHandler(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const kind = new URL(url, 'http://localhost').searchParams.get('popout');
      if (kind) { openPanelWindow(kind, null); }
    } catch { /* not a popout URL — deny below */ }
    return { action: 'deny' };
  });
}

/**
 * Create the main application window and install the native menu.
 *
 * Shown only on `ready-to-show` (with a light `backgroundColor` set up front) so the
 * user never sees an empty white-then-repaint flash while the bundle boots. Closing it
 * also closes the dashboard pop-out — that window is a satellite of this one and is
 * meaningless without the main renderer feeding it state.
 */
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
  attachWindowOpenHandler(win);
  usage.attachWindow(win, 'main');
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
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => win.webContents.send('trigger-save-as') },
        { type: 'separator' },
        // These two used to exist only on the in-page menu bar, which is now the
        // browser's fallback and no longer renders here. They are on the native menu
        // so the desktop app is not the build with FEWER commands than the web one.
        { label: 'Import from ETABS…', click: () => win.webContents.send('import-etabs') },
        { label: 'Reset the workspace', click: () => win.webContents.send('reset-workspace') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          // The model view's frame meter. In the View menu because it changes what the
          // window shows, and because a user reporting "the 3D view is slow" needs a
          // route to a number without opening devtools.
          label: 'Performance meter',
          accelerator: 'CmdOrCtrl+Alt+P',
          click: () => win.webContents.send('toggle-perf'),
        },
        { type: 'separator' },
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
    // Between View and Help, matching the in-page menu bar the browser build shows.
    // It has to be HERE as well as there: the in-page bar is hidden in the desktop
    // build (WorkspaceView renders it only when `!window.electronAPI`), so a menu added
    // only to that one exists everywhere except the app people actually install.
    {
      label: 'Preferences',
      submenu: [
        { label: 'Model appearance…', click: () => win.webContents.send('open-preferences') },
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
        // Also on the native menu, not only in the in-app Diagnostics tab. The session
        // worth exporting is usually the one where the renderer has just died — and a
        // button inside a white screen cannot be clicked.
        { label: 'Export usage data…', click: () => usage.exportBundle(win) },
        {
          label: 'Diagnostics',
          click: () => win.webContents.send('open-help', 'diagnostics'),
        },
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

/**
 * Open (or focus) the Group Dashboard in its own window, so it can live on a second
 * monitor while the user works a member on the first.
 *
 * Addressed by the `#dashboard` hash rather than a query (unlike the workspace panels
 * above) — the app's own router branch predates the `?popout=` mechanism and both are
 * still read. The window carries no state of its own: the main renderer pushes it via
 * `dashboard:state` and it pushes commands back via `dashboard:command`. On close it
 * tells the main window, which restores the inline dashboard view.
 */
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
  attachWindowOpenHandler(dashboardWin);
  usage.attachWindow(dashboardWin, 'dashboard');
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
// Workspace panel pop-out, from window.desktop.popout in the preload.
ipcMain.handle('popout:open', (_evt, kind, title) => {
  if (!kind) return { ok: false };
  try { openPanelWindow(String(kind), title); }
  catch (e) { console.error(`popout ${kind} failed: ${e.message}`); return { ok: false }; }
  return { ok: true };
});

/**
 * Screen-space bounds of every dockable window, for cross-window drag.
 *
 * Dropping a panel from one window onto another has to answer "what is under the
 * pointer", and the pointer is outside the dragging window's own document by then —
 * only the OS knows. The renderer takes this list ONCE at drag start and hit-tests
 * `screenX`/`screenY` against it locally on every pointermove; polling over IPC per
 * move would put a round trip in the middle of a 60 Hz gesture.
 *
 * The main window is included under the id `dock`, so a panel can be dragged back into
 * the workspace from a detached window the same way it left.
 */
ipcMain.handle('popout:bounds', () => {
  const out = [];
  if (mainWin && !mainWin.isDestroyed()) {
    const b = mainWin.getBounds();
    out.push({ id: 'dock', x: b.x, y: b.y, w: b.width, h: b.height });
  }
  for (const [id, win] of popoutWins) {
    if (!win || win.isDestroyed()) continue;
    const b = win.getBounds();
    out.push({ id, x: b.x, y: b.y, w: b.width, h: b.height });
  }
  return out;
});

/** Bring a window forward — called after a panel is dropped into it, so the drop is
 *  visible rather than landing on a window still behind the one dragged from. */
ipcMain.handle('popout:focus', (_evt, id) => {
  const win = id === 'dock' ? mainWin : popoutWins.get(String(id));
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  return { ok: true };
});

/** Close a panel window by id — the renderer's way of reclaiming an emptied window. */
ipcMain.handle('popout:close', (_evt, id) => {
  const win = popoutWins.get(String(id));
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

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

/**
 * Write the project. Two modes, and which one runs is the renderer's call:
 *
 *   filePath given   — Save. Overwrite that file, no dialog. This is what makes
 *                      Ctrl+S a keystroke rather than a conversation.
 *   filePath absent  — Save As. Ask where, then write there.
 *
 * The chosen path is RETURNED either way, because the renderer is the only place that
 * can remember it: the main process has no idea which window holds which project, and a
 * project can be opened, saved-as and re-saved several times in one session.
 */
/**
 * Whether Chromium is actually using the GPU.
 *
 * The authoritative answer, and the one thing a renderer cannot work out for itself:
 * `chrome://gpu` is not readable from a page, and the WebGL renderer string is usually
 * masked. It matters because software rasterisation is the difference between a model
 * view that orbits and one that crawls — 3857 translucent area fills on the CPU is a
 * different machine from the same scene on a GPU.
 *
 * Never throws: a diagnostic that fails the app it is diagnosing is worse than useless.
 */
ipcMain.handle('gpu-status', async () => {
  try {
    const featureStatus = app.getGPUFeatureStatus();
    let info = null;
    try { info = await app.getGPUInfo('basic'); } catch { /* not fatal */ }
    return { featureStatus, info };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('save-file', async (event, { content, defaultName, filePath: target }) => {
  try {
    let filePath = target;
    if (!filePath) {
      const win = windowFor(event);
      const res = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters: [{ name: 'S-Concrete Project', extensions: ['scdb'] }],
      });
      if (res.canceled || !res.filePath) return { success: false, canceled: true };
      filePath = res.filePath;
    }
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true, filePath };
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
    // The path travels with the content so a later Ctrl+S knows where "here" is.
    return { content, filePath: filePaths[0] };
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

// ── IPC: usage log (local only — see electron/usageLog.cjs) ──────────────────

usage.registerUsageLog(ipcMain);

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // After ready, because the session header reads app.getVersion / getLocale / the
  // display list, and before the window, so a renderer that fails to boot at all still
  // has a session to be recorded against.
  usage.beginSession();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// `before-quit` rather than `will-quit`: the last flush is synchronous and wants to
// happen while the app is still unwinding normally, not in the teardown window where
// Electron may already be closing handles underneath it.
app.on('before-quit', () => usage.endSession('quit'));

app.on('will-quit', () => { killHelper(); usage.flushSync(); });
