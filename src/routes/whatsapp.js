const express = require('express');
const pool    = require('../db.js');
const wa      = require('../whatsapp-client');
const { kabulTodayISO, todayShamsi } = require('../shamsi.js');
const CONFIG = require('../../school-config.js');
// Dari month names, matching what the rest of the app shows parents.
const SHAMSI_MONTHS = ['', 'حمل', 'ثور', 'جوزا', 'سرطان', 'اسد', 'سنبله',
                       'میزان', 'عقرب', 'قوس', 'جدی', 'دلو', 'حوت'];
const { computeBalances } = require('./fees.js');
const router  = express.Router();

// ── GET status ────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json(wa.getStatus());
});

// ── GET diagnose — can this host run WhatsApp at all? ─────────
// Answers the question "is the browser actually installed here", which is
// otherwise only visible in build logs nobody reads.
router.get('/diagnose', (req, res) => {
  const fs = require('fs');
  const out = {
    cache_dir_env: process.env.PUPPETEER_CACHE_DIR || null,
    executable: null,
    executable_exists: false,
    cache_contents: [],
    node_memory_mb: Math.round(process.memoryUsage().rss / 1048576),
  };
  try {
    out.executable = wa.findChrome() || require('puppeteer').executablePath();
    out.executable_exists = !!out.executable && fs.existsSync(out.executable);
    out.found_by_search = !!wa.findChrome();
  } catch (e) { out.executable = 'error: ' + e.message; }

  // What the postinstall script writes to, which is the most likely place
  // for the browser to actually be on a host like Render.
  try {
    const local = require('path').join(__dirname, '..', '..', '.cache', 'puppeteer');
    out.project_cache = local;
    out.project_cache_contents = fs.existsSync(local) ? fs.readdirSync(local) : ['(does not exist)'];
    const chromeDir = require('path').join(local, 'chrome');
    out.project_chrome_versions = fs.existsSync(chromeDir) ? fs.readdirSync(chromeDir) : [];
  } catch (e) { out.project_cache_contents = ['error: ' + e.message]; }
  try {
    const dir = process.env.PUPPETEER_CACHE_DIR
      || require('path').join(require('os').homedir(), '.cache', 'puppeteer');
    out.cache_dir_checked = dir;
    out.cache_contents = fs.existsSync(dir) ? fs.readdirSync(dir) : ['(directory does not exist)'];
  } catch (e) { out.cache_contents = ['error: ' + e.message]; }
  res.json(out);
});

// ── POST connect — start WhatsApp client ──────────────────────
router.post('/connect', async (req, res) => {
  try {
    await wa.initialize();
    res.json({ success: true, message: 'WhatsApp initialization started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST disconnect ───────────────────────────────────────────
router.post('/disconnect', async (req, res) => {
  try {
    await wa.destroy();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST send message ─────────────────────────────────────────
router.post('/send', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone)   return res.status(400).json({ error: 'Phone number required' });
    if (!message) return res.status(400).json({ error: 'Message required' });

    // Normalise the number WITHOUT assuming Afghanistan — some parents live
    // abroad. Rules:
    //   "+<anything>"   → international, keep as-is (digits only)
    //   "00<country>…"  → international, strip the 00
    //   "07XXXXXXXX"    → local AFG format, 0 → 93
    //   9 bare digits   → local AFG subscriber number, prefix 93
    //   anything else   → assume it already includes a country code
    const raw = String(phone).trim();
    let clean = raw.replace(/\D/g, '');
    if (raw.startsWith('+'))            { /* keep clean as-is */ }
    else if (clean.startsWith('00'))    clean = clean.slice(2);
    else if (clean.startsWith('0'))     clean = '93' + clean.slice(1);
    else if (clean.length === 9)        clean = '93' + clean;

    await wa.sendMessage(clean, message);
    res.json({ success: true, phone: clean });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET message templates ─────────────────────────────────────
router.get('/templates', (req, res) => {
  res.json([
    {
      id: 'fee_receipt', name: 'Fee Receipt',
      icon: 'fas fa-receipt', color: '#48d085',
      template: 'Dear {parent_name}, this is to confirm that a fee payment of {amount} AFN has been received for {student_name} ({student_code}) for {month}. Thank you. — Taif High School',
    },
    {
      id: 'absence_alert', name: 'Absence Alert',
      icon: 'fas fa-user-times', color: '#ff7875',
      template: 'Dear {parent_name}, your child {student_name} was absent from school today ({date}). Please contact the school if needed. — Taif High School',
    },
    {
      id: 'appreciation', name: 'Appreciation',
      icon: 'fas fa-star', color: '#ffaa3d',
      template: 'Dear {parent_name}, we are pleased to inform you that {student_name} has shown excellent performance. Well done! — Taif High School',
    },
    {
      id: 'complaint', name: 'Complaint / Notice',
      icon: 'fas fa-exclamation-triangle', color: '#b57dff',
      template: 'Dear {parent_name}, we would like to bring to your attention an issue regarding {student_name}. Please visit the school at your earliest convenience. — Taif High School',
    },
    {
      id: 'custom', name: 'Custom Message',
      icon: 'fas fa-pen', color: '#5b9ef7',
      template: '',
    },
  ]);
});

// ── POST send absence alerts (bulk) ──────────────────────────
router.post('/send-absence-alerts', async (req, res) => {
  try {
    const today = kabulTodayISO();
    const { class_id } = req.body;

    // Use the second parent number as fallback when the primary is empty
    let query = `
      SELECT s.first_name, s.last_name,
             COALESCE(s.parent_phone, s.parent_phone2) AS parent_phone,
             s.student_code, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.is_active = true
      AND COALESCE(s.parent_phone, s.parent_phone2) IS NOT NULL
      AND s.id NOT IN (
        SELECT person_id FROM attendance
        WHERE scan_date = $1 AND person_type = 'student'
      )
    `;
    const params = [today];
    if (class_id) { params.push(class_id); query += ` AND s.class_id = $${params.length}`; }

    const result = await pool.query(query, params);
    res.json({
      count:    result.rows.length,
      students: result.rows,
      message:  `${result.rows.length} absence alerts ready to send`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk send ─────────────────────────────────────────────────
// The office picks a category — everyone absent today, one class,
// everyone — and the school's own paired phone sends to all of those
// parents. Previously the browser opened one wa.me window per parent and
// somebody pressed Enter each time.
//
// Sending runs as a BACKGROUND JOB, not inside the HTTP request. A hundred
// parents at roughly two seconds apart is several minutes; no request
// survives that, and a dropped connection must never mean half the school
// gets messaged twice. The browser starts the job, then polls its progress.
//
// One job at a time, held in memory. If the process restarts mid-run the job
// is gone — the results list says exactly who had already been sent to.

let job = null;   // { running, total, sent, failed, cancelled, started_at, results[] }

function jobSnapshot() {
  if (!job) return { running: false, total: 0, sent: 0, failed: 0, results: [] };
  return {
    running:    job.running,
    cancelled:  job.cancelled,
    total:      job.total,
    sent:       job.sent,
    failed:     job.failed,
    current:    job.current || null,
    started_at: job.started_at,
    results:    job.results,
  };
}

// Normalise a number the way POST /send does, so both paths agree.
//
// Real data is messier than the form suggests. Some records hold TWO numbers
// in one field — "+93782766292 - 777246898" — which naively stripped of
// punctuation becomes a 20-digit number that belongs to nobody. Take the
// first number in the field; the second is what parent_phone2 is for.
function normalisePhone(phone) {
  let raw = String(phone || '').trim();
  const first = raw.split(/[,;/]|\s+-\s+|\s+و\s+|\n/)[0].trim();
  if (first) raw = first;

  let clean = raw.replace(/\D/g, '');
  if (raw.startsWith('+'))         { /* already international */ }
  else if (clean.startsWith('00')) clean = clean.slice(2);
  else if (clean.startsWith('0'))  clean = '93' + clean.slice(1);
  else if (clean.length === 9)     clean = '93' + clean;
  return clean;
}

// A number worth trying. E.164 allows at most 15 digits and no real number is
// under 10, so this rejects the "+93" stubs and the two-numbers-in-one-field
// wrecks rather than sending a message into nowhere.
function usablePhone(clean) {
  return /^\d{10,15}$/.test(clean);
}

// Who a category means. Only students with a usable parent number come back,
// and the second parent number is the fallback when the first is blank.
async function resolveRecipients(target, opts = {}) {
  const t = (target && target.type) || 'all';
  const base = `
    SELECT s.id, s.first_name, s.last_name, s.student_code, s.parent_name,
           COALESCE(NULLIF(s.parent_phone, ''), s.parent_phone2) AS phone,
           c.name AS class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
     WHERE s.is_active = TRUE
       AND COALESCE(NULLIF(s.parent_phone, ''), s.parent_phone2) IS NOT NULL`;

  const params = [];
  let sql = base;

  if (t === 'absent') {
    // "Absent" is defined as "did not scan in at the gate today". If NOBODY
    // scanned today, that definition makes every student absent — and the
    // office would tell all 900-odd families their child missed school.
    // Refuse rather than send something that is both wrong and, arriving
    // from one number in one burst, a good way to get that number banned.
    const scans = await pool.query(
      `SELECT COUNT(*)::int AS n FROM attendance
        WHERE scan_date = $1::date AND person_type = 'student'`, [kabulTodayISO()]);
    if (!scans.rows[0].n) {
      throw new Error(
        'No student has been scanned in at the gate today, so the system cannot tell who is absent — everyone would be counted absent. Use the Gate Screen first, or pick a different group.');
    }

    params.push(kabulTodayISO());
    sql += ` AND s.id NOT IN (SELECT person_id FROM attendance
                               WHERE scan_date = $${params.length} AND person_type = 'student')`;
    if (target.class_id) { params.push(target.class_id); sql += ` AND s.class_id = $${params.length}`; }
  } else if (t === 'class') {
    if (!target.class_id) throw new Error('class_id is required for a class message');
    params.push(target.class_id);
    sql += ` AND s.class_id = $${params.length}`;
  } else if (t === 'students') {
    // Named students, chosen one by one. A complaint or a notice is about one
    // child and must never go out to a whole class, let alone every family.
    const ids = (Array.isArray(target.student_ids) ? target.student_ids : [])
      .map(n => parseInt(n, 10)).filter(Number.isFinite);
    if (!ids.length) throw new Error('Choose at least one student first.');
    params.push(ids);
    sql += ` AND s.id = ANY($${params.length}::int[])`;
  } else if (t === 'unpaid') {
    // Parents of students who still owe money. Who owes what is decided by
    // the fee ledger itself, not recalculated here, so a reminder can never
    // quote a different figure from the Fee Collection screen.
    const balances = await computeBalances({});
    const owing = balances.filter(b => b.total_balance > 0).map(b => b.student_id);
    if (!owing.length) return [];
    params.push(owing);
    sql += ` AND s.id = ANY($${params.length}::int[])`;
  } else if (t !== 'all') {
    throw new Error('Unknown recipient category: ' + t);
  }

  sql += ` ORDER BY c.name, s.first_name`;
  const r = await pool.query(sql, params);

  // {date} and {month} in the templates should read as the school writes
  // dates — Shamsi, not the server's Gregorian calendar.
  const nowS = todayShamsi();
  const monthLabel = (SHAMSI_MONTHS[nowS.month] || '') + ' ' + nowS.year;
  const todayLabel = nowS.day + ' ' + monthLabel;

  // {due} in a fee reminder must say what this family actually owes, and it
  // comes from the same ledger the Fee Collection screen reads.
  const dueBy = {};
  try {
    const balances = await computeBalances({});
    balances.forEach(b => { dueBy[b.student_id] = b.total_balance; });
  } catch (_) { /* {due} simply renders as 0 */ }

  return r.rows
    .map(x => ({
      student_id: x.id,
      name: `${x.first_name} ${x.last_name || ''}`.trim(),
      class_name: x.class_name || '',
      parent_name: x.parent_name || '',
      code: x.student_code || '',
      due: dueBy[x.id] || 0,
      today_label: todayLabel,
      month_label: monthLabel,
      phone: normalisePhone(x.phone),
    }))
    .filter(x => opts.keepUnusable || usablePhone(x.phone));
}

// {name} {class} {code} are filled in per parent, so one template greets
// every family by their own child's name.
// Fill in one family's details. Both naming styles are supported: the short
// {name} used in the bulk box, and the longer {student_name} the built-in
// templates were written with — otherwise choosing "Absence Alert" would
// have sent parents the literal text "{parent_name}".
function personalise(message, r) {
  const amount = Math.round(r.due || 0).toLocaleString();
  const map = {
    name:         r.name,
    student_name: r.name,
    parent_name:  r.parent_name || r.name,
    class:        r.class_name,
    class_name:   r.class_name,
    code:         r.code,
    student_code: r.code,
    due:          amount,
    amount:       amount,
    date:         r.today_label || '',
    month:        r.month_label || '',
    school:       (CONFIG && CONFIG.name) || '',
  };
  return String(message || '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key] : whole);
}

// ── GET who a category would reach, without sending ───────────
router.post('/recipients', async (req, res) => {
  try {
    const target = req.body && req.body.target;
    const list = await resolveRecipients(target);

    // How many parents in this group have a number too broken to message.
    // Worth surfacing: the office can only fix what it knows about.
    let unusable = 0;
    try {
      const all = await resolveRecipients(target, { keepUnusable: true });
      unusable = all.length - list.length;
    } catch (_) {}

    res.json({ count: list.length, unusable, recipients: list });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST start a bulk send ────────────────────────────────────
router.post('/send-bulk', async (req, res) => {
  try {
    if (job && job.running) {
      return res.status(409).json({ error: 'A bulk send is already running. Wait for it to finish or cancel it.' });
    }
    const status = wa.getStatus();
    if (!status.connected) {
      return res.status(409).json({
        error: 'WhatsApp is not connected. Open the WhatsApp screen, press Connect and scan the QR code with the school phone.',
      });
    }

    const { message, target, delay_ms } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // An explicit list wins; otherwise resolve the chosen category.
    const list = Array.isArray(req.body.recipients) && req.body.recipients.length
      ? req.body.recipients.map(r => ({
          name: r.name || '', class_name: r.class_name || '', code: r.code || '',
          phone: normalisePhone(r.phone),
        })).filter(r => usablePhone(r.phone))
      : await resolveRecipients(target);

    if (!list.length) return res.status(400).json({ error: 'Nobody in that group has a usable parent number.' });

    // WhatsApp throttles bursts, and a school number getting blocked would be
    // far worse than a slow send. Two seconds apart by default.
    const gap = Math.max(800, Math.min(10000, parseInt(delay_ms) || 2000));

    job = { running: true, cancelled: false, total: list.length, sent: 0, failed: 0,
            current: null, started_at: new Date().toISOString(), results: [] };

    res.json({ started: true, total: list.length, delay_ms: gap });

    // Fire and forget — progress is read from /send-bulk/status.
    (async () => {
      for (const r of list) {
        if (job.cancelled) break;
        job.current = r.name;
        try {
          await wa.sendMessage(r.phone, personalise(message, r));
          job.sent++;
          job.results.push({ name: r.name, phone: r.phone, ok: true });
        } catch (e) {
          job.failed++;
          job.results.push({ name: r.name, phone: r.phone, ok: false, error: e.message });
        }
        if (!job.cancelled) await new Promise(done => setTimeout(done, gap));
      }
      job.running = false;
      job.current = null;
    })();
  } catch (err) {
    if (job) job.running = false;
    res.status(500).json({ error: err.message });
  }
});

// ── GET progress of the running (or last) bulk send ───────────
router.get('/send-bulk/status', (req, res) => res.json(jobSnapshot()));

// ── POST stop the run after the message in flight ─────────────
router.post('/send-bulk/cancel', (req, res) => {
  if (job && job.running) job.cancelled = true;
  res.json(jobSnapshot());
});

module.exports = router;
