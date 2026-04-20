const express = require('express');
const pool    = require('../db.js');
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

// ── GET absent students for today ─────────────────────────────
router.get('/absent', async (req, res) => {
  try {
    const { class_id } = req.query;
    const today = new Date().toISOString().split('T')[0];

    let query = `
      SELECT s.id, s.first_name, s.last_name, s.student_code, s.photo,
             s.parent_phone, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.is_active = true
      AND s.id NOT IN (
        SELECT person_id FROM attendance
        WHERE scan_date = $1 AND person_type = 'student'
      )
    `;
    const params = [today];
    if (class_id) { params.push(class_id); query += ` AND s.class_id = $${params.length}`; }
    query += ` ORDER BY c.name, s.first_name`;

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

module.exports = router;