const express = require('express');
const pool    = require('../db.js');
const router  = express.Router();

// ── Student List by Class ─────────────────────────────────────
router.get('/students', async (req, res) => {
  try {
    const { class_id } = req.query;
    let query = `
      SELECT s.*, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
    `;
    const params = [];
    if (class_id) { params.push(class_id); query += ` WHERE s.class_id = $1`; }
    query += ` ORDER BY c.name, s.first_name, s.last_name`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Daily Attendance Report ───────────────────────────────────
router.get('/attendance', async (req, res) => {
  try {
    const { date, class_id } = req.query;
    const d = date || new Date().toISOString().split('T')[0];

    // Present
    let presentQ = `
      SELECT a.*, s.first_name, s.last_name, s.student_code, c.name as class_name
      FROM attendance a
      JOIN students s ON s.id = a.person_id AND a.person_type = 'student'
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE a.scan_date = $1
    `;
    const params = [d];
    if (class_id) { params.push(class_id); presentQ += ` AND s.class_id = $${params.length}`; }
    presentQ += ` ORDER BY c.name, s.first_name`;
    const present = await pool.query(presentQ, params);

    // Absent
    let absentQ = `
      SELECT s.first_name, s.last_name, s.student_code, s.parent_phone, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.id NOT IN (
        SELECT person_id FROM attendance WHERE scan_date=$1 AND person_type='student'
      )
    `;
    const absentParams = [d];
    if (class_id) { absentParams.push(class_id); absentQ += ` AND s.class_id = $${absentParams.length}`; }
    absentQ += ` ORDER BY c.name, s.first_name`;
    const absent = await pool.query(absentQ, absentParams);

    res.json({ date: d, present: present.rows, absent: absent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fee Collection Report ─────────────────────────────────────
router.get('/fees', async (req, res) => {
  try {
    const { month, year, class_id } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();

    let query = `
      SELECT fp.*, s.first_name, s.last_name, s.student_code, s.monthly_fee,
             c.name as class_name
      FROM fee_payments fp
      JOIN students s ON s.id = fp.student_id
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE fp.payment_month = $1 AND fp.payment_year = $2
    `;
    const params = [m, y];
    if (class_id) { params.push(class_id); query += ` AND s.class_id = $${params.length}`; }
    query += ` ORDER BY c.name, s.first_name`;
    const paid = await pool.query(query, params);

    // Unpaid students
    let unpaidQ = `
      SELECT s.first_name, s.last_name, s.student_code, s.monthly_fee,
             s.discount_type, s.discount_value, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.id NOT IN (
        SELECT student_id FROM fee_payments WHERE payment_month=$1 AND payment_year=$2
      )
    `;
    const unpaidParams = [m, y];
    if (class_id) { unpaidParams.push(class_id); unpaidQ += ` AND s.class_id = $${unpaidParams.length}`; }
    unpaidQ += ` ORDER BY c.name, s.first_name`;
    const unpaid = await pool.query(unpaidQ, unpaidParams);

    res.json({
      month: m, year: y,
      paid:   paid.rows,
      unpaid: unpaid.rows,
      total_collected: paid.rows.reduce((s, p) => s + parseFloat(p.amount), 0),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Payroll Report ────────────────────────────────────────────
router.get('/payroll', async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const payMonth = `${y}-${String(m).padStart(2,'0')}`;

    const teachers = await pool.query(`SELECT id, first_name, last_name, teacher_code as code, monthly_salary, 'teacher' as person_type FROM teachers WHERE is_active=true`);
    const staff    = await pool.query(`SELECT id, first_name, last_name, staff_code as code, monthly_salary, 'staff' as person_type FROM staff WHERE is_active=true`);
    const people   = [...teachers.rows, ...staff.rows];

    const payrollRes = await pool.query(`SELECT * FROM payroll WHERE pay_month=$1`, [payMonth]);
    const advRes     = await pool.query(`SELECT * FROM payroll_advances WHERE pay_month=$1`, [payMonth]);
    const payMap = {}; payrollRes.rows.forEach(p => payMap[`${p.person_type}-${p.person_id}`] = p);
    const advMap = {}; advRes.rows.forEach(a => advMap[`${a.person_type}-${a.person_id}`] = a);

    const result = people.map(p => {
      const key    = `${p.person_type}-${p.id}`;
      const salary = parseFloat(p.monthly_salary) || 0;
      const adv    = advMap[key] ? parseFloat(advMap[key].amount) : 0;
      return { ...p, salary, advance: adv, net: salary - adv, is_paid: !!payMap[key] };
    });

    res.json({ month: m, year: y, people: result, total_salary: result.reduce((s,p)=>s+p.salary,0), total_paid: result.filter(p=>p.is_paid).reduce((s,p)=>s+p.net,0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Expense Report ────────────────────────────────────────────
router.get('/expenses', async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const result = await pool.query(`
      SELECT * FROM office_expenses
      WHERE EXTRACT(MONTH FROM expense_date)=$1 AND EXTRACT(YEAR FROM expense_date)=$2
      ORDER BY expense_date DESC
    `, [m, y]);
    const total = result.rows.reduce((s, e) => s + parseFloat(e.amount), 0);
    res.json({ month: m, year: y, expenses: result.rows, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Class Summary Report ──────────────────────────────────────
router.get('/classes', async (req, res) => {
  try {
    const classes = await pool.query(`SELECT * FROM classes ORDER BY name`);
    const result  = await Promise.all(classes.rows.map(async (c) => {
      const students  = await pool.query(`SELECT COUNT(*) as cnt FROM students WHERE class_id=$1`, [c.id]);
      const teachers  = await pool.query(`SELECT COUNT(*) as cnt FROM class_teachers WHERE class_id=$1`, [c.id]);
      const subjects  = await pool.query(`SELECT COUNT(*) as cnt FROM subjects WHERE class_id=$1`, [c.id]);
      return {
        ...c,
        student_count: parseInt(students.rows[0].cnt),
        teacher_count: parseInt(teachers.rows[0].cnt),
        subject_count: parseInt(subjects.rows[0].cnt),
      };
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;