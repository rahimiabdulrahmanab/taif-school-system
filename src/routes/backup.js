const express = require('express');
const pool    = require('../db.js');
const router  = express.Router();

// Tables cleared by "Wipe All Data". admin_users and settings are kept on
// purpose so the school can still log in and keeps its configuration.
const WIPE_TABLES = [
  'fee_payments',
  'attendance',
  'marks',
  'payroll_advances',
  'payroll',
  'office_expenses',
  'staff_monthly_attendance',
  'student_unpaid_history',
  'class_teachers',
  'subjects',
  'students',
  'teachers',
  'staff',
  'classes',
];

// ── POST /api/backup/wipe — delete all school data ────────────
router.post('/wipe', async (req, res) => {
  try {
    if (req.body.confirm !== 'WIPE ALL DATA') {
      return res.status(400).json({ error: 'Confirmation text does not match.' });
    }

    // Only truncate tables that actually exist (schema differs across DBs).
    const existing = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [WIPE_TABLES]
    );
    const tables = existing.rows.map(r => r.table_name);

    if (tables.length) {
      // RESTART IDENTITY resets SERIAL counters; CASCADE clears any dependent
      // rows in tables not listed above.
      const list = tables.map(t => `"${t}"`).join(', ');
      await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }

    res.json({ success: true, wiped: tables });
  } catch (err) {
    console.error('POST /api/backup/wipe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
