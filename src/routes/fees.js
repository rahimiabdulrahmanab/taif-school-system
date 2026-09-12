const express = require('express');
const pool    = require('../db.js');
const CONFIG  = require('../../school-config.js');
const { toShamsi, todayShamsi, kabulTodayISO } = require('../shamsi.js');
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

// Gregorian YYYY-MM-DD, the only date shape this module accepts from a client.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A student's own discount. It follows the student, not the grade: when a
// promotion raises the fee the discount simply comes off the larger figure.
function applyDiscount(fee, s) {
  let f = parseFloat(fee) || 0;
  if (s.discount_type === 'fixed')   f = Math.max(0, f - parseFloat(s.discount_value || 0));
  if (s.discount_type === 'percent') f = f * (1 - parseFloat(s.discount_value || 0) / 100);
  return f;
}

// Compute the student's effective monthly fee (after discount), today.
function effectiveFeeOf(s) {
  return applyDiscount(s.monthly_fee, s);
}

// ── What the fee WAS in a given month ─────────────────────────
// Moving up a grade changes the fee from that month onward. The months the
// student has already been billed must keep the price they were billed at,
// or last year's دریم months would silently re-price themselves at the
// څلورم fee. student_fee_history stamps each change with its starting month;
// this reads it back.
async function loadFeeTimelines(studentIds) {
  const map = new Map();
  try {
    const r = await pool.query(
      `SELECT student_id, from_year, from_month, monthly_fee
         FROM student_fee_history
        WHERE ($1::int[] IS NULL OR student_id = ANY($1::int[]))
        ORDER BY student_id, from_year, from_month`,
      [studentIds && studentIds.length ? studentIds : null]);
    r.rows.forEach(x => {
      const arr = map.get(x.student_id) || [];
      arr.push({ y: x.from_year, m: x.from_month, fee: parseFloat(x.monthly_fee) || 0 });
      map.set(x.student_id, arr);
    });
  } catch (_) { /* not migrated yet → today's fee applies to every month */ }
  return map;
}

function rawFeeAt(timeline, y, m, currentFee) {
  if (!timeline || !timeline.length) return currentFee;
  let fee = null;
  for (const row of timeline) {              // oldest first
    if (row.y < y || (row.y === y && row.m <= m)) fee = row.fee;
    else break;
  }
  return fee == null ? currentFee : fee;
}

function effectiveFeeAt(s, timeline, y, m) {
  return applyDiscount(rawFeeAt(timeline, y, m, parseFloat(s.monthly_fee) || 0), s);
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

// The next receipt book number: highest purely-numeric one used so far, plus
// one, padded to three digits (001, 002 … 010, 011 … 100). Derived from the
// data rather than a database sequence on purpose — if a clerk overrides it to
// match a new paper book (say 500), numbering simply continues from there
// instead of drifting away from the book on the desk.
// Returns null when the column does not exist yet.
async function nextReceiptBookNo() {
  try {
    const r = await pool.query(
      `SELECT COALESCE(MAX(receipt_book_no::bigint), 0) + 1 AS n
         FROM fee_payments
        WHERE receipt_book_no ~ '^[0-9]+$'`);
    return String(r.rows[0].n).padStart(3, '0');
  } catch (e) {
    if (/receipt_book_no/.test(e.message || '')) return null;
    throw e;
  }
}

// ── GET the number the next payment will be given ─────────────
// The Record Payment dialog shows this pre-filled. It only reads.
router.get('/next-receipt-no', async (req, res) => {
  try {
    res.json({ next: await nextReceiptBookNo() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stamp the clerk's paper receipt number onto the rows a payment created.
// Never throws: a missing column, or a missing number, simply means no tag.
async function tagBookNo(rows, bookNo) {
  if (!rows || !rows.length) return rows;
  // Nothing typed → assign the next number automatically.
  if (!bookNo) bookNo = await nextReceiptBookNo();
  if (!bookNo) return rows;
  const ids = rows.map(r => r && r.id).filter(Boolean);
  if (!ids.length) return rows;
  try {
    await pool.query(
      `UPDATE fee_payments SET receipt_book_no = $1 WHERE id = ANY($2)`, [bookNo, ids]);
    rows.forEach(r => { if (r) r.receipt_book_no = bookNo; });
  } catch (e) {
    if (!/receipt_book_no/.test(e.message || '')) throw e;
    console.warn('[fees] receipt_book_no column missing — run db/migration_receipt_book_no.sql to record paper receipt numbers.');
  }
  return rows;
}

// A student stops being billed the month they leave. Without this a
// graduated student keeps accruing a monthly fee for ever, so their unpaid
// balance grows every month even though they are long gone — and the office
// would be chasing money the school never charged.
// Returns the last Shamsi month that should be billed.
// A graduated student is NEVER charged another monthly fee. Not for the
// month they left in, not for any month after it, however long ago they
// left. What they may still owe is what they had already run up while they
// were a student, plus any opening balance the school recorded — that stays
// visible and collectable on the Graduates screen.
//
// NOTHING = a sentinel meaning "bill no months at all", used when a student
// is marked graduated but carries no graduation date, so a missing date can
// never quietly start the fees running again.
const NOTHING = { endY: -1, endM: -1 };

function walkEnd(s, curY, curM) {
  if (!s || !s.graduated) return { endY: curY, endM: curM };   // still a student
  if (!s.graduated_at) return NOTHING;                          // graduated, date unknown
  const g = new Date(s.graduated_at);
  if (isNaN(g)) return NOTHING;
  const gs = toShamsi(g.getFullYear(), g.getMonth() + 1, g.getDate());

  // Billing stops BEFORE the month the student left. A school does not
  // charge a leaver for the month they walked out in — Taif's grade 12
  // finished on 13 سنبله and the office does not want سنبله on their bill.
  // To charge the leaving month instead, use gs.month here rather than
  // gs.month - 1.
  let endY = gs.year, endM = gs.month - 1;
  if (endM < 1) { endM = 12; endY -= 1; }

  // Never bill further ahead than today, whatever the graduation date says.
  if (endY > curY || (endY === curY && endM > curM)) {
    return { endY: curY, endM: curM };
  }
  return { endY, endM };
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
    const feeLine = (await loadFeeTimelines([s.id])).get(s.id);

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
    const { endY, endM } = walkEnd(s, curY, curM);
    const outstanding = [];
    if (startY < endY || (startY === endY && startM <= endM)) {
      let y = startY, m = startM;
      while (y < endY || (y === endY && m <= endM)) {
        const key = `${y}-${m}`;
        if (!carriedMonths.has(key) && !holidayMonths.has(m)) {
          const monthFee = effectiveFeeAt(s, feeLine, y, m);
          const paid    = +(paidByMonth[key] || 0).toFixed(2);
          const balance = Math.max(0, +(monthFee - paid).toFixed(2));
          if (balance > 0) {
            outstanding.push({
              year: y, month: m,
              amount:  monthFee,
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
      apply_excess_to_debt, receipt_book_no, payment_date,
    } = req.body;

    // The number on the paper receipt the clerk hands the parent. One slip
    // covers the whole payment, so the SAME number is written onto every
    // month-row this payment creates. Blank is fine; it is a convenience for
    // reconciliation, not an identifier — receipt_number is the identifier.
    const bookNo = String(receipt_book_no == null ? '' : receipt_book_no).trim() || null;

    // The day the money was actually received. The office frequently enters
    // payments a few days late, and the daily reconciliation must show them on
    // the day they were taken, not the day they were typed. Null falls back to
    // today in Kabul.
    const payDate = DATE_RE.test(String(payment_date || '')) ? payment_date : null;

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
        VALUES ($1, $2, $2, $2, NULL, NULL, $3, $4, COALESCE($5::date, (NOW() AT TIME ZONE 'Asia/Kabul')::date), TRUE)
        RETURNING *
      `, [student_id, parseFloat(amount), payment_method || 'cash', notes || null, payDate]);
      await tagBookNo(r.rows, bookNo);
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
    const stu     = stuRes.rows[0];
    const feeLine = (await loadFeeTimelines([parseInt(student_id, 10)])).get(parseInt(student_id, 10));
    // Each month is charged at the fee that applied in THAT month, so paying
    // off a month from before a promotion costs what it cost back then.
    const feeOfMonth = (mm) => effectiveFeeAt(stu, feeLine, mm.year, mm.month);

    const total       = parseFloat(amount);
    const expected    = +monthsList.reduce((t, mm) => t + feeOfMonth(mm), 0).toFixed(2);
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
            VALUES ($1,$2,$2,$2,$3,$4,$5,$6,COALESCE($7::date, (NOW() AT TIME ZONE 'Asia/Kabul')::date))
            RETURNING *
          `, [student_id, feeOfMonth(m), m.month, m.year, payment_method || 'cash', notes || null, payDate]);
          out.push(r.rows[0]);
        }
        const d = await c.query(`
          INSERT INTO fee_payments
            (student_id, amount, amount_paid, original_fee,
             payment_month, payment_year, payment_method, notes,
             payment_date, is_previous_debt)
          VALUES ($1, $2, $2, $2, NULL, NULL, $3, $4, COALESCE($5::date, (NOW() AT TIME ZONE 'Asia/Kabul')::date), TRUE)
          RETURNING *
        `, [student_id, excess, payment_method || 'cash',
            (notes ? notes + ' — ' : '') + 'excess applied to debt', payDate]);
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
            VALUES ($1,$2,$2,$2,$3,$4,$5,$6,COALESCE($7::date, (NOW() AT TIME ZONE 'Asia/Kabul')::date))
            RETURNING *
          `, [student_id, perMonthAmt, m.month, m.year,
              payment_method || 'cash', notes || null, payDate]);
          out.push(r.rows[0]);
        }
      }
      return out;
    });

    await tagBookNo(results, bookNo);
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
    // The month is carried forward at the price it carried at the time, not
    // at whatever the student pays now after moving up a grade.
    const cfLine = (await loadFeeTimelines([parseInt(student_id, 10)])).get(parseInt(student_id, 10));
    const fee = effectiveFeeAt(stuRes.rows[0], cfLine, year, month);

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
           payment_date, carried_forward, receipt_number)
        VALUES ($1, 0, 0, $2, $3, $4, 'carry', $5, $6::date, TRUE, NULL)
      `, [student_id, fee, month, year, `Carried ${remaining} AFN forward to Total Due`, kabulTodayISO()]);

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
    // Each student is closed at the fee that applied in the month being
    // closed, which is not today's fee for anyone promoted since.
    const closeLines = await loadFeeTimelines(students.rows.map(s => s.id));

    for (const s of students.rows) {
      const fee = effectiveFeeAt(s, closeLines.get(s.id), year, month);
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
             payment_date, carried_forward, receipt_number)
          VALUES ($1, 0, 0, $2, $3, $4, 'carry', $5, $6::date, TRUE, NULL)
        `, [s.id, fee, month, year, `Carried ${remaining} AFN forward to Total Due`, kabulTodayISO()]);

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
    const feeLine = (await loadFeeTimelines([s.id])).get(s.id);

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
      `SELECT *
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
    // Billing stops the month a student leaves — otherwise a graduate's
    // statement keeps adding a month's fee for ever, and would disagree with
    // the Outstanding figure on the Graduates screen, which already stops.
    const { endY: stEndY, endM: stEndM } = walkEnd(s, cur.year, cur.month);

    // The rest of this school year is shown as well, so the office can take a
    // payment for a month that has not arrived yet — families often pay two or
    // three months ahead. Those months are listed but not billed: their Due
    // stays 0 until the month comes round, so an advance payment never makes
    // the school's outstanding figure look wrong. A student who has left keeps
    // their old cut-off; nothing is opened up beyond the month they left.
    const stillHere = (stEndY === cur.year && stEndM === cur.month);
    let lastY = stEndY, lastM = stEndM;
    if (stillHere) { lastY = cur.year; lastM = 12; }

    let y = lastY, m = lastM;
    while (y > sy || (y === sy && m >= sm)) {
      const k = `${y}-${m}`;
      const ov  = dueByKey[k];
      const isHoliday = !ov && holidayMonths.has(m);
      const isFuture  = (y > cur.year) || (y === cur.year && m > cur.month);
      const monthFee  = effectiveFeeAt(s, feeLine, y, m);
      const pays = payByKey[k] || [];
      const paid = +pays.reduce((t, p) => t + parseFloat(p.amount || 0), 0).toFixed(2);
      // A month ahead of today is billed only once somebody pays into it —
      // then it shows its own fee, so the receipt reads as a month settled in
      // advance instead of the school owing the family money.
      const due = ov ? parseFloat(ov.amount_due)
                : isHoliday ? 0
                : isFuture  ? (paid > 0 ? monthFee : 0)
                : (atOrAfterCutoff(y, m) ? monthFee : 0);
      const balance = +(due - paid).toFixed(2);

      // A holiday month with no money in it is not a month of schooling, so it
      // is left off the list entirely — the school year is the ten months that
      // remain. One that was paid or given a due of its own still shows.
      if (isHoliday && !paid && !ov) { m--; if (m < 1) { m = 12; y--; } continue; }

      (byYear[y] = byYear[y] || []).push({
        year: y, month: m, due, paid, balance,
        status: isHoliday ? 'holiday'
              : (isFuture && paid <= 0) ? 'upcoming'
              : (paid <= 0 ? 'unpaid' : (balance > 0 ? 'partial' : 'paid')),
        holiday: isHoliday,
        upcoming: isFuture,
        month_fee: monthFee,          // what this month costs if it is billed
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
      `SELECT *
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
    const { amount, payment_method, notes, payment_date, receipt_book_no } = req.body;
    const amt = (amount != null && amount !== '') ? parseFloat(amount) : null;
    // Reject a malformed date rather than letting Postgres throw mid-update.
    if (payment_date && !DATE_RE.test(String(payment_date))) {
      return res.status(400).json({ error: 'payment_date must be YYYY-MM-DD' });
    }
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

    // Kept out of the statement above so an un-migrated database can still
    // edit a payment — same reason tagBookNo exists.
    if (receipt_book_no !== undefined) {
      const no = String(receipt_book_no == null ? '' : receipt_book_no).trim() || null;
      try {
        await pool.query('UPDATE fee_payments SET receipt_book_no = $1 WHERE id = $2',
          [no, req.params.id]);
        r.rows[0].receipt_book_no = no;
      } catch (e) {
        if (!/receipt_book_no/.test(e.message || '')) throw e;
      }
    }

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
// Every student's running balance. Exported below so anything that needs to
// know who owes money — the Fee Collection screen, the Graduates screen, the
// WhatsApp fee reminders — asks this one function rather than keeping its own
// copy of the rules about holidays, discounts, carry-forwards and leavers.
async function computeBalances({ periodYear, periodMonth, withLeavers } = {}) {
  {
    const cur = todayShamsi();
    const students = await pool.query(`
      SELECT id, monthly_fee, discount_type, discount_value, enrolled_at,
             COALESCE(graduated, FALSE) AS graduated, graduated_at,
             is_active,
             COALESCE(previous_debt, 0) AS previous_debt
        FROM students
       WHERE is_active = true
          OR ($1::bool AND COALESCE(graduated, FALSE) = TRUE)
    `, [withLeavers]);

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
    // One query for the whole school: what each student's fee was in each
    // month, so a promotion never re-prices months already billed.
    const feeLines = await loadFeeTimelines(students.rows.map(s => s.id));

    const out = students.rows.map(s => {
      const fee = effectiveFeeOf(s);
      const feeLine = feeLines.get(s.id);
      const { startY, startM } = walkStart(s.enrolled_at);

      // Running bank-account ledger: sum everything billed and everything
      // paid across all expected months, then net them. This way ANY
      // payment lowers the outstanding total (even an overpayment on one
      // month or a payment on a pre-cutoff month becomes a credit against
      // the rest), and every elapsed unpaid month raises it.
      const { endY, endM } = walkEnd(s, cur.year, cur.month);

      let monthsDue = 0, monthsPaid = 0, unpaidMonths = 0;
      let y = startY, m = startM;
      while (y < endY || (y === endY && m <= endM)) {
        const key = `${s.id}-${y}-${m}`;
        if (!carriedSet.has(key)) {
          const ov  = dueMap.get(key);
          // Explicit per-month override wins; otherwise summer-holiday
          // months bill nothing, and normal months bill the fee.
          const due = (ov !== undefined)
            ? ov
            : (holidayMonths.has(m) ? 0
               : (atOrAfterCutoff(y, m) ? effectiveFeeAt(s, feeLine, y, m) : 0));
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
        graduated:       !!s.graduated,
        graduated_at:    s.graduated_at || null,
        total_balance:   +totalBalance.toFixed(2),
        unpaid_months:   unpaidMonths,
        total_due:       totalDue,
        period_paid:     periodPaid,
        period_due:      periodIsHoliday ? 0 : fee,
        period_expected: periodExpected,
        period_holiday:  periodIsHoliday,
      };
    });

    return out;
  }
}

router.get('/balances', async (req, res) => {
  try {
    res.json(await computeBalances({
      periodYear:  parseInt(req.query.year),
      periodMonth: parseInt(req.query.month),
      withLeavers: req.query.include_graduated === '1'
                || req.query.include_graduated === 'true',
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET one day's collections ─────────────────────────────────
// End-of-day reconciliation: everything actually taken in on a given
// calendar day, with the receipt serial for each, so the office can match
// the system against the paper book before locking up.
//
//   GET /api/fees/daily?date=YYYY-MM-DD   (Gregorian; the UI converts
//                                          from the Shamsi day picked)
// Defaults to the current Kabul day.
router.get('/daily', async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? req.query.date
      : kabulTodayISO();

    const rows = await pool.query(`
      SELECT fp.*,
             s.first_name, s.last_name, s.student_code,
             c.name AS class_name
        FROM fee_payments fp
        JOIN students s  ON s.id = fp.student_id
        LEFT JOIN classes c ON c.id = s.class_id
       WHERE fp.payment_date = $1::date
         AND COALESCE(fp.carried_forward, FALSE) = FALSE
       ORDER BY fp.created_at, fp.id`, [date]);

    // Per-method totals — the office counts cash separately from transfers.
    const byMethod = {};
    let total = 0;
    rows.rows.forEach(r => {
      const amt = parseFloat(r.amount) || 0;
      const m   = r.payment_method || 'cash';
      byMethod[m] = (byMethod[m] || 0) + amt;
      total += amt;
    });

    res.json({
      date,
      count:     rows.rows.length,
      total:     +total.toFixed(2),
      by_method: Object.entries(byMethod)
                   .map(([method, amount]) => ({ method, amount: +amount.toFixed(2) }))
                   .sort((a, b) => b.amount - a.amount),
      payments:  rows.rows,
    });
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
// Shared so other routes can ask who owes money without duplicating the rules.
module.exports.computeBalances = computeBalances;
