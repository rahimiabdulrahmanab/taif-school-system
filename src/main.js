const { app, BrowserWindow, shell } = require('electron');
const path   = require('path');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;

// ── Start the Node.js server ─────────────────────────────────
function startServer() {
  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    env: { ...process.env }
  });

  serverProcess.on('message', (msg) => console.log('Server:', msg));
  serverProcess.on('error',   (err) => console.error('Server error:', err));
}

// ── Create the main window ───────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:          1280,
    height:         800,
    minWidth:       1024,
    minHeight:      640,
    title:          'Taif High School Management System',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  // Wait for server then load
  setTimeout(() => {
    mainWindow.loadURL('http://localhost:3000/admin');
  }, 1500);

  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── App lifecycle ────────────────────────────────────────────
app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});