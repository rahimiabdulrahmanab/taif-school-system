#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
 *  Make sure the browser WhatsApp Web needs is actually present.
 *
 *  Puppeteer downloads Chromium into the HOME directory by default.
 *  Render builds in one container and runs in another, and the home
 *  directory does not travel between them — so the browser was
 *  downloaded during the build and gone by the time the app started,
 *  giving "Could not find Chrome (ver. 147.0.7727.57)".
 *
 *  This runs as an npm postinstall, so it happens on every install no
 *  matter which build command the host ends up using. It puts the
 *  browser inside the project directory, which IS preserved.
 *
 *  It NEVER fails the install. A machine that cannot download Chromium
 *  can still run everything else in this app — only WhatsApp bulk
 *  sending is unavailable, and the WhatsApp screen says so plainly.
 * ═══════════════════════════════════════════════════════════════════ */
const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// Electron bundles its own Chromium and the desktop build must not drag a
// second one along; skip unless a server install actually needs it.
if (process.env.SKIP_CHROME_DOWNLOAD === '1') {
  console.log('[chrome] SKIP_CHROME_DOWNLOAD=1 — skipping');
  process.exit(0);
}

const cacheDir = process.env.PUPPETEER_CACHE_DIR
  || path.join(__dirname, '..', '.cache', 'puppeteer');

try {
  const already = require('puppeteer').executablePath();
  if (fs.existsSync(already)) {
    console.log('[chrome] already present at ' + already);
    process.exit(0);
  }
} catch (_) { /* puppeteer not resolvable yet — fall through and install */ }

console.log('[chrome] installing Chromium into ' + cacheDir);
try {
  execFileSync(process.execPath,
    [path.join(__dirname, '..', 'node_modules', 'puppeteer', 'lib', 'cjs', 'puppeteer', 'node', 'cli.js'),
     'browsers', 'install', 'chrome'],
    { stdio: 'inherit', env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir } });
  console.log('[chrome] done');
} catch (e) {
  // Deliberately not fatal — see the header.
  console.warn('[chrome] could not install Chromium: ' + e.message);
  console.warn('[chrome] the app will run normally; WhatsApp bulk sending will report that it is unavailable.');
}
