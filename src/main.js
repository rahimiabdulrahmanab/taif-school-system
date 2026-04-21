const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path   = require('path');
const { fork } = require('child_process');
const http   = require('http');

let mainWindow;
let serverProcess;

// ── Start the Express server ──────────────────────────────────
function startServer() {
  const serverPath = path.join(__dirname, 'server.js');
  const appRoot    = path.join(__dirname, '..');

  serverProcess = fork(serverPath, [], {
    cwd: appRoot,  // ← critical: set working dir to project root
    env: {
      ...process.env,
      ELECTRON: 'true',
      NODE_ENV: 'production',
    },
    silent: false,
  });

  serverProcess.on('error', (err) => console.error('Server error:', err));
  serverProcess.on('exit',  (code) => console.log('Server exit:', code));
}

// ── Poll until server responds ────────────────────────────────
function waitForServer(callback, attempts = 0) {
  if (attempts > 40) { callback(false); return; }
  http.get('http://localhost:3000/api/health', (res) => {
    if (res.statusCode === 200) { callback(true); }
    else { setTimeout(() => waitForServer(callback, attempts + 1), 600); }
  }).on('error', () => {
    setTimeout(() => waitForServer(callback, attempts + 1), 600);
  });
}

// ── Splash window ─────────────────────────────────────────────
function createSplash() {
  const splash = new BrowserWindow({
    width: 480, height: 320,
    frame: false, transparent: true,
    resizable: false, alwaysOnTop: true,
    webPreferences: { nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, '..', 'public', 'splash.html'));
  return splash;
}

// ── Main window ───────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900,
    minWidth: 1100, minHeight: 700,
    title: 'Taif High School Management System',
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL('http://localhost:3000/admin');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (serverProcess) serverProcess.kill();
    app.quit();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Lifecycle ─────────────────────────────────────────────────
app.whenReady().then(() => {
  const splash = createSplash();
  startServer();

  waitForServer((ready) => {
    if (ready) {
      createWindow();
      setTimeout(() => { if (!splash.isDestroyed()) splash.close(); }, 600);
    } else {
      if (!splash.isDestroyed()) splash.close();
      dialog.showErrorBox('Startup Error',
        'Could not connect to the database server.\n\nMake sure PostgreSQL is running and your .env file is configured correctly.\n\nThen restart the application.');
      app.quit();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});