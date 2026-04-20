const express = require('express');
const pool    = require('../db.js');
const CONFIG  = require('../../school-config.js');
const router  = express.Router();

// ── GET all payments (with filters) ──────────────────────────
router.get('/', async (req, res) => {
  try {
    const { student_id, month, year, class_id } = req.query;
    let query = `
      SELECT
        fp.*,
        s.first_name, s.last_name, s.student_code, s.photo,
        s.monthly_fee, s.discount_type, s.discount_value,
        c.name AS class_name
      FROM fee_payments fp
      JOIN students s ON s.id = fp.student_id
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE 1=1
    `;
    const params = [];

    if (student_id) { params.push(student_id); query += ` AND fp.student_id = $${params.length}`; }
    if (month)      { params.push(month);      query += ` AND fp.payment_month = $${params.length}`; }
    if (year)       { params.push(year);        query += ` AND fp.payment_year = $${params.length}`; }
    if (class_id)   { params.push(class_id);    query += ` AND s.class_id = $${params.length}`; }

    query += ` ORDER BY fp.payment_date DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET student fee summary ───────────────────────────────────
router.get('/student/:student_id', async (req, res) => {
  try {
    const { student_id } = req.params;

    const student = await pool.query(`
      SELECT s.*, c.name AS class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.id = $1
    `, [student_id]);

    if (!student.rows.length) return res.status(404).json({ error: 'Student not found' });
    const s = student.rows[0];

    // Calculate effective fee after discount
    let effectiveFee = parseFloat(s.monthly_fee) || 0;
    if (s.discount_type === 'fixed')   effectiveFee = Math.max(0, effectiveFee - parseFloat(s.discount_value));
    if (s.discount_type === 'percent') effectiveFee = effectiveFee * (1 - parseFloat(s.discount_value) / 100);

    // Get all payments
    const payments = await pool.query(
      `SELECT * FROM fee_payments WHERE student_id = $1 ORDER BY payment_year DESC, payment_month DESC`,
      [student_id]
    );

    // Calculate outstanding months
    const currentYear  = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const paidSet = new Set(payments.rows.map(p => `${p.payment_year}-${p.payment_month}`));

    // Check last 12 months for outstanding
    const outstanding = [];
    for (let i = 0; i < 12; i++) {
      let m = currentMonth - i;
      let y = currentYear;
      if (m <= 0) { m += 12; y -= 1; }
      const key = `${y}-${m}`;
      if (!paidSet.has(key)) {
        outstanding.push({ year: y, month: m, amount: effectiveFee });
      }
    }

    res.json({
      student:      s,
      effective_fee: effectiveFee,
      payments:     payments.rows,
      outstanding:  outstanding.slice(0, 6), // show max 6 months outstanding
      total_paid:   payments.rows.reduce((sum, p) => sum + parseFloat(p.amount), 0),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST record a payment ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      student_id, amount, payment_month, payment_year,
      payment_method, notes, months_paid,
    } = req.body;

    if (!student_id || !amount) return res.status(400).json({ error: 'Student and amount are required' });

    // If paying multiple months at once
    const monthsList = months_paid || [{ month: payment_month, year: payment_year }];
    const results = [];

    for (const m of monthsList) {
      // Check not already paid
      const exists = await pool.query(
        `SELECT id FROM fee_payments WHERE student_id=$1 AND payment_month=$2 AND payment_year=$3`,
        [student_id, m.month, m.year]
      );
      if (exists.rows.length) continue; // skip already paid months

      const r = await pool.query(`
        INSERT INTO fee_payments
          (student_id, amount, payment_month, payment_year, payment_method, notes, payment_date)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        RETURNING *
      `, [student_id, amount, m.month, m.year, payment_method||'cash', notes||null]);
      results.push(r.rows[0]);
    }

    res.status(201).json({ success: true, payments: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE a payment ──────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM fee_payments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET monthly summary (total collected) ─────────────────────
router.get('/summary/monthly', async (req, res) => {
  try {
    const { year } = req.query;
    const y = year || new Date().getFullYear();
    const result = await pool.query(`
      SELECT
        payment_month AS month,
        payment_year  AS year,
        COUNT(*)      AS payment_count,
        SUM(amount)   AS total_amount
      FROM fee_payments
      WHERE payment_year = $1
      GROUP BY payment_month, payment_year
      ORDER BY payment_month
    `, [y]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;