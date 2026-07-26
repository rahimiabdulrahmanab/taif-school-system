const express = require('express');
const pool    = require('../db.js');
const { todayShamsi } = require('../shamsi.js');
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
      // Snapshot admin_users first — admin_users has a FK to teachers, so
      // TRUNCATE ... CASCADE on teachers wipes admin_users too. We restore
      // them right after so the school can still log in. The whole wipe +
      // restore runs in ONE transaction: if the restore fails, the wipe
      // rolls back too, so a crash can never leave the school locked out.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const admins = await client.query(`SELECT * FROM admin_users`);
        const adminCols = admins.fields.map(f => f.name);

        const list = tables.map(t => `"${t}"`).join(', ');
        await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

        // Restore admins (without their teacher_id since teachers were wiped)
        for (const row of admins.rows) {
          const fields = adminCols.filter(c => c !== 'id' && c !== 'teacher_id' && row[c] != null);
          const vals   = fields.map(c => row[c]);
          const phs    = vals.map((_, i) => `$${i + 1}`).join(',');
          await client.query(
            `INSERT INTO admin_users (${fields.join(',')}) VALUES (${phs})
             ON CONFLICT (username) DO NOTHING`,
            vals
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    }

    res.json({ success: true, wiped: tables });
  } catch (err) {
    console.error('POST /api/backup/wipe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/backup/health — live data-health & reconciliation ─
// Everything is computed fresh from the database at request time, so the
// office can verify that what the browser shows is really what's stored.
router.get('/health', async (req, res) => {
  try {
    const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

    // 1. Connectivity proof — DB server time answers "is this live data?"
    const now = await one('SELECT NOW() AS db_time');

    // 2. Row counts per table
    const COUNT_TABLES = [
      'students', 'teachers', 'staff', 'classes', 'subjects',
      'fee_payments', 'payroll', 'payroll_advances', 'payroll_overtime',
      'attendance', 'marks', 'office_expenses', 'external_income', 'admin_users',
    ];
    const counts = {};
    for (const t of COUNT_TABLES) {
      try { counts[t] = parseInt((await one(`SELECT COUNT(*)::int AS c FROM ${t}`)).c); }
      catch (_) { counts[t] = null; }   // table not migrated on this DB
    }

    // 3. Financial reconciliation totals — compare these against the
    //    dashboard / fee page / payroll page figures.
    const sh = todayShamsi();
    const totals = {};
    totals.shamsi_today = `${sh.year}-${sh.month}`;
    totals.fees_collected_all_time = parseFloat((await one(
      `SELECT COALESCE(SUM(amount),0) AS s FROM fee_payments
        WHERE COALESCE(carried_forward, FALSE) = FALSE`)).s);
    totals.fees_collected_this_month = parseFloat((await one(
      `SELECT COALESCE(SUM(amount),0) AS s FROM fee_payments
        WHERE payment_year = $1 AND payment_month = $2
          AND COALESCE(carried_forward, FALSE) = FALSE`,
      [String(sh.year), String(sh.month)])).s);
    totals.opening_debt_billed = parseFloat((await one(
      `SELECT COALESCE(SUM(previous_debt),0) AS s FROM students WHERE is_active = TRUE`)).s);
    totals.opening_debt_paid = parseFloat((await one(
      `SELECT COALESCE(SUM(amount),0) AS s FROM fee_payments
        WHERE COALESCE(is_previous_debt, FALSE) = TRUE`)).s);
    totals.salaries_paid_this_month = parseFloat((await one(
      `SELECT COALESCE(SUM(net_salary),0) AS s FROM payroll WHERE pay_month = $1`,
      [`${sh.year}-${String(sh.month).padStart(2, '0')}`])).s);
    totals.expenses_all_time = parseFloat((await one(
      `SELECT COALESCE(SUM(amount),0) AS s FROM office_expenses`)).s);
    try {
      totals.external_income_all_time = parseFloat((await one(
        `SELECT COALESCE(SUM(amount),0) AS s FROM external_income`)).s);
    } catch (_) { totals.external_income_all_time = null; }

    // 4. Integrity checks — each should be zero; anything else is flagged.
    const checks = [];
    const check = async (name, sql) => {
      try {
        const bad = parseInt((await one(sql)).c);
        checks.push({ name, ok: bad === 0, bad_rows: bad });
      } catch (e) {
        checks.push({ name, ok: false, bad_rows: null, error: e.message });
      }
    };
    await check('payments_pointing_to_missing_student',
      `SELECT COUNT(*)::int AS c FROM fee_payments fp
        LEFT JOIN students s ON s.id = fp.student_id WHERE s.id IS NULL`);
    await check('payments_with_null_or_negative_amount',
      `SELECT COUNT(*)::int AS c FROM fee_payments WHERE amount IS NULL OR amount < 0`);
    await check('duplicate_attendance_same_day',
      `SELECT COUNT(*)::int AS c FROM (
         SELECT person_type, person_id, scan_date FROM attendance
         GROUP BY 1,2,3 HAVING COUNT(*) > 1) d`);
    await check('duplicate_salary_payment_same_month',
      `SELECT COUNT(*)::int AS c FROM (
         SELECT person_type, person_id, pay_month FROM payroll
         GROUP BY 1,2,3 HAVING COUNT(*) > 1) d`);
    await check('students_with_negative_debt',
      `SELECT COUNT(*)::int AS c FROM students WHERE previous_debt < 0`);
    await check('attendance_pointing_to_missing_person',
      `SELECT COUNT(*)::int AS c FROM attendance a
        WHERE (a.person_type = 'student' AND NOT EXISTS (SELECT 1 FROM students t WHERE t.id = a.person_id))
           OR (a.person_type = 'teacher' AND NOT EXISTS (SELECT 1 FROM teachers t WHERE t.id = a.person_id))
           OR (a.person_type = 'staff'   AND NOT EXISTS (SELECT 1 FROM staff    t WHERE t.id = a.person_id))`);
    await check('advances_pointing_to_missing_person',
      `SELECT COUNT(*)::int AS c FROM payroll_advances a
        WHERE (a.person_type = 'teacher' AND NOT EXISTS (SELECT 1 FROM teachers t WHERE t.id = a.person_id))
           OR (a.person_type = 'staff'   AND NOT EXISTS (SELECT 1 FROM staff    t WHERE t.id = a.person_id))`);

    res.json({
      db_time:  now.db_time,
      healthy:  checks.every(c => c.ok),
      counts,
      totals,
      checks,
    });
  } catch (err) {
    console.error('GET /api/backup/health error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Full data dump (shared by the JSON and Excel exports) ─────
// Password hashes are never included.
const EXPORT_TABLES = [
  'students', 'teachers', 'staff', 'classes', 'subjects', 'class_teachers',
  'fee_payments', 'student_month_due', 'student_unpaid_history',
  'payroll', 'payroll_advances', 'payroll_overtime', 'staff_monthly_attendance',
  'attendance', 'marks', 'office_expenses', 'external_income', 'settings',
];

async function buildDump() {
  const dump = {
    exported_at: new Date().toISOString(),
    system: 'Taif School Management System',
    tables: {},
  };
  for (const t of EXPORT_TABLES) {
    try {
      const r = await pool.query(`SELECT * FROM ${t}`);
      dump.tables[t] = r.rows;
    } catch (_) { /* table missing on this DB — skip */ }
  }
  const admins = await pool.query(
    `SELECT id, username, full_name, role, teacher_id, created_at FROM admin_users`);
  dump.tables.admin_users = admins.rows;
  return dump;
}

// ── GET /api/backup/json (alias: /export) — JSON backup ───────
async function sendJsonBackup(req, res) {
  try {
    const dump = await buildDump();
    const stamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename="taif-backup-${stamp}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(dump));
  } catch (err) {
    console.error('GET /api/backup/json error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
router.get('/json',   sendJsonBackup);
router.get('/export', sendJsonBackup);

// ── GET /api/backup/excel — Excel-openable backup ─────────────
// Dependency-free: an HTML document with one table per data table,
// served as .xls — Excel and LibreOffice open it directly.
router.get('/excel', async (req, res) => {
  try {
    const dump = await buildDump();
    const escapeHtml = v => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let body = '';
    for (const [name, rows] of Object.entries(dump.tables)) {
      body += `<h2>${escapeHtml(name)} (${rows.length})</h2>`;
      if (!rows.length) { body += '<p>—</p>'; continue; }
      const cols = Object.keys(rows[0]);
      body += '<table border="1"><tr>' +
        cols.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
      for (const row of rows) {
        body += '<tr>' + cols.map(c => {
          let v = row[c];
          if (v instanceof Date) v = v.toISOString();
          if (v !== null && typeof v === 'object') v = JSON.stringify(v);
          return `<td>${escapeHtml(v)}</td>`;
        }).join('') + '</tr>';
      }
      body += '</table>';
    }

    const html = `<html><head><meta charset="UTF-8"></head><body>
<h1>Taif School Backup — ${escapeHtml(dump.exported_at)}</h1>${body}</body></html>`;

    const stamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename="taif-backup-${stamp}.xls"`);
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=UTF-8');
    res.send(html);
  } catch (err) {
    console.error('GET /api/backup/excel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
