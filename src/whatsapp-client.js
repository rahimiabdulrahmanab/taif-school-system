const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path   = require('path');

// Find the Chromium that WhatsApp Web needs, wherever it ended up.
//
// Puppeteer looks in the HOME directory by default. Render's home is
// /opt/render, and the browser downloaded during the build is not there when
// the service runs — the diagnose output showed "cache dir: does not exist".
// Setting PUPPETEER_CACHE_DIR would line them up, but that needs a dashboard
// change nobody can make from here, and a blueprint edit did not take.
//
// So instead of depending on an environment variable being right, look in
// every place the browser could plausibly be and use whichever exists.
function findChrome() {
  const fs   = require('fs');
  const path = require('path');
  const candidates = [];

  if (process.env.PUPPETEER_EXECUTABLE_PATH) candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH);
  try { candidates.push(require('puppeteer').executablePath()); } catch (_) {}

  // Every cache root worth checking, including the project-local one the
  // postinstall script writes to.
  const roots = [
    path.join(__dirname, '..', '.cache', 'puppeteer'),
    process.env.PUPPETEER_CACHE_DIR,
    path.join(require('os').homedir(), '.cache', 'puppeteer'),
    '/opt/render/project/src/.cache/puppeteer',
  ].filter(Boolean);

  for (const root of roots) {
    const chromeDir = path.join(root, 'chrome');
    let versions = [];
    try { versions = fs.readdirSync(chromeDir); } catch (_) { continue; }
    for (const v of versions) {
      candidates.push(path.join(chromeDir, v, 'chrome-linux64', 'chrome'));
      candidates.push(path.join(chromeDir, v, 'chrome-win64', 'chrome.exe'));
      candidates.push(path.join(chromeDir, v, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    }
  }

  // A system Chromium, if the host happens to provide one.
  candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

let client  = null;
let _status = 'disconnected'; // disconnected | initializing | qr | connected
let _qr     = null;
let _error  = null;           // why the last attempt failed, for the screen

function getStatus() {
  return { status: _status, connected: _status === 'connected', qr: _qr, error: _error };
}

async function initialize() {
  if (client) return;
  _status = 'initializing';
  _qr     = null;
  _error  = null;

  client = new Client({
    authStrategy: new LocalAuth({
      // Set by the desktop app to a writable per-user folder; on a server
      // the working directory is fine.
      dataPath: process.env.WA_SESSION_DIR || path.join(process.cwd(), '.wa-session'),
    }),
    puppeteer: {
      headless: true,
      // Whatever we found, rather than whatever the default path guesses.
      executablePath: findChrome() || undefined,
      // Tuned for a small container: no /dev/shm to overflow, one process
      // rather than a tree of them, and nothing drawn that nobody will see.
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--no-first-run',
        '--disable-dev-shm-usage', '--no-zygote', '--single-process',
        '--disable-extensions', '--disable-background-networking',
        '--disable-accelerated-2d-canvas', '--mute-audio',
      ],
    },
  });

  client.on('qr', async (qr) => {
    _status = 'qr';
    _qr = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
    console.log('[WhatsApp] QR ready — open Admin > WhatsApp to scan');
  });

  client.on('authenticated', () => {
    _qr = null;
    console.log('[WhatsApp] Authenticated');
  });

  client.on('ready', () => {
    _status = 'connected';
    _qr     = null;
    _error  = null;
    console.log('[WhatsApp] Connected and ready');
  });

  client.on('auth_failure', (msg) => {
    _status = 'disconnected';
    client  = null;
    _qr     = null;
    _error  = 'WhatsApp rejected the login: ' + msg;
    console.error('[WhatsApp] Auth failure:', msg);
  });

  client.on('disconnected', (reason) => {
    _status = 'disconnected';
    client  = null;
    _qr     = null;
    console.log('[WhatsApp] Disconnected:', reason);
  });

  // Initialize without awaiting — status updates come via events.
  // The failure is REPORTED, not just logged: the usual cause is that this
  // host cannot run Chromium at all, and somebody staring at a button that
  // does nothing has no way to know that.
  client.initialize().catch((err) => {
    console.error('[WhatsApp] Init error:', err.message);
    _status = 'disconnected';
    client  = null;
    _error  = /libnss|shared librar|Failed to launch|ENOENT|Could not find (Chrome|Chromium)/i.test(err.message || '')
      ? 'This server cannot run WhatsApp: the browser it needs is missing or cannot start here. Run the desktop app on the school computer instead. (' + String(err.message || '').slice(0, 120) + ')'
      : err.message;
  });
}

async function sendMessage(phone, message) {
  if (!client || _status !== 'connected') throw new Error('WhatsApp is not connected');
  await client.sendMessage(phone + '@c.us', message);
}

async function destroy() {
  if (client) {
    try { await client.destroy(); } catch (_) {}
    client  = null;
    _status = 'disconnected';
    _qr     = null;
  }
}

module.exports = { initialize, sendMessage, destroy, getStatus, findChrome };
