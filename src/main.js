const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path   = require('path');
const { fork } = require('child_process');
const http   = require('http');
const net    = require('net');
const fs     = require('fs');

let mainWindow;
let serverProcess;
let serverOutput  = '';   // what the server printed, for the error dialog
let serverLogPath = null; // and a copy on disk
let PORT = 3000;          // 3000 unless something on the PC already has it

// ── Load .env explicitly from project root ────────────────────
// Where the settings file may live. Packaged, __dirname is inside
// app.asar — a read-only archive that cannot contain a .env and that the
// school could never edit anyway. So look beside the installed program and
// in the per-user data folder as well, and remember which one was used so
// the error message can name it.
let _envPathUsed = null;

function envSearchPaths() {
  const paths = [];
  if (process.env.TAIF_ENV_FILE) paths.push(process.env.TAIF_ENV_FILE);
  try { paths.push(path.join(app.getPath('userData'), '.env')); } catch (_) {}
  try { paths.push(path.join(path.dirname(app.getPath('exe')), '.env')); } catch (_) {}
  paths.push(path.join(__dirname, '..', '.env'));   // running from source
  // Shipped with the installer, so a school PC works the moment it is
  // installed — nobody in the office has to paste a connection string.
  // It is last, so a .env we place by hand still wins over it.
  try { paths.push(path.join(process.resourcesPath, 'settings.env')); } catch (_) {}
  return paths;
}

function parseEnvFile(envPath) {
  const vars = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    vars[trimmed.slice(0, idx).trim()] =
      trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return vars;
}

// Read every settings file, not just the first one that exists. An earlier
// version of this program left behind a template with an empty DATABASE_URL,
// and stopping at that file would have hidden the real settings shipped with
// the installer. A key that is actually filled in wins; a blank one does not.
function loadEnv() {
  const vars = {};
  for (const envPath of envSearchPaths()) {
    if (!fs.existsSync(envPath)) continue;
    let fileVars;
    try { fileVars = parseEnvFile(envPath); } catch (_) { continue; }
    for (const key of Object.keys(fileVars)) {
      if (!vars[key] && fileVars[key]) vars[key] = fileVars[key];
    }
    if (!_envPathUsed && fileVars.DATABASE_URL) _envPathUsed = envPath;
  }
  return vars;
}

// On first run there is nowhere obvious to put the settings, so leave a
// template in the per-user folder with the right shape and a comment.
function ensureEnvTemplate() {
  try {
    const target = path.join(app.getPath('userData'), '.env');
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target,
      '# Taif School System — settings\n' +
      '# Paste the DATABASE_URL from the Neon console between the quotes,\n' +
      '# save this file, then start the program again.\n' +
      'DATABASE_URL=\n' +
      'JWT_SECRET=change-me-to-a-long-random-string\n' +
      'PORT=3000\n');
    return target;
  } catch (_) { return null; }
}

// ── Start the Express server ──────────────────────────────────
function startServer() {
  const serverPath = path.join(__dirname, 'server.js');
  const appRoot    = path.join(__dirname, '..');
  const envVars    = loadEnv();

  // app.getPath('userData') is per-user and writable, and survives updates:
  // %APPDATA%Taif School System on Windows. The install directory is not
  // writable once packaged, so the WhatsApp session must not live there.
  const dataDir = app.getPath('userData');

  // Packaged, appRoot is ...\resources\app.asar — a FILE, not a folder. Using
  // it as the working directory made the spawn fail with ENOENT before the
  // server ran a single line, which is why the installed app never started
  // while `node src/server.js` was fine. Run from a real, writable folder.
  const workDir = app.isPackaged ? dataDir : appRoot;

  serverProcess = fork(serverPath, [], {
    cwd: workDir,
    env: {
      ...process.env,
      ...envVars,
      ELECTRON: 'true',
      NODE_ENV:  'production',
      PORT: String(PORT),   // after envVars: the free port wins over the file
      WA_SESSION_DIR: path.join(dataDir, 'wa-session'),
      UPLOADS_DIR:    path.join(dataDir, 'uploads'),
    },
    silent: true,
  });

  // Keep whatever the server prints. Packaged, its console goes nowhere, so
  // a crash on startup was invisible and the dialog could only guess.
  try {
    serverLogPath = path.join(app.getPath('userData'), 'server.log');
    fs.writeFileSync(serverLogPath, '=== started ' + new Date().toISOString() + ' ===\n');
  } catch (_) { serverLogPath = null; }

  const record = (chunk) => {
    const text = String(chunk);
    serverOutput += text;
    if (serverOutput.length > 20000) serverOutput = serverOutput.slice(-20000);
    if (serverLogPath) { try { fs.appendFileSync(serverLogPath, text); } catch (_) {} }
  };
  if (serverProcess.stdout) serverProcess.stdout.on('data', record);
  if (serverProcess.stderr) serverProcess.stderr.on('data', record);

  // These two used to print to a console that does not exist once packaged,
  // so a server that died on startup left no trace anywhere.
  serverProcess.on('error', (err) =>
    record('Could not start the server process: ' + err.message + '\n'));
  serverProcess.on('exit', (code, signal) =>
    record('Server stopped: code=' + code + ' signal=' + signal + '\n'));
}

// ── Pick a port ───────────────────────────────────────────────
// An office PC may already have something sitting on 3000 — another copy of
// this program, a printer utility, a developer tool. "Port 3000 is in use" is
// not something the school can act on, so take the next free port instead.
function tryPort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(0));
    probe.listen(port, '127.0.0.1', () => {
      const got = probe.address().port;
      probe.close(() => resolve(got));
    });
  });
}

async function choosePort() {
  for (const p of [3000, 3001, 3002, 3003, 0]) {
    const got = await tryPort(p);
    if (got) return got;
  }
  return 3000;
}

// ── Poll until server responds ────────────────────────────────
function waitForServer(callback, attempts = 0) {
  if (attempts > 60) { callback(false); return; }
  http.get('http://localhost:' + PORT + '/api/health', (res) => {
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
  mainWindow.loadURL('http://localhost:' + PORT + '/admin');
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
app.whenReady().then(async () => {
  const splash = createSplash();

  // If this program is already running, join it rather than starting a second
  // server; otherwise take a port that is actually free.
  const alreadyUp = await new Promise((res) => checkAlreadyRunning(res));
  if (alreadyUp) PORT = 3000;
  else { PORT = await choosePort(); startServer(); }

  waitForServer((ready) => {
    if (ready) {
      createWindow();
      setTimeout(() => { if (!splash.isDestroyed()) splash.close(); }, 600);
    } else {
      if (!splash.isDestroyed()) splash.close();
      // Say which problem it actually is. The commonest by far is that the
      // program has no database settings: the .env cannot be packaged inside
      // the app, so on a fresh install there is nothing to connect with.
      const envVars = loadEnv();
      if (!envVars.DATABASE_URL) {
        const created = ensureEnvTemplate();
        dialog.showErrorBox('Database settings missing',
          'The program does not know which database to use, so the server could not start.\n\n' +
          'A settings file has been prepared here:\n\n' +
          (created || '(could not create it)') + '\n\n' +
          'Open that file in Notepad, paste the DATABASE_URL from the Neon console after "DATABASE_URL=", ' +
          'save it, and start the program again.\n\n' +
          'It is the same database the website uses, so all the students, fees and classes will be there.');
        try { shell.showItemInFolder(created); } catch (_) {}
      } else {
        dialog.showErrorBox('Startup Error',
          'Could not start the server, but the database settings were found in:\n\n' +
          (_envPathUsed || 'unknown') + '\n\n' +
          'Please check:\n' +
          '• the internet connection (the database is online)\n' +
          '• that the DATABASE_URL in that file is still correct\n' +
          '• that no antivirus is blocking it\n\n' +
          (serverOutput ? 'What the server said:\n\n' + serverOutput.slice(-1200) + '\n\n' : '') +
          (serverLogPath ? 'Full log: ' + serverLogPath + '\n\n' : '') +
          'Then start the program again.');
      }
      app.quit();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});