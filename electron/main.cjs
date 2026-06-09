const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'S-Concrete Design',
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
    { label: 'Help', submenu: [{ label: 'About S-Concrete', click: () => {} }] },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── IPC: native file dialogs ─────────────────────────────────────────────────

ipcMain.handle('save-file', async (_, { content, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'S-Concrete Project', extensions: ['scdb'] }],
  });
  if (canceled || !filePath) return { success: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { success: true };
});

ipcMain.handle('open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'S-Concrete Project', extensions: ['scdb', 'json'] }],
  });
  if (canceled || !filePaths.length) return null;
  const content = fs.readFileSync(filePaths[0], 'utf8');
  return { content };
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
