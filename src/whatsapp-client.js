const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path   = require('path');

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
      dataPath: path.join(process.cwd(), '.wa-session'),
    }),
    puppeteer: {
      headless: true,
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

module.exports = { initialize, sendMessage, destroy, getStatus };
