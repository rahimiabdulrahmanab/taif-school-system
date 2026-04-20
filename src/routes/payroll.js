const express = require('express');
const pool    = require('../db.js');
const router  = express.Router();

// ── GET payroll list for a month/year ────────────────────────
router.get('/', async (req, res) => {
  try {
    const { month, year, person_type } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const payMonth = `${y}-${String(m).padStart(2,'0')}`;

    // Get all active teachers and staff
    const teachers = await pool.query(`SELECT id, first_name, last_name, teacher_code as code, monthly_salary, photo, 'teacher' as person_type FROM teachers WHERE is_active = true ORDER BY first_name`);
    const staff    = await pool.query(`SELECT id, first_name, last_name, staff_code as code, monthly_salary, photo, 'staff' as person_type FROM staff WHERE is_active = true ORDER BY first_name`);

    let people = [...teachers.rows, ...staff.rows];
    if (person_type === 'teacher') people = teachers.rows;
    if (person_type === 'staff')   people = staff.rows;

    // Get existing payroll records for this month
    const payrollRes = await pool.query(
      `SELECT * FROM payroll WHERE pay_month = $1`, [payMonth]
    );
    const payrollMap = {};
    payrollRes.rows.forEach(p => { payrollMap[`${p.person_type}-${p.person_id}`] = p; });

    // Get advances for this month
    const advRes = await pool.query(
      `SELECT * FROM payroll_advances WHERE pay_month = $1`, [payMonth]
    );
    const advMap = {};
    advRes.rows.forEach(a => { advMap[`${a.person_type}-${a.person_id}`] = a; });

    const result = people.map(p => {
      const key     = `${p.person_type}-${p.id}`;
      const payroll = payrollMap[key] || null;
      const advance = advMap[key] || null;
      const salary  = parseFloat(p.monthly_salary) || 0;
      const advAmt  = advance ? parseFloat(advance.amount) : 0;
      const netSalary = salary - advAmt;

      return {
        ...p,
        salary,
        advance_amount: advAmt,
        advance_id:     advance?.id || null,
        net_salary:     Math.max(0, netSalary),
        payroll_id:     payroll?.id || null,
        is_paid:        !!payroll,
        paid_date:      payroll?.paid_date || null,
        notes:          payroll?.notes || '',
      };
    });

    res.json(result);
  } catch (err) {
    console.error('GET /api/payroll error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST mark salary as paid ──────────────────────────────────
router.post('/pay', async (req, res) => {
  try {
    const { person_id, person_type, amount, month, year, payment_method, notes } = req.body;
    const payMonth = `${year}-${String(month).padStart(2,'0')}`;

    // Check not already paid
    const exists = await pool.query(
      `SELECT id FROM payroll WHERE person_id=$1 AND person_type=$2 AND pay_month=$3`,
      [person_id, person_type, payMonth]
    );
    if (exists.rows.length) return res.status(400).json({ error: 'Already paid for this month' });

    // Get person salary info
    let salaryRes;
    if (person_type === 'teacher') {
      salaryRes = await pool.query(`SELECT monthly_salary FROM teachers WHERE id=$1`, [person_id]);
    } else {
      salaryRes = await pool.query(`SELECT monthly_salary FROM staff WHERE id=$1`, [person_id]);
    }
    const baseSalary = parseFloat(salaryRes.rows[0]?.monthly_salary) || 0;

    // Get advance
    const advRes = await pool.query(
      `SELECT amount FROM payroll_advances WHERE person_id=$1 AND person_type=$2 AND pay_month=$3`,
      [person_id, person_type, payMonth]
    );
    const advAmt = advRes.rows.length ? parseFloat(advRes.rows[0].amount) : 0;

    const result = await pool.query(`
      INSERT INTO payroll (person_id, person_type, pay_month, base_salary, advance_taken, net_salary, is_paid, paid_date, deduction_amount, absent_days)
      VALUES ($1,$2,$3,$4,$5,$6,true,NOW(),0,0) RETURNING *
    `, [person_id, person_type, payMonth, baseSalary, advAmt, amount]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/payroll/pay error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE undo payment ───────────────────────────────────────
router.delete('/pay/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM payroll WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST give advance ─────────────────────────────────────────
router.post('/advance', async (req, res) => {
  try {
    const { person_id, person_type, amount, month, year, notes } = req.body;
    const payMonth = `${year}-${String(month).padStart(2,'0')}`;

    const exists = await pool.query(
      `SELECT id FROM payroll_advances WHERE person_id=$1 AND person_type=$2 AND pay_month=$3`,
      [person_id, person_type, payMonth]
    );

    if (exists.rows.length) {
      await pool.query(
        `UPDATE payroll_advances SET amount=$1, notes=$2 WHERE id=$3`,
        [amount, notes||null, exists.rows[0].id]
      );
    } else {
      await pool.query(`
        INSERT INTO payroll_advances (person_id, person_type, amount, pay_month, notes, advance_date)
        VALUES ($1,$2,$3,$4,$5,NOW())
      `, [person_id, person_type, amount, payMonth, notes||null]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/payroll/advance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE remove advance ─────────────────────────────────────
router.delete('/advance/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM payroll_advances WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;