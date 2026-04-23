const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path   = require('path');
const { fork } = require('child_process');
const http   = require('http');
const fs     = require('fs');

let mainWindow;
let serverProcess;

// ── Load .env explicitly from project root ────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const vars  = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    vars[key] = val;
  }
  return vars;
}

// ── Start the Express server ──────────────────────────────────
function startServer() {
  const serverPath = path.join(__dirname, 'server.js');
  const appRoot    = path.join(__dirname, '..');
  const envVars    = loadEnv();

  serverProcess = fork(serverPath, [], {
    cwd: appRoot,
    env: {
      ...process.env,
      ...envVars,
      ELECTRON: 'true',
      NODE_ENV:  'production',
    },
    silent: false,
  });

  serverProcess.on('error', (err) => console.error('Server error:', err));
  serverProcess.on('exit',  (code) => console.log('Server exit:', code));
}

// ── Poll until server responds ────────────────────────────────
function waitForServer(callback, attempts = 0) {
  if (attempts > 60) { callback(false); return; }
  http.get('http://localhost:3000/api/health', (res) => {
    if (res.statusCode === 200) { callback(true); }
    else { setTimeout(() => waitForServer(callback, attempts + 1), 800); }
  }).on('error', () => {
    setTimeout(() => waitForServer(callback, attempts + 1), 800);
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

// ── Check if server already running ───────────────────────────
function checkAlreadyRunning(callback) {
  http.get('http://localhost:3000/api/health', (res) => {
    callback(res.statusCode === 200);
  }).on('error', () => callback(false));
}

// ── Lifecycle ─────────────────────────────────────────────────
app.whenReady().then(() => {
  const splash = createSplash();

  checkAlreadyRunning((alreadyUp) => {
    if (!alreadyUp) startServer();
  });

  waitForServer((ready) => {
    if (ready) {
      createWindow();
      setTimeout(() => { if (!splash.isDestroyed()) splash.close(); }, 600);
    } else {
      if (!splash.isDestroyed()) splash.close();
      dialog.showErrorBox('Startup Error',
        'Could not start the server.\n\nPlease check:\n• PostgreSQL service is running\n• Port 3000 is not already in use\n• Your .env file has the correct database credentials\n\nThen restart the application.');
      app.quit();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});