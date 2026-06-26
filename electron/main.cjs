const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
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
