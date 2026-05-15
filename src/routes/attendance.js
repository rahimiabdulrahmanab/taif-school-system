const express = require('express');
const pool    = require('../db.js');
const { shamsiMonthRange, workingDaysBetween } = require('../shamsi.js');
const router  = express.Router();

// ── GET attendance for a date (default today) ─────────────────
router.get('/', async (req, res) => {
  try {
    const { date, class_id, person_type } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    let query = `
      SELECT
        a.*,
        CASE
          WHEN a.person_type = 'student' THEN s.first_name
          WHEN a.person_type = 'teacher' THEN t.first_name
          ELSE st.first_name
        END AS first_name,
        CASE
          WHEN a.person_type = 'student' THEN s.last_name
          WHEN a.person_type = 'teacher' THEN t.last_name
          ELSE st.last_name
        END AS last_name,
        CASE
          WHEN a.person_type = 'student' THEN s.student_code
          WHEN a.person_type = 'teacher' THEN t.teacher_code
          ELSE st.staff_code
        END AS person_code,
        CASE
          WHEN a.person_type = 'student' THEN s.photo
          WHEN a.person_type = 'teacher' THEN t.photo
          ELSE st.photo
        END AS photo,
        c.name AS class_name
      FROM attendance a
      LEFT JOIN students s  ON a.person_type = 'student' AND s.id = a.person_id
      LEFT JOIN teachers t  ON a.person_type = 'teacher' AND t.id = a.person_id
      LEFT JOIN staff    st ON a.person_type = 'staff'   AND st.id = a.person_id
      LEFT JOIN classes  c  ON c.id = s.class_id
      WHERE a.scan_date = $1
    `;
    const params = [targetDate];

    if (person_type) { params.push(person_type); query += ` AND a.person_type = $${params.length}`; }
    if (class_id)    { params.push(class_id);    query += ` AND s.class_id = $${params.length}`; }

    query += ` ORDER BY a.scan_time DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/attendance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST scan — record a QR scan ─────────────────────────────
router.post('/scan', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code provided' });

    const today = new Date().toISOString().split('T')[0];
    let person = null;
    let person_type = null;

    // Check students
    const stuRes = await pool.query(`
      SELECT s.*, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.student_code = $1 OR s.barcode = $1
    `, [code]);
    if (stuRes.rows.length) { person = stuRes.rows[0]; person_type = 'student'; }

    // Check teachers
    if (!person) {
      const tchRes = await pool.query(
        `SELECT * FROM teachers WHERE teacher_code = $1 OR barcode = $1`, [code]
      );
      if (tchRes.rows.length) { person = tchRes.rows[0]; person_type = 'teacher'; }
    }

    // Check staff
    if (!person) {
      const stfRes = await pool.query(
        `SELECT * FROM staff WHERE staff_code = $1 OR barcode = $1`, [code]
      );
      if (stfRes.rows.length) { person = stfRes.rows[0]; person_type = 'staff'; }
    }

    if (!person) return res.status(404).json({ error: 'Person not found', code });

    // Check if already scanned today
    const existing = await pool.query(
      `SELECT id FROM attendance WHERE person_id = $1 AND person_type = $2 AND scan_date = $3`,
      [person.id, person_type, today]
    );

    let alreadyScanned = false;
    if (existing.rows.length) {
      alreadyScanned = true;
    } else {
      await pool.query(
        `INSERT INTO attendance (person_id, person_type, scan_date, scan_time)
         VALUES ($1, $2, $3, NOW())`,
        [person.id, person_type, today]
      );
    }

    // Return full info for gate screen
    res.json({
      success:       true,
      already_scanned: alreadyScanned,
      person_type,
      id:            person.id,
      first_name:    person.first_name,
      last_name:     person.last_name,
      person_code:   person.student_code || person.teacher_code || person.staff_code,
      photo:         person.photo,
      class_name:    person.class_name || person.subject || person.role || null,
    });
  } catch (err) {
    console.error('POST /api/attendance/scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET absent people (students / teachers / staff) ───────────
router.get('/absent', async (req, res) => {
  try {
    const { class_id, person_type, date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    const type = person_type || 'student';

    let query, params;

    if (type === 'teacher') {
      query = `
        SELECT t.id, t.first_name, t.last_name, t.teacher_code AS person_code,
               t.photo, t.subject AS class_name, t.phone, 'teacher' AS person_type
        FROM teachers t
        WHERE t.is_active = true
        AND t.id NOT IN (
          SELECT person_id FROM attendance
          WHERE scan_date = $1 AND person_type = 'teacher'
        )
        ORDER BY t.first_name
      `;
      params = [targetDate];

    } else if (type === 'staff') {
      query = `
        SELECT st.id, st.first_name, st.last_name, st.staff_code AS person_code,
               st.photo, st.role AS class_name, st.phone, 'staff' AS person_type
        FROM staff st
        WHERE st.is_active = true
        AND st.id NOT IN (
          SELECT person_id FROM attendance
          WHERE scan_date = $1 AND person_type = 'staff'
        )
        ORDER BY st.first_name
      `;
      params = [targetDate];

    } else {
      // Default: students
      query = `
        SELECT s.id, s.first_name, s.last_name, s.student_code AS person_code,
               s.photo, s.parent_phone, c.name AS class_name, 'student' AS person_type
        FROM students s
        LEFT JOIN classes c ON c.id = s.class_id
        WHERE s.is_active = true
        AND s.id NOT IN (
          SELECT person_id FROM attendance
          WHERE scan_date = $1 AND person_type = 'student'
        )
      `;
      params = [targetDate];
      if (class_id) { params.push(class_id); query += ` AND s.class_id = $${params.length}`; }
      query += ` ORDER BY c.name, s.first_name`;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET monthly attendance summary ────────────────────────────
router.get('/monthly', async (req, res) => {
  try {
    const { student_id, month, year } = req.query;
    const m = month || new Date().getMonth() + 1;
    const y = year  || new Date().getFullYear();

    const result = await pool.query(`
      SELECT scan_date, scan_time
      FROM attendance
      WHERE person_id = $1 AND person_type = 'student'
        AND EXTRACT(MONTH FROM scan_date) = $2
        AND EXTRACT(YEAR  FROM scan_date) = $3
      ORDER BY scan_date
    `, [student_id, m, y]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET monthly staff/teacher attendance summary ──────────────
// For a Shamsi pay month: each teacher/staff with auto-counted scan days,
// the admin's saved present-days (if any), and working-day context.
router.get('/staff-monthly', async (req, res) => {
  try {
    const { month, year, person_type } = req.query;
    const m = parseInt(month) || (new Date().getMonth() + 1);
    const y = parseInt(year)  || new Date().getFullYear();
    const payMonth = `${y}-${String(m).padStart(2, '0')}`;

    // Shamsi month → Gregorian range
    const range = shamsiMonthRange(y, m);
    const workingDaysInMonth = workingDaysBetween(range.start, range.end);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const elapsedEnd = today < range.end ? today : range.end;
    const elapsedWorkingDays = today < range.start ? 0 : workingDaysBetween(range.start, elapsedEnd);

    // Active teachers + staff
    const teachers = await pool.query(
      `SELECT id, first_name, last_name, teacher_code AS code, photo, 'teacher' AS person_type
         FROM teachers WHERE is_active = true ORDER BY first_name`
    );
    const staff = await pool.query(
      `SELECT id, first_name, last_name, staff_code AS code, photo, 'staff' AS person_type
         FROM staff WHERE is_active = true ORDER BY first_name`
    );
    let people = [...teachers.rows, ...staff.rows];
    if (person_type === 'teacher') people = teachers.rows;
    if (person_type === 'staff')   people = staff.rows;

    // Auto scan counts for the month
    const attRes = await pool.query(
      `SELECT person_id, person_type, COUNT(DISTINCT scan_date)::int AS scanned_days
         FROM attendance
        WHERE scan_date >= $1 AND scan_date <= $2
          AND person_type IN ('teacher','staff')
        GROUP BY person_id, person_type`,
      [range.startISO, range.endISO]
    );
    const scanMap = {};
    attRes.rows.forEach(r => { scanMap[`${r.person_type}-${r.person_id}`] = r.scanned_days; });

    // Saved admin overrides for this month
    const ovRes = await pool.query(
      `SELECT person_id, person_type, present_days
         FROM staff_monthly_attendance WHERE pay_month = $1`,
      [payMonth]
    );
    const ovMap = {};
    ovRes.rows.forEach(r => { ovMap[`${r.person_type}-${r.person_id}`] = r.present_days; });

    const rows = people.map(p => {
      const key = `${p.person_type}-${p.id}`;
      const scannedDays = scanMap[key] || 0;
      const hasOverride = Object.prototype.hasOwnProperty.call(ovMap, key);
      // Default rules (matches payroll):
      //   • admin override saved   → use it
      //   • some scan data exists  → use scan count
      //   • NO scan data at all    → assume present every elapsed day
      //     (the gate isn't being used for this person — don't penalize)
      const presentDays = hasOverride
        ? ovMap[key]
        : (scannedDays === 0 ? elapsedWorkingDays : scannedDays);
      const absentDays  = Math.max(0, workingDaysInMonth - presentDays);
      return {
        id: p.id,
        person_type: p.person_type,
        code: p.code,
        first_name: p.first_name,
        last_name: p.last_name,
        photo: p.photo,
        scanned_days: scannedDays,        // auto from gate scans (reference)
        present_days: presentDays,        // admin-confirmed, scan count, or assumed
        absent_days: absentDays,
        has_override: hasOverride,
      };
    });

    res.json({
      period: { month: m, year: y, pay_month: payMonth },
      working_days_month: workingDaysInMonth,
      elapsed_working_days: elapsedWorkingDays,
      rows,
    });
  } catch (err) {
    console.error('GET /api/attendance/staff-monthly error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST save admin-confirmed present-days for a month ────────
// Body: { month, year, entries: [{ person_id, person_type, present_days }] }
router.post('/staff-monthly', async (req, res) => {
  try {
    const { month, year, entries } = req.body;
    const m = parseInt(month), y = parseInt(year);
    if (!m || !y || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'month, year and entries[] are required' });
    }
    const payMonth = `${y}-${String(m).padStart(2, '0')}`;

    for (const e of entries) {
      const pid = parseInt(e.person_id);
      const ptype = e.person_type === 'staff' ? 'staff' : 'teacher';
      const present = Math.max(0, parseInt(e.present_days, 10) || 0);
      if (!pid) continue;
      await pool.query(`
        INSERT INTO staff_monthly_attendance (person_type, person_id, pay_month, present_days, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (person_type, person_id, pay_month)
        DO UPDATE SET present_days = $4, updated_at = NOW()
      `, [ptype, pid, payMonth, present]);
    }

    res.json({ success: true, saved: entries.length });
  } catch (err) {
    console.error('POST /api/attendance/staff-monthly error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;