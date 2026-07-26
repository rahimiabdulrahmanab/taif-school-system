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

module.exports = router;
