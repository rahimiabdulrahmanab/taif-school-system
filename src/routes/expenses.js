const express = require('express');
const pool    = require('../db.js');
const router  = express.Router();

const CATEGORIES = [
  'Rent', 'Electricity', 'Water', 'Internet', 'Stationery',
  'Maintenance', 'Cleaning', 'Food & Drinks', 'Transport',
  'Equipment', 'Books & Materials', 'Events', 'Other'
];

router.get('/', async (req, res) => {
  try {
    // The app is Shamsi-keyed: the UI converts the selected Shamsi month to a
    // Gregorian date range and sends start_date/end_date. Filter on that range
    // when given. month/year (Gregorian) stays supported for older callers.
    const { month, year, category, start_date, end_date } = req.query;
    let query, params;
    if (start_date && end_date) {
      query  = `SELECT * FROM office_expenses WHERE expense_date >= $1::date AND expense_date <= $2::date`;
      params = [start_date, end_date];
    } else {
      const m = parseInt(month) || new Date().getMonth() + 1;
      const y = parseInt(year)  || new Date().getFullYear();
      query  = `SELECT * FROM office_expenses WHERE EXTRACT(MONTH FROM expense_date)=$1 AND EXTRACT(YEAR FROM expense_date)=$2`;
      params = [m, y];
    }
    if (category) { params.push(category); query += ` AND category=$${params.length}`; }
    query += ` ORDER BY expense_date DESC, id DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/categories', (req, res) => res.json(CATEGORIES));

router.get('/summary', async (req, res) => {
  try {
    const { year } = req.query;
    const y = year || new Date().getFullYear();
    const result = await pool.query(`
      SELECT EXTRACT(MONTH FROM expense_date)::integer AS month,
             category, SUM(amount)::numeric AS total, COUNT(*) AS count
      FROM office_expenses WHERE EXTRACT(YEAR FROM expense_date)=$1
      GROUP BY EXTRACT(MONTH FROM expense_date), category ORDER BY month, category
    `, [y]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { title, amount, category, expense_date, notes, paid_to, bill_no } = req.body;
    if (!title || !amount) return res.status(400).json({ error: 'Title and amount are required' });
    const m = new Date(expense_date || new Date()).toISOString().slice(0,7);
    const result = await pool.query(`
      INSERT INTO office_expenses (description, amount, category, expense_date, expense_month, notes, paid_to, bill_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [title, amount, category||'Other', expense_date||new Date().toISOString().split('T')[0], m,
        notes||null, paid_to||null, bill_no||null]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { title, amount, category, expense_date, notes, paid_to, bill_no } = req.body;
    const m = new Date(expense_date || new Date()).toISOString().slice(0,7);
    const result = await pool.query(`
      UPDATE office_expenses SET description=$1, amount=$2, category=$3, expense_date=$4,
             expense_month=$5, notes=COALESCE($6,notes), paid_to=COALESCE($7,paid_to),
             bill_no=COALESCE($8,bill_no)
      WHERE id=$9 RETURNING *
    `, [title, amount, category, expense_date, m, notes ?? null, paid_to ?? null, bill_no ?? null, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM office_expenses WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;