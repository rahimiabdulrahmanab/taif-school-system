const express = require('express');
const pool    = require('../db.js');
const wa      = require('../whatsapp-client');
const { kabulTodayISO } = require('../shamsi.js');
const router  = express.Router();

// ── GET status ────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json(wa.getStatus());
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
function normalisePhone(phone) {
  const raw = String(phone || '').trim();
  let clean = raw.replace(/\D/g, '');
  if (raw.startsWith('+'))         { /* already international */ }
  else if (clean.startsWith('00')) clean = clean.slice(2);
  else if (clean.startsWith('0'))  clean = '93' + clean.slice(1);
  else if (clean.length === 9)     clean = '93' + clean;
  return clean;
}

// Who a category means. Only students with a usable parent number come back,
// and the second parent number is the fallback when the first is blank.
async function resolveRecipients(target) {
  const t = (target && target.type) || 'all';
  const base = `
    SELECT s.id, s.first_name, s.last_name, s.student_code,
           COALESCE(NULLIF(s.parent_phone, ''), s.parent_phone2) AS phone,
           c.name AS class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
     WHERE s.is_active = TRUE
       AND COALESCE(NULLIF(s.parent_phone, ''), s.parent_phone2) IS NOT NULL`;

  const params = [];
  let sql = base;

  if (t === 'absent') {
    // Nobody scanned in at the gate today.
    params.push(kabulTodayISO());
    sql += ` AND s.id NOT IN (SELECT person_id FROM attendance
                               WHERE scan_date = $${params.length} AND person_type = 'student')`;
    if (target.class_id) { params.push(target.class_id); sql += ` AND s.class_id = $${params.length}`; }
  } else if (t === 'class') {
    if (!target.class_id) throw new Error('class_id is required for a class message');
    params.push(target.class_id);
    sql += ` AND s.class_id = $${params.length}`;
  } else if (t !== 'all') {
    throw new Error('Unknown recipient category: ' + t);
  }

  sql += ` ORDER BY c.name, s.first_name`;
  const r = await pool.query(sql, params);
  return r.rows
    .map(x => ({
      student_id: x.id,
      name: `${x.first_name} ${x.last_name || ''}`.trim(),
      class_name: x.class_name || '',
      code: x.student_code || '',
      phone: normalisePhone(x.phone),
    }))
    .filter(x => x.phone.length >= 10);
}

// {name} {class} {code} are filled in per parent, so one template greets
// every family by their own child's name.
function personalise(message, r) {
  return String(message || '')
    .replace(/\{name\}/g,  r.name)
    .replace(/\{class\}/g, r.class_name)
    .replace(/\{code\}/g,  r.code);
}

// ── GET who a category would reach, without sending ───────────
router.post('/recipients', async (req, res) => {
  try {
    const list = await resolveRecipients(req.body && req.body.target);
    res.json({ count: list.length, recipients: list });
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
        })).filter(r => r.phone.length >= 10)
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
