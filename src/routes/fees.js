const express = require('express');
const pool    = require('../db.js');
const CONFIG  = require('../../school-config.js');
const { toShamsi, todayShamsi } = require('../shamsi.js');
const { getHolidayMonths } = require('../holidays.js');
const router  = express.Router();

// Run fn inside a DB transaction. Multi-statement money operations must be
// atomic — a crash halfway through a split payment or a carry-forward would
// otherwise leave the ledger half-applied.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────
//  SIMPLE FEE MODEL
//  Each student has ONE running Total Due (students.previous_debt). The
//  system auto-tracks each Shamsi month from enrolled_at → today.
//
//   • Pay for a month  → fee_payments row tagged (year, month)
//   • Pay against debt → fee_payments row with is_previous_debt = TRUE
//   • Carry forward    → fee_payments marker (carried_forward = TRUE) +
//                        students.previous_debt += effective_fee. The month
//                        no longer shows as outstanding; the debt grew.
// ─────────────────────────────────────────────────────────────────────

// Summer-holiday months are shared with payroll — see src/holidays.js
const getNonBillableMonths = getHolidayMonths;

// Compute the student's effective monthly fee (after discount).
function effectiveFeeOf(s) {
  let fee = parseFloat(s.monthly_fee) || 0;
  if (s.discount_type === 'fixed')   fee = Math.max(0, fee - parseFloat(s.discount_value || 0));
  if (s.discount_type === 'percent') fee = fee * (1 - parseFloat(s.discount_value || 0) / 100);
  return fee;
}

// Convert enrolled_at (or today) → Shamsi (year, month) walk-start.
// Caps lookback at 60 months for safety on ancient enrollment dates.
function walkStart(enrolledAt) {
  const cur = todayShamsi();   // Kabul calendar day, not server-UTC
  let y = cur.year, m = cur.month;
  if (enrolledAt) {
    const e = new Date(enrolledAt);
    if (!isNaN(e)) {
      const eS = toShamsi(e.getFullYear(), e.getMonth() + 1, e.getDate());
      y = eS.year; m = eS.month;
    }
  }
  // Safety cap — never look back more than 60 months
  const elapsed = (cur.year - y) * 12 + (cur.month - m);
  if (elapsed > 60) {
    y = cur.year; m = cur.month - 59;
    while (m <= 0) { m += 12; y -= 1; }
  }
  return { startY: y, startM: m, curY: cur.year, curM: cur.month };
}

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
    if (year)       { params.push(year);       query += ` AND fp.payment_year = $${params.length}`; }
    if (class_id)   { params.push(class_id);   query += ` AND s.class_id = $${params.length}`; }
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
    const s   = student.rows[0];
    const fee = effectiveFeeOf(s);

    const payments = await pool.query(
      `SELECT * FROM fee_payments WHERE student_id = $1 ORDER BY payment_date DESC`,
      [student_id]
    );

    // Aggregate per (year, month). Carried-forward marker rows count as the
    // month being closed (no balance owed), so we track them separately.
    const paidByMonth    = {};
    const carriedMonths  = new Set();
    let debtPaidTotal    = 0;
    payments.rows.forEach(p => {
      if (p.is_previous_debt) {
        debtPaidTotal += parseFloat(p.amount || 0);
        return;
      }
      if (p.payment_year == null || p.payment_month == null) return;
      const key = `${p.payment_year}-${p.payment_month}`;
      if (p.carried_forward) {
        carriedMonths.add(key);
      } else {
        paidByMonth[key] = (paidByMonth[key] || 0) + parseFloat(p.amount || 0);
      }
    });

    // Auto-walk Shamsi months from enrolled_at → now
    const holidayMonths = await getNonBillableMonths();
    const { startY, startM, curY, curM } = walkStart(s.enrolled_at);
    const outstanding = [];
    if (startY < curY || (startY === curY && startM <= curM)) {
      let y = startY, m = startM;
      while (y < curY || (y === curY && m <= curM)) {
        const key = `${y}-${m}`;
        if (!carriedMonths.has(key) && !holidayMonths.has(m)) {
          const paid    = +(paidByMonth[key] || 0).toFixed(2);
          const balance = Math.max(0, +(fee - paid).toFixed(2));
          if (balance > 0) {
            outstanding.push({
              year: y, month: m,
              amount:  fee,
              paid,
              balance,
              partial: paid > 0,
              status:  paid > 0 ? 'partial' : 'unpaid',
            });
          }
        }
        m++; if (m > 12) { m = 1; y++; }
      }
    }
    outstanding.sort((a, b) => (b.year - a.year) || (b.month - a.month));

    // Total Due running balance = students.previous_debt − sum of debt payments
    const totalDueOriginal = Math.max(0, parseFloat(s.previous_debt) || 0);
    const totalDue         = Math.max(0, +(totalDueOriginal - debtPaidTotal).toFixed(2));

    res.json({
      student:       s,
      effective_fee: fee,
      payments:      payments.rows,
      outstanding,
      total_due:           totalDue,         // running debt balance
      total_due_original:  totalDueOriginal, // raw students.previous_debt
      total_due_paid:      debtPaidTotal,    // sum of is_previous_debt payments
      total_paid: payments.rows
        .filter(p => !p.carried_forward)
        .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0),
      // Total exposure: pending monthly + running debt
      total_balance: +(outstanding.reduce((sum, o) => sum + o.balance, 0) + totalDue).toFixed(2),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST record a payment ─────────────────────────────────────
// Body shapes:
//   { student_id, amount, payment_method, notes, is_previous_debt:true }
//     → single payment against the student's Total Due.
//   { student_id, amount, months_paid:[{year,month}, …],
//     payment_method, notes, apply_excess_to_debt:bool }
//     → split `amount` across months. If amount > Σ(monthly_fee × len),
//       the excess either applies to Total Due (apply_excess_to_debt=true)
//       or piles onto the LAST listed month (false).
router.post('/', async (req, res) => {
  try {
    const {
      student_id, amount, payment_month, payment_year,
      payment_method, notes, months_paid, is_previous_debt,
      apply_excess_to_debt,
    } = req.body;

    if (!student_id || !amount) {
      return res.status(400).json({ error: 'Student and amount are required' });
    }

    // ── Debt payment (no month) ──
    if (is_previous_debt) {
      const r = await pool.query(`
        INSERT INTO fee_payments
          (student_id, amount, amount_paid, original_fee,
           payment_month, payment_year, payment_method, notes,
           payment_date, is_previous_debt)
        VALUES ($1, $2, $2, $2, NULL, NULL, $3, $4, NOW(), TRUE)
        RETURNING *
      `, [student_id, parseFloat(amount), payment_method || 'cash', notes || null]);
      return res.status(201).json({ success: true, payments: [r.rows[0]] });
    }

    // ── Monthly payment(s). Optional excess routing to debt. ──
    const monthsList = (Array.isArray(months_paid) && months_paid.length)
      ? months_paid
      : [{ month: payment_month, year: payment_year }];

    // Compute the effective monthly fee so we know what counts as "excess"
    const stuRes = await pool.query(
      `SELECT monthly_fee, discount_type, discount_value FROM students WHERE id = $1`,
      [student_id]
    );
    if (!stuRes.rows.length) return res.status(404).json({ error: 'Student not found' });
    const fee = effectiveFeeOf(stuRes.rows[0]);

    const total       = parseFloat(amount);
    const expected    = +(fee * monthsList.length).toFixed(2);
    const excess      = +(total - expected).toFixed(2);

    const results = await withTx(async (c) => {
      const out = [];
      if (excess > 0 && apply_excess_to_debt) {
        // Pay each selected month at its full fee, then apply leftover to debt.
        for (const m of monthsList) {
          const r = await c.query(`
            INSERT INTO fee_payments
              (student_id, amount, amount_paid, original_fee,
               payment_month, payment_year, payment_method, notes, payment_date)
            VALUES ($1,$2,$2,$2,$3,$4,$5,$6,NOW())
            RETURNING *
          `, [student_id, fee, m.month, m.year, payment_method || 'cash', notes || null]);
          out.push(r.rows[0]);
        }
        const d = await c.query(`
          INSERT INTO fee_payments
            (student_id, amount, amount_paid, original_fee,
             payment_month, payment_year, payment_method, notes,
             payment_date, is_previous_debt)
          VALUES ($1, $2, $2, $2, NULL, NULL, $3, $4, NOW(), TRUE)
          RETURNING *
        `, [student_id, excess, payment_method || 'cash',
            (notes ? notes + ' — ' : '') + 'excess applied to debt']);
        out.push(d.rows[0]);
      } else {
        // No excess routing → split evenly across the selected months.
        const perMonth = monthsList.length > 0 ? (total / monthsList.length) : total;
        const perMonthAmt = Math.round(perMonth * 100) / 100;
        for (const m of monthsList) {
          const r = await c.query(`
            INSERT INTO fee_payments
              (student_id, amount, amount_paid, original_fee,
               payment_month, payment_year, payment_method, notes, payment_date)
            VALUES ($1,$2,$2,$2,$3,$4,$5,$6,NOW())
            RETURNING *
          `, [student_id, perMonthAmt, m.month, m.year,
              payment_method || 'cash', notes || null]);
          out.push(r.rows[0]);
        }
      }
      return out;
    });

    res.status(201).json({ success: true, payments: results, excess });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST carry forward an unpaid month into Total Due ────────
// Adds students.previous_debt += effective_fee AND inserts a marker payment
// (carried_forward = TRUE) so the month no longer shows as outstanding.
router.post('/carry-forward', async (req, res) => {
  try {
    const { student_id, year, month } = req.body;
    if (!student_id || !year || !month) {
      return res.status(400).json({ error: 'student_id, year and month are required' });
    }

    const holidayMonths = await getNonBillableMonths();
    if (holidayMonths.has(parseInt(month))) {
      return res.status(400).json({
        error: 'This month is a school holiday — no fee is charged, so there is nothing to carry forward.',
      });
    }

    const stuRes = await pool.query(
      `SELECT monthly_fee, discount_type, discount_value, previous_debt
         FROM students WHERE id = $1`,
      [student_id]
    );
    if (!stuRes.rows.length) return res.status(404).json({ error: 'Student not found' });
    const fee = effectiveFeeOf(stuRes.rows[0]);

    // What's still owed for that month — only that portion rolls into debt.
    const paidRow = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS paid
        FROM fee_payments
       WHERE student_id = $1 AND payment_year = $2 AND payment_month = $3
         AND COALESCE(is_previous_debt, FALSE) = FALSE
         AND COALESCE(carried_forward,  FALSE) = FALSE
    `, [student_id, year, month]);
    const alreadyPaid = parseFloat(paidRow.rows[0].paid) || 0;
    const remaining   = Math.max(0, +(fee - alreadyPaid).toFixed(2));

    if (remaining <= 0) {
      return res.status(400).json({ error: 'Month is already fully paid' });
    }

    // Marker payment + debt growth must land together or not at all.
    await withTx(async (c) => {
      await c.query(`
        INSERT INTO fee_payments
          (student_id, amount, amount_paid, original_fee,
           payment_month, payment_year, payment_method, notes,
           payment_date, carried_forward)
        VALUES ($1, 0, 0, $2, $3, $4, 'carry', $5, NOW(), TRUE)
      `, [student_id, fee, month, year, `Carried ${remaining} AFN forward to Total Due`]);

      await c.query(
        `UPDATE students SET previous_debt = COALESCE(previous_debt, 0) + $1 WHERE id = $2`,
        [remaining, student_id]
      );
    });

    res.json({ success: true, carried: remaining });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST close a month — bulk carry-forward ──────────────────
// For every active student that still owes for (year, month), roll the
// remaining balance into their Total Due and mark the month closed. Used by
// the "Close Month" button at the end of each Shamsi month.
router.post('/close-month', async (req, res) => {
  try {
    const year  = parseInt(req.body.year);
    const month = parseInt(req.body.month);
    if (!year || !month) {
      return res.status(400).json({ error: 'year and month are required' });
    }

    // Summer-holiday months are never billed, so there is nothing to carry.
    const holidayMonths = await getNonBillableMonths();
    if (holidayMonths.has(month)) {
      return res.json({
        success: true, students_closed: 0, total_carried: 0,
        skipped_holiday: true,
        message: 'This month is a school holiday — no fee is charged, so there is nothing to carry forward.',
      });
    }

    const students = await pool.query(`
      SELECT id, monthly_fee, discount_type, discount_value, enrolled_at
        FROM students WHERE is_active = true
    `);

    let closed = 0;
    let totalCarried = 0;

    for (const s of students.rows) {
      const fee = effectiveFeeOf(s);
      if (fee <= 0) continue;

      // Skip students who weren't expected to pay yet (enrolled after this month)
      const { startY, startM } = walkStart(s.enrolled_at);
      if (year < startY || (year === startY && month < startM)) continue;

      // Already carried for this month?
      const already = await pool.query(`
        SELECT 1 FROM fee_payments
         WHERE student_id = $1 AND payment_year = $2 AND payment_month = $3
           AND carried_forward = TRUE LIMIT 1
      `, [s.id, year, month]);
      if (already.rows.length) continue;

      const paidRow = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS paid FROM fee_payments
         WHERE student_id = $1 AND payment_year = $2 AND payment_month = $3
           AND COALESCE(is_previous_debt, FALSE) = FALSE
           AND COALESCE(carried_forward,  FALSE) = FALSE
      `, [s.id, year, month]);
      const paid      = parseFloat(paidRow.rows[0].paid) || 0;
      const remaining = Math.max(0, +(fee - paid).toFixed(2));
      if (remaining <= 0) continue;

      await withTx(async (c) => {
        await c.query(`
          INSERT INTO fee_payments
            (student_id, amount, amount_paid, original_fee,
             payment_month, payment_year, payment_method, notes,
             payment_date, carried_forward)
          VALUES ($1, 0, 0, $2, $3, $4, 'carry', $5, NOW(), TRUE)
        `, [s.id, fee, month, year, `Carried ${remaining} AFN forward to Total Due`]);

        await c.query(
          `UPDATE students SET previous_debt = COALESCE(previous_debt, 0) + $1 WHERE id = $2`,
          [remaining, s.id]
        );
      });
      closed++;
      totalCarried += remaining;
    }

    res.json({
      success:         true,
      students_closed: closed,
      total_carried:   +totalCarried.toFixed(2),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ACCOUNT-STATEMENT MODEL  (the per-student "bank account")
// ══════════════════════════════════════════════════════════════

// GET /api/fees/statement/:student_id
// Every Shamsi month from enrollment → today, grouped by year
// (newest first), each with due / paid / balance and its payments.
router.get('/statement/:student_id', async (req, res) => {
  try {
    const { student_id } = req.params;
    const sres = await pool.query(
      `SELECT s.*, c.name AS class_name FROM students s
         LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = $1`,
      [student_id]
    );
    if (!sres.rows.length) return res.status(404).json({ error: 'Student not found' });
    const s   = sres.rows[0];
    const fee = effectiveFeeOf(s);

    const cur = todayShamsi();
    let sy = cur.year, sm = cur.month;
    if (s.enrolled_at) {
      const e = new Date(s.enrolled_at);
      if (!isNaN(e)) {
        const es = toShamsi(e.getFullYear(), e.getMonth() + 1, e.getDate());
        sy = es.year; sm = es.month;
      }
    }
    // Safety cap: 240 months (20 years)
    const span = (cur.year - sy) * 12 + (cur.month - sm);
    if (span > 240) { sy = cur.year; sm = cur.month - 239; while (sm <= 0) { sm += 12; sy -= 1; } }

    const pres = await pool.query(
      `SELECT id, amount, payment_year, payment_month, payment_method, notes, payment_date
         FROM fee_payments
        WHERE student_id = $1 AND payment_year IS NOT NULL AND payment_month IS NOT NULL
          AND COALESCE(is_previous_debt,FALSE)=FALSE
          AND COALESCE(carried_forward,FALSE)=FALSE
        ORDER BY payment_date`,
      [student_id]
    );
    const payByKey = {};
    pres.rows.forEach(p => {
      const k = `${p.payment_year}-${p.payment_month}`;
      (payByKey[k] = payByKey[k] || []).push(p);
    });

    const dueByKey = {};
    try {
      const d = await pool.query(
        `SELECT payment_year, payment_month, amount_due, notes
           FROM student_month_due WHERE student_id = $1`, [student_id]);
      d.rows.forEach(r => { dueByKey[`${r.payment_year}-${r.payment_month}`] = r; });
    } catch (_) { /* table not migrated yet */ }

    // Billing-start cutoff. Months on/after it auto-bill the monthly fee;
    // earlier months show in the statement for history but Due = 0 unless
    // the admin explicitly set a due (the "this old month is unpaid" case).
    let cutY = cur.year, cutM = cur.month;
    try {
      const cs = await pool.query(
        `SELECT key, value FROM settings WHERE key IN ('install_year','install_month')`);
      cs.rows.forEach(r => {
        if (r.key === 'install_year'  && parseInt(r.value)) cutY = parseInt(r.value);
        if (r.key === 'install_month' && parseInt(r.value)) cutM = parseInt(r.value);
      });
    } catch (_) {}
    const atOrAfterCutoff = (yy, mm) =>
      (yy > cutY) || (yy === cutY && mm >= cutM);
    const holidayMonths = await getNonBillableMonths();

    const byYear = {};
    let y = cur.year, m = cur.month;
    while (y > sy || (y === sy && m >= sm)) {
      const k = `${y}-${m}`;
      const ov  = dueByKey[k];
      const isHoliday = !ov && holidayMonths.has(m);
      const due = ov ? parseFloat(ov.amount_due)
                     : (isHoliday ? 0 : (atOrAfterCutoff(y, m) ? fee : 0));
      const pays = payByKey[k] || [];
      const paid = +pays.reduce((t, p) => t + parseFloat(p.amount || 0), 0).toFixed(2);
      const balance = +(due - paid).toFixed(2);
      (byYear[y] = byYear[y] || []).push({
        year: y, month: m, due, paid, balance,
        status: isHoliday ? 'holiday'
              : (paid <= 0 ? 'unpaid' : (balance > 0 ? 'partial' : 'paid')),
        holiday: isHoliday,
        due_overridden: !!ov,
        due_note: ov ? ov.notes : null,
        payments: pays,
      });
      m--; if (m < 1) { m = 12; y--; }
    }

    const years = Object.keys(byYear).map(Number).sort((a, b) => b - a).map(yr => {
      const months = byYear[yr];
      const td = months.reduce((t, x) => t + x.due,  0);
      const tp = months.reduce((t, x) => t + x.paid, 0);
      return { year: yr, months,
               total_due: +td.toFixed(2), total_paid: +tp.toFixed(2),
               balance: +(td - tp).toFixed(2) };
    });

    // Opening balance — what the student owed BEFORE joining (the
    // "Previous Total Due" entered at registration). Payments tagged
    // is_previous_debt pay it down. Shown as the statement's first line.
    const openingDue = Math.max(0, parseFloat(s.previous_debt) || 0);
    const opres = await pool.query(
      `SELECT id, amount, payment_method, notes, payment_date
         FROM fee_payments
        WHERE student_id = $1 AND COALESCE(is_previous_debt,FALSE)=TRUE
        ORDER BY payment_date`,
      [student_id]
    );
    const openingPaid = +opres.rows.reduce((t, p) => t + parseFloat(p.amount || 0), 0).toFixed(2);
    const opening = {
      due:      openingDue,
      paid:     openingPaid,
      balance:  +(openingDue - openingPaid).toFixed(2),
      payments: opres.rows,
    };

    const gd = years.reduce((t, y) => t + y.total_due,  0) + openingDue;
    const gp = years.reduce((t, y) => t + y.total_paid, 0) + openingPaid;

    res.json({
      student: s,
      effective_fee: fee,
      opening,
      years,
      grand_total_due:  +gd.toFixed(2),
      grand_total_paid: +gp.toFixed(2),
      grand_balance:    +(gd - gp).toFixed(2),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/fees/due — set/override a single month's due amount
router.post('/due', async (req, res) => {
  try {
    const { student_id, year, month, amount_due, notes } = req.body;
    if (!student_id || !year || !month)
      return res.status(400).json({ error: 'student_id, year and month are required' });
    const r = await pool.query(`
      INSERT INTO student_month_due
        (student_id, payment_year, payment_month, amount_due, notes, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (student_id, payment_year, payment_month)
      DO UPDATE SET amount_due = EXCLUDED.amount_due,
                    notes      = EXCLUDED.notes,
                    updated_at = NOW()
      RETURNING *`,
      [student_id, parseInt(year), parseInt(month),
       Math.max(0, parseFloat(amount_due) || 0), notes || null]);
    res.json({ success: true, due: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/fees/:id — edit an existing payment
// Carry-forward markers must not be edited: their "amount" is 0 by design
// and the carried value already lives in students.previous_debt.
router.put('/:id', async (req, res) => {
  try {
    const row = await pool.query('SELECT carried_forward FROM fee_payments WHERE id = $1', [req.params.id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Payment not found' });
    if (row.rows[0].carried_forward) {
      return res.status(400).json({
        error: 'This row is a carry-forward marker, not a payment. Delete it to undo the carry, or adjust the amount on the Total Due instead.',
      });
    }
    const { amount, payment_method, notes, payment_date } = req.body;
    const amt = (amount != null && amount !== '') ? parseFloat(amount) : null;
    const r = await pool.query(`
      UPDATE fee_payments SET
        amount         = COALESCE($1, amount),
        amount_paid    = COALESCE($1, amount_paid),
        payment_method = COALESCE($2, payment_method),
        notes          = COALESCE($3, notes),
        payment_date   = COALESCE($4::date, payment_date)
      WHERE id = $5
      RETURNING *`,
      [amt, payment_method || null, notes || null, payment_date || null, req.params.id]);
    res.json({ success: true, payment: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE a payment ──────────────────────────────────────────
// Deleting a carry-forward marker is an UNDO of the carry: the month
// reopens as outstanding, so the amount that was rolled into the student's
// Total Due must come back out — otherwise the debt is double-counted.
router.delete('/:id', async (req, res) => {
  try {
    const row = await pool.query(
      'SELECT student_id, carried_forward, notes FROM fee_payments WHERE id = $1',
      [req.params.id]);
    if (!row.rows.length) return res.json({ success: true });

    const p = row.rows[0];
    if (p.carried_forward) {
      const m = /Carried ([\d.]+) AFN/.exec(p.notes || '');
      const carried = m ? parseFloat(m[1]) : NaN;
      if (isNaN(carried)) {
        return res.status(400).json({
          error: 'Cannot undo this carry-forward automatically (amount not recorded). Adjust the student\'s Total Due manually first.',
        });
      }
      await withTx(async (c) => {
        await c.query('DELETE FROM fee_payments WHERE id = $1', [req.params.id]);
        await c.query(
          `UPDATE students SET previous_debt = GREATEST(0, COALESCE(previous_debt,0) - $1) WHERE id = $2`,
          [carried, p.student_id]);
      });
      return res.json({ success: true, undone_carry: carried });
    }

    await pool.query('DELETE FROM fee_payments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET per-student cumulative balances ───────────────────────
router.get('/balances', async (req, res) => {
  try {
    const periodYear  = parseInt(req.query.year);
    const periodMonth = parseInt(req.query.month);

    const cur = todayShamsi();

    const students = await pool.query(`
      SELECT id, monthly_fee, discount_type, discount_value, enrolled_at,
             COALESCE(previous_debt, 0) AS previous_debt
        FROM students WHERE is_active = true
    `);

    // Aggregate non-debt, non-carried payments per (student, year, month)
    const paid = await pool.query(`
      SELECT student_id, payment_year, payment_month, SUM(amount) AS paid
        FROM fee_payments
       WHERE payment_year IS NOT NULL AND payment_month IS NOT NULL
         AND COALESCE(is_previous_debt, FALSE) = FALSE
         AND COALESCE(carried_forward,  FALSE) = FALSE
       GROUP BY student_id, payment_year, payment_month
    `);
    const paidMap = new Map();
    paid.rows.forEach(p => {
      paidMap.set(`${p.student_id}-${p.payment_year}-${p.payment_month}`,
                  parseFloat(p.paid || 0));
    });

    // Carried-forward markers — these months are closed
    const carried = await pool.query(`
      SELECT student_id, payment_year, payment_month
        FROM fee_payments
       WHERE carried_forward = TRUE
         AND payment_year IS NOT NULL AND payment_month IS NOT NULL
    `);
    const carriedSet = new Set();
    carried.rows.forEach(c =>
      carriedSet.add(`${c.student_id}-${c.payment_year}-${c.payment_month}`));

    // Debt payments per student (reduce Total Due running balance)
    const debtPaid = await pool.query(`
      SELECT student_id, SUM(amount) AS paid
        FROM fee_payments
       WHERE is_previous_debt = TRUE
       GROUP BY student_id
    `);
    const debtPaidMap = new Map();
    debtPaid.rows.forEach(d =>
      debtPaidMap.set(d.student_id, parseFloat(d.paid || 0)));

    // Per-month due overrides
    const dueMap = new Map();
    try {
      const dm = await pool.query(
        `SELECT student_id, payment_year, payment_month, amount_due
           FROM student_month_due`);
      dm.rows.forEach(r =>
        dueMap.set(`${r.student_id}-${r.payment_year}-${r.payment_month}`,
                   parseFloat(r.amount_due) || 0));
    } catch (_) {}

    // Billing-start cutoff (same rule the statement uses)
    let cutY = cur.year, cutM = cur.month;
    try {
      const cs = await pool.query(
        `SELECT key, value FROM settings WHERE key IN ('install_year','install_month')`);
      cs.rows.forEach(r => {
        if (r.key === 'install_year'  && parseInt(r.value)) cutY = parseInt(r.value);
        if (r.key === 'install_month' && parseInt(r.value)) cutM = parseInt(r.value);
      });
    } catch (_) {}
    const atOrAfterCutoff = (yy, mm) => (yy > cutY) || (yy === cutY && mm >= cutM);
    const holidayMonths = await getNonBillableMonths();

    const out = students.rows.map(s => {
      const fee = effectiveFeeOf(s);
      const { startY, startM } = walkStart(s.enrolled_at);

      // Running bank-account ledger: sum everything billed and everything
      // paid across all expected months, then net them. This way ANY
      // payment lowers the outstanding total (even an overpayment on one
      // month or a payment on a pre-cutoff month becomes a credit against
      // the rest), and every elapsed unpaid month raises it.
      let monthsDue = 0, monthsPaid = 0, unpaidMonths = 0;
      let y = startY, m = startM;
      while (y < cur.year || (y === cur.year && m <= cur.month)) {
        const key = `${s.id}-${y}-${m}`;
        if (!carriedSet.has(key)) {
          const ov  = dueMap.get(key);
          // Explicit per-month override wins; otherwise summer-holiday
          // months bill nothing, and normal months bill the fee.
          const due = (ov !== undefined)
            ? ov
            : (holidayMonths.has(m) ? 0 : (atOrAfterCutoff(y, m) ? fee : 0));
          const pd  = paidMap.get(key) || 0;
          monthsDue  += due;
          monthsPaid += pd;
          if (+(due - pd).toFixed(2) > 0) unpaidMonths++;
        }
        m++; if (m > 12) { m = 1; y++; }
      }

      // Opening / carry-forward debt and the payments made against it
      const openingDue  = Math.max(0, parseFloat(s.previous_debt) || 0);
      const openingPaid = debtPaidMap.get(s.id) || 0;

      const totalBalance = Math.max(0,
        +((monthsDue + openingDue) - (monthsPaid + openingPaid)).toFixed(2));

      // Total Due (opening debt) remaining, for display
      const totalDue = Math.max(0, +(openingDue - openingPaid).toFixed(2));

      const periodPaid = (periodYear && periodMonth)
        ? (paidMap.get(`${s.id}-${periodYear}-${periodMonth}`) || 0)
        : 0;

      // Period is "expected" if it falls within the auto-walk range.
      // A holiday month is never expected — no fee is charged for it.
      const periodIsHoliday = !!(periodMonth && holidayMonths.has(periodMonth));
      let periodExpected = false;
      if (periodYear && periodMonth && !periodIsHoliday) {
        const inRange = (
          (periodYear > startY || (periodYear === startY && periodMonth >= startM)) &&
          (periodYear < cur.year || (periodYear === cur.year && periodMonth <= cur.month))
        );
        periodExpected = inRange && !carriedSet.has(`${s.id}-${periodYear}-${periodMonth}`);
      }

      return {
        student_id:      s.id,
        total_balance:   +totalBalance.toFixed(2),
        unpaid_months:   unpaidMonths,
        total_due:       totalDue,
        period_paid:     periodPaid,
        period_due:      periodIsHoliday ? 0 : fee,
        period_expected: periodExpected,
        period_holiday:  periodIsHoliday,
      };
    });

    res.json(out);
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
        AND COALESCE(carried_forward, FALSE) = FALSE
      GROUP BY payment_month, payment_year
      ORDER BY payment_month
    `, [y]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
