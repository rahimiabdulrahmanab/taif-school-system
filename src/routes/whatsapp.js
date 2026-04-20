const express = require('express');
const pool    = require('../db.js');
const router  = express.Router();

// ── In-memory WA session status ───────────────────────────────
// Will be replaced with WA-JS in Part 13 (Electron packaging)
let waConnected = false;
let waQR        = null;

// ── GET status ────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ connected: waConnected, qr: waQR });
});

// ── POST send message ─────────────────────────────────────────
router.post('/send', async (req, res) => {
  try {
    const { phone, message, type, student_id } = req.body;

    if (!phone)   return res.status(400).json({ error: 'Phone number required' });
    if (!message) return res.status(400).json({ error: 'Message required' });

    // Clean phone number
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '93' + cleanPhone.slice(1);
    if (!cleanPhone.startsWith('93')) cleanPhone = '93' + cleanPhone;

    // Log the message attempt (will actually send via WA-JS in Electron)
    console.log(`[WhatsApp] Sending to ${cleanPhone}: ${message.substring(0, 60)}...`);

    // For now simulate success — WA-JS will replace this in Part 13
    // Save to a log table if you want to track sent messages
    res.json({
      success: true,
      phone:   cleanPhone,
      message: 'Message queued — WhatsApp connection required',
      note:    'Full WhatsApp sending will be enabled in the desktop app (Part 13)',
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST send absence alerts (bulk) ──────────────────────────
router.post('/send-absence-alerts', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { class_id } = req.body;

    let query = `
      SELECT s.first_name, s.last_name, s.parent_phone, s.student_code, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.is_active = true
      AND s.parent_phone IS NOT NULL
      AND s.id NOT IN (
        SELECT person_id FROM attendance
        WHERE scan_date = $1 AND person_type = 'student'
      )
    `;
    const params = [today];
    if (class_id) { params.push(class_id); query += ` AND s.class_id = $${params.length}`; }

    const result = await pool.query(query, params);
    const absent = result.rows;

    // Return list of students to send alerts to
    res.json({
      count:   absent.length,
      students: absent,
      message: `${absent.length} absence alerts ready to send`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET message templates ─────────────────────────────────────
router.get('/templates', (req, res) => {
  res.json([
    {
      id:    'fee_receipt',
      name:  'Fee Receipt',
      icon:  'fas fa-receipt',
      color: '#48d085',
      template: 'Dear {parent_name}, this is to confirm that a fee payment of {amount} AFN has been received for {student_name} ({student_code}) for {month}. Thank you. — Taif High School',
    },
    {
      id:    'absence_alert',
      name:  'Absence Alert',
      icon:  'fas fa-user-times',
      color: '#ff7875',
      template: 'Dear {parent_name}, your child {student_name} was absent from school today ({date}). Please contact the school if needed. — Taif High School',
    },
    {
      id:    'appreciation',
      name:  'Appreciation',
      icon:  'fas fa-star',
      color: '#ffaa3d',
      template: 'Dear {parent_name}, we are pleased to inform you that {student_name} has shown excellent performance. Well done! — Taif High School',
    },
    {
      id:    'complaint',
      name:  'Complaint / Notice',
      icon:  'fas fa-exclamation-triangle',
      color: '#b57dff',
      template: 'Dear {parent_name}, we would like to bring to your attention an issue regarding {student_name}. Please visit the school at your earliest convenience. — Taif High School',
    },
    {
      id:    'custom',
      name:  'Custom Message',
      icon:  'fas fa-pen',
      color: '#5b9ef7',
      template: '',
    },
  ]);
});

module.exports = router;