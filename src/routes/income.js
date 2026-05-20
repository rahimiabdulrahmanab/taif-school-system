const express = require('express');
const pool    = require('../db.js');
const { toShamsi } = require('../shamsi.js');
const router  = express.Router();

// External income (canteen, rentals, other streams). Filtered by Shamsi
// month/year — we store income_month as a Shamsi "YYYY-MM" key derived
// from the Gregorian income_date so the period dropdown matches the app.
function shamsiKey(dateStr) {
  const d = new Date(dateStr || new Date());
  if (isNaN(d)) return null;
  const s = toShamsi(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return `${s.year}-${String(s.month).padStart(2, '0')}`;
}

// GET /api/income?month=&year=  (Shamsi)
router.get('/', async (req, res) => {
  try {
    const month = parseInt(req.query.month);
    const year  = parseInt(req.query.year);
    if (month && year) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      const r = await pool.query(
        `SELECT * FROM external_income WHERE income_month = $1
          ORDER BY income_date DESC, id DESC`, [key]);
      return res.json(r.rows);
    }
    const r = await pool.query(
      `SELECT * FROM external_income ORDER BY income_date DESC, id DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/income
router.post('/', async (req, res) => {
  try {
    const { title, amount, income_date, note } = req.body;
    if (!title || !amount) return res.status(400).json({ error: 'Title and amount are required' });
    const date = income_date || new Date().toISOString().split('T')[0];
    const r = await pool.query(`
      INSERT INTO external_income (title, amount, income_date, income_month, note)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [title, parseFloat(amount) || 0, date, shamsiKey(date), note || null]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/income/:id
router.put('/:id', async (req, res) => {
  try {
    const { title, amount, income_date, note } = req.body;
    const date = income_date || new Date().toISOString().split('T')[0];
    const r = await pool.query(`
      UPDATE external_income SET
        title = $1, amount = $2, income_date = $3, income_month = $4, note = $5
      WHERE id = $6 RETURNING *
    `, [title, parseFloat(amount) || 0, date, shamsiKey(date), note || null, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/income/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM external_income WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
