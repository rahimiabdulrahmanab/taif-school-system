const express = require('express');
const pool    = require('../db.js');
const CONFIG  = require('../../school-config.js');
const { toShamsi } = require('../shamsi.js');
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

    // ─── Outstanding months (with partial-payment tracking) ───────────
    // payment_year/payment_month in the DB are Shamsi values.
    // For each Shamsi month from enrollment → now we compute:
    //   amount  = effective monthly fee
    //   paid    = SUM of all payments tagged with that year-month
    //   balance = max(0, amount − paid)
    //   status  = 'paid' | 'partial' | 'unpaid'
    // The `outstanding` list returned to the UI keeps only partial + unpaid.

    // Today in Shamsi
    const now = new Date();
    const cur = toShamsi(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const curYear  = cur.year;    // e.g. 1405
    const curMonth = cur.month;   // e.g. 2 (ثور)

    // Enrollment in Shamsi (fallback: 12 months back if enrolled_at is missing)
    let startYear, startMonth;
    if (s.enrolled_at) {
      const e = new Date(s.enrolled_at);
      const eShamsi = toShamsi(e.getFullYear(), e.getMonth() + 1, e.getDate());
      startYear  = eShamsi.year;
      startMonth = eShamsi.month;
    } else {
      startYear = curYear; startMonth = curMonth - 11;
      if (startMonth <= 0) { startMonth += 12; startYear -= 1; }
    }

    // Safety: never look back more than 60 months even if enrolled_at is ancient
    {
      const totalMonths = (curYear - startYear) * 12 + (curMonth - startMonth);
      if (totalMonths > 60) {
        const maxBack = 59;
        startYear  = curYear;
        startMonth = curMonth - maxBack;
        while (startMonth <= 0) { startMonth += 12; startYear -= 1; }
      }
    }

    // Sum payments per Shamsi month
    const paidByMonth = {};
    payments.rows.forEach(p => {
      const key = `${p.payment_year}-${p.payment_month}`;
      paidByMonth[key] = (paidByMonth[key] || 0) + parseFloat(p.amount || 0);
    });

    // Walk forward from enrollment to now, building the outstanding list
    // (only unpaid + partial; fully paid months are still visible via the
    // payment history block on the same page).
    const outstanding = [];
    let y = startYear, m = startMonth;
    while (y < curYear || (y === curYear && m <= curMonth)) {
      const key  = `${y}-${m}`;
      const paid = +(paidByMonth[key] || 0).toFixed(2);
      const balance = Math.max(0, +(effectiveFee - paid).toFixed(2));
      if (balance > 0) {
        outstanding.push({
          year:    y,
          month:   m,
          amount:  effectiveFee,    // what was owed for this month
          paid:    paid,            // how much paid so far
          balance: balance,         // still owed
          partial: paid > 0,        // true if some money has come in, but not full
          status:  paid > 0 ? 'partial' : 'unpaid',
        });
      }
      m++; if (m > 12) { m = 1; y++; }
    }
    // Newest first so the current month surfaces at the top
    outstanding.reverse();

    // ─── Previous (legacy) debt — carry-forward from before enrollment ───
    // Sum payments flagged as legacy via is_previous_debt
    const prevDebtOriginal = Math.max(0, parseFloat(s.previous_debt) || 0);
    const prevDebtPaid     = payments.rows
      .filter(p => p.is_previous_debt === true)
      .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const prevDebtBalance  = Math.max(0, +(prevDebtOriginal - prevDebtPaid).toFixed(2));

    res.json({
      student:        s,
      effective_fee:  effectiveFee,
      payments:       payments.rows,
      outstanding,                                                  // all unpaid + partial back to enrollment
      total_paid:     payments.rows.reduce((sum, p) => sum + parseFloat(p.amount), 0),
      total_balance:  outstanding.reduce((sum, o) => sum + o.balance, 0) + prevDebtBalance,
      previous_debt:         prevDebtOriginal,    // original legacy debt on the student record
      previous_debt_paid:    prevDebtPaid,         // sum of payments tagged as legacy
      previous_debt_balance: prevDebtBalance,      // what's still owed from before enrollment
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST record a payment ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      student_id, amount, payment_month, payment_year,
      payment_method, notes, months_paid, is_previous_debt,
    } = req.body;

    if (!student_id || !amount) return res.status(400).json({ error: 'Student and amount are required' });

    // ── Legacy-debt payment: not tied to a specific month ──
    if (is_previous_debt) {
      const r = await pool.query(`
        INSERT INTO fee_payments
          (student_id, amount, amount_paid, payment_month, payment_year, payment_method, notes, payment_date, is_previous_debt)
        VALUES ($1, $2, $2, NULL, NULL, $3, $4, NOW(), TRUE)
        RETURNING *
      `, [student_id, parseFloat(amount), payment_method||'cash', notes||null]);
      return res.status(201).json({ success: true, payments: [r.rows[0]] });
    }

    // Pay one or more Shamsi months. Multiple partial payments to the SAME
    // month are allowed — they accumulate on the student's monthly balance.
    const monthsList = months_paid || [{ month: payment_month, year: payment_year }];
    const results = [];

    // If multiple months are selected, split the amount evenly across them.
    // (For partial payments on a single month, the admin just selects 1 month
    // and types the partial amount — that goes in as-is.)
    const total       = parseFloat(amount);
    const perMonth    = monthsList.length > 0 ? (total / monthsList.length) : total;
    const perMonthAmt = Math.round(perMonth * 100) / 100;

    for (const m of monthsList) {
      const r = await pool.query(`
        INSERT INTO fee_payments
          (student_id, amount, amount_paid, payment_month, payment_year, payment_method, notes, payment_date)
        VALUES ($1,$2,$2,$3,$4,$5,$6,NOW())
        RETURNING *
      `, [student_id, perMonthAmt, m.month, m.year, payment_method||'cash', notes||null]);
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