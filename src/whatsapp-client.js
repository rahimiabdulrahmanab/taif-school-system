const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path   = require('path');

let client  = null;
let _status = 'disconnected'; // disconnected | initializing | qr | connected
let _qr     = null;

function getStatus() {
  return { status: _status, connected: _status === 'connected', qr: _qr };
}

async function initialize() {
  if (client) return;
  _status = 'initializing';
  _qr     = null;

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(process.cwd(), '.wa-session'),
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--no-first-run'],
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
    console.log('[WhatsApp] Connected and ready');
  });

  client.on('auth_failure', (msg) => {
    _status = 'disconnected';
    client  = null;
    _qr     = null;
    console.error('[WhatsApp] Auth failure:', msg);
  });

  client.on('disconnected', (reason) => {
    _status = 'disconnected';
    client  = null;
    _qr     = null;
    console.log('[WhatsApp] Disconnected:', reason);
  });

  // Initialize without awaiting — status updates come via events
  client.initialize().catch((err) => {
    console.error('[WhatsApp] Init error:', err.message);
    _status = 'disconnected';
    client  = null;
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
