const express = require('express');
const pool    = require('../db.js');
const { shamsiMonthRange, workingDaysBetween } = require('../shamsi.js');
const router  = express.Router();

// ── Afghanistan wage income tax — progressive (marginal) brackets ─
// Bracket 1: 0 – 5,000     AFN  → 0%
// Bracket 2: 5,000 – 12,500 AFN → 2%   on the portion above 5,000
// Bracket 3: 12,500+        AFN → 10%  on the portion above 12,500
const TAX_BRACKETS = [
  { upTo: 5000,   rate: 0    },
  { upTo: 12500,  rate: 0.02 },
  { upTo: Infinity, rate: 0.10 },
];
function calculateMonthlyTax(salary) {
  const s = Math.max(0, Number(salary) || 0);
  let tax = 0, prev = 0;
  for (const b of TAX_BRACKETS) {
    if (s <= prev) break;
    const slice = Math.min(s, b.upTo) - prev;
    tax += slice * b.rate;
    prev = b.upTo;
  }
  return Math.round(tax * 100) / 100; // round to 2 decimals
}

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

    // Get advances for this month — multiple per person allowed, ordered by date
    const advRes = await pool.query(
      `SELECT * FROM payroll_advances WHERE pay_month = $1 ORDER BY advance_date ASC, id ASC`,
      [payMonth]
    );
    const advMap = {};
    advRes.rows.forEach(a => {
      const key = `${a.person_type}-${a.person_id}`;
      if (!advMap[key]) advMap[key] = [];
      advMap[key].push(a);
    });

    // ── Attendance → absence calculation ────────────────────────────
    // The pay month (m, y) is Shamsi; attendance scan_date is Gregorian.
    const range = shamsiMonthRange(y, m);                 // {start,end,startISO,endISO}
    // Client rule: salary is always calculated over a FIXED 30-day month,
    // counting every day INCLUDING Fridays. Per-day rate = salary / 30 and
    // absence is measured against 30 days.
    const MS_DAY = 86400000;
    const workingDaysInMonth = 30;
    // Only count days that have actually elapsed (current/future month safe)
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const elapsedEnd = today < range.end ? today : range.end;
    const elapsedWorkingDays = today < range.start
      ? 0
      : Math.min(30, Math.floor((elapsedEnd - range.start) / MS_DAY) + 1);

    // One query: distinct days each teacher/staff scanned in during the month
    const attRes = await pool.query(
      `SELECT person_id, person_type, COUNT(DISTINCT scan_date)::int AS present_days
         FROM attendance
        WHERE scan_date >= $1 AND scan_date <= $2
          AND person_type IN ('teacher','staff')
        GROUP BY person_id, person_type`,
      [range.startISO, range.endISO]
    );
    const presentMap = {};
    attRes.rows.forEach(r => { presentMap[`${r.person_type}-${r.person_id}`] = r.present_days; });

    // Admin-confirmed present-day overrides for this month (set on the
    // Attendance → Staff Attendance screen). When present, these win.
    // Gracefully degrade if the migration hasn't been run yet — the rest of
    // payroll keeps working using raw gate-scan counts.
    const overrideMap = {};
    try {
      const ovRes = await pool.query(
        `SELECT person_id, person_type, present_days
           FROM staff_monthly_attendance WHERE pay_month = $1`,
        [payMonth]
      );
      ovRes.rows.forEach(r => { overrideMap[`${r.person_type}-${r.person_id}`] = r.present_days; });
    } catch (e) {
      if (!/staff_monthly_attendance/.test(e.message || '')) throw e;
      console.warn('[payroll] staff_monthly_attendance table missing — run migration_align_with_routes.sql to enable admin overrides.');
    }

    const result = people.map(p => {
      const key      = `${p.person_type}-${p.id}`;
      const payroll  = payrollMap[key] || null;
      const advances = advMap[key] || [];
      const salary   = parseFloat(p.monthly_salary) || 0;
      const advTotal = advances.reduce((s, a) => s + parseFloat(a.amount || 0), 0);
      // If already paid, use the stored tax amount (frozen at payment time).
      // Otherwise compute on the fly so the office always sees the live figure.
      const tax       = payroll ? parseFloat(payroll.tax_amount || 0) : calculateMonthlyTax(salary);

      // ── Attendance-based absence ──────────────────────────────
      const scannedDays = presentMap[key] || 0;       // raw gate-scan count
      const hasOverride = Object.prototype.hasOwnProperty.call(overrideMap, key);
      // If the gate has no scans at all for this person AND the admin hasn't
      // saved an override, assume the scanner isn't being used for them — fall
      // back to "present every elapsed day" so we don't silently wipe salaries.
      const noAttendanceData = !hasOverride && scannedDays === 0;
      // present_days: admin override > scan count > "no data → assume present"
      const presentDays = hasOverride
        ? overrideMap[key]
        : (noAttendanceData ? elapsedWorkingDays : scannedDays);
      // absent_days:
      //   • already paid       → frozen value stored on the payroll row
      //   • admin override     → working_days_in_month − confirmed present_days
      //   • no scan data       → 0 (no proof of absence)
      //   • some scan data     → elapsed working days not yet scanned
      let absentDays;
      if (payroll)              absentDays = parseInt(payroll.absent_days, 10) || 0;
      else if (hasOverride)     absentDays = Math.max(0, workingDaysInMonth - presentDays);
      else if (noAttendanceData) absentDays = 0;
      else                      absentDays = Math.max(0, elapsedWorkingDays - scannedDays);

      const dailyRate    = salary / 30;   // fixed 30-day month (Fridays included)
      const absenceDeduction = payroll
        ? parseFloat(payroll.deduction_amount || 0)
        : Math.round(dailyRate * absentDays);

      // Salary model:
      //   net_payable = salary − tax − absence_deduction   (what the teacher earned, after tax)
      //   net_salary  = net_payable − advances             (what's still to hand over)
      const netPayable = Math.max(0, salary - tax - absenceDeduction);
      const netSalary  = Math.max(0, netPayable - advTotal);

      return {
        ...p,
        salary,
        advances,                              // detailed list with dates
        advance_amount: advTotal,              // sum (back-compat for existing UI)
        advance_count:  advances.length,
        tax_amount:     tax,
        // Attendance
        scanned_days:        scannedDays,            // raw gate-scan count
        present_days:        presentDays,            // admin-confirmed, or scan count
        absent_days:         absentDays,
        has_attendance_override: hasOverride,
        working_days_month:  workingDaysInMonth,
        elapsed_working_days: elapsedWorkingDays,
        daily_rate:          Math.round(dailyRate),
        absence_deduction:   absenceDeduction,
        // Net figures
        net_payable:    netPayable,            // salary − tax − absence; advances draw from this
        net_salary:     netSalary,             // final amount still to pay
        payroll_id:     payroll?.id || null,
        is_paid:        !!payroll,
        paid_date:      payroll?.paid_date || null,
        payment_method: payroll?.payment_method || null,
        payment_notes:  payroll?.payment_notes  || '',
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
    const { person_id, person_type, amount, month, year, payment_method, notes, paid_date,
            absent_days, deduction_amount } = req.body;
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

    // Sum all advances for the month (not just one)
    const advRes = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::float AS total
         FROM payroll_advances
        WHERE person_id=$1 AND person_type=$2 AND pay_month=$3`,
      [person_id, person_type, payMonth]
    );
    const advAmt = parseFloat(advRes.rows[0].total) || 0;
    const taxAmt = calculateMonthlyTax(baseSalary);
    // Absence — admin may override the auto-counted value at payment time
    const absentDays  = Math.max(0, parseInt(absent_days, 10) || 0);
    const deduction   = Math.max(0, parseFloat(deduction_amount) || 0);

    const result = await pool.query(`
      INSERT INTO payroll
        (person_id, person_type, pay_month, base_salary, advance_taken, tax_amount, net_salary,
         is_paid, paid_date, deduction_amount, absent_days, payment_method, payment_notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true, COALESCE($8::date, CURRENT_DATE), $9, $10, $11, $12)
      RETURNING *
    `, [
      person_id, person_type, payMonth, baseSalary, advAmt, taxAmt, amount,
      paid_date || null, deduction, absentDays, payment_method || 'cash', notes || null,
    ]);

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

// ── POST give advance — always INSERTS a new row (multiple per month allowed) ─
router.post('/advance', async (req, res) => {
  try {
    const { person_id, person_type, amount, month, year, notes, advance_date } = req.body;
    const payMonth = `${year}-${String(month).padStart(2,'0')}`;
    const amt = parseFloat(amount);

    if (!amt || amt <= 0) return res.status(400).json({ error: 'Advance amount must be greater than 0' });

    // Cumulative advances + this one must not exceed NET PAYABLE (salary after tax)
    const salTable = person_type === 'teacher' ? 'teachers' : 'staff';
    const salRes   = await pool.query(`SELECT monthly_salary FROM ${salTable} WHERE id=$1`, [person_id]);
    const salary   = parseFloat(salRes.rows[0]?.monthly_salary) || 0;
    const tax      = calculateMonthlyTax(salary);
    const netPayable = Math.max(0, salary - tax);

    const sumRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS total
         FROM payroll_advances
        WHERE person_id=$1 AND person_type=$2 AND pay_month=$3`,
      [person_id, person_type, payMonth]
    );
    const alreadyTaken = parseFloat(sumRes.rows[0].total) || 0;

    if (alreadyTaken + amt > netPayable) {
      return res.status(400).json({
        error: `Total advances (${(alreadyTaken + amt).toLocaleString()} AFN) would exceed net payable salary after tax (${netPayable.toLocaleString()} AFN). Already taken: ${alreadyTaken.toLocaleString()} AFN.`,
      });
    }

    const r = await pool.query(`
      INSERT INTO payroll_advances (person_id, person_type, amount, pay_month, notes, advance_date)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE))
      RETURNING *
    `, [person_id, person_type, amt, payMonth, notes || null, advance_date || null]);

    res.status(201).json({ success: true, advance: r.rows[0] });
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

// ── GET full advance history for one person (all months) ──────
// Every advance this teacher/staff has ever taken, oldest → newest,
// with a running cumulative total. Lets the school see old advances
// and how much is still being carried (e.g. a 10,000 advance on a
// 3,000 salary = several months of recovery ahead).
router.get('/advance-history', async (req, res) => {
  try {
    const { person_type, person_id } = req.query;
    if (!person_type || !person_id) {
      return res.status(400).json({ error: 'person_type and person_id are required' });
    }

    const personTbl = person_type === 'teacher' ? 'teachers' : 'staff';
    const pres = await pool.query(
      `SELECT first_name, last_name, COALESCE(monthly_salary,0) AS salary
         FROM ${personTbl} WHERE id = $1`, [person_id]);
    const person = pres.rows[0] || { first_name: '', last_name: '', salary: 0 };

    const adv = await pool.query(
      `SELECT id, amount, pay_month, notes, advance_date, created_at
         FROM payroll_advances
        WHERE person_type = $1 AND person_id = $2
        ORDER BY advance_date ASC NULLS LAST, id ASC`,
      [person_type, person_id]
    );

    let running = 0;
    const rows = adv.rows.map(a => {
      running += parseFloat(a.amount || 0);
      return { ...a, amount: parseFloat(a.amount || 0), running_total: +running.toFixed(2) };
    });

    res.json({
      person:        { first_name: person.first_name, last_name: person.last_name },
      monthly_salary: parseFloat(person.salary) || 0,
      total_taken:    +running.toFixed(2),
      count:          rows.length,
      advances:       rows,
    });
  } catch (err) {
    console.error('GET /api/payroll/advance-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET tax report for a Shamsi month/year ────────────────────
// Per-employee tax breakdown the school files with the government.
router.get('/tax-report', async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || (new Date().getMonth() + 1);
    const y = parseInt(year)  || new Date().getFullYear();
    const payMonth = `${y}-${String(m).padStart(2,'0')}`;

    // All active teachers + staff, joined with their payroll record (if paid)
    const teachers = await pool.query(`
      SELECT t.id, t.first_name, t.last_name, t.teacher_code AS code,
             t.monthly_salary, 'teacher' AS person_type,
             p.tax_amount, p.is_paid, p.paid_date, p.payment_method
        FROM teachers t
        LEFT JOIN payroll p ON p.person_id = t.id AND p.person_type='teacher' AND p.pay_month=$1
       WHERE t.is_active = true
       ORDER BY t.first_name
    `, [payMonth]);
    const staff = await pool.query(`
      SELECT s.id, s.first_name, s.last_name, s.staff_code AS code,
             s.monthly_salary, 'staff' AS person_type,
             p.tax_amount, p.is_paid, p.paid_date, p.payment_method
        FROM staff s
        LEFT JOIN payroll p ON p.person_id = s.id AND p.person_type='staff' AND p.pay_month=$1
       WHERE s.is_active = true
       ORDER BY s.first_name
    `, [payMonth]);

    const rows = [...teachers.rows, ...staff.rows].map(r => {
      const salary = parseFloat(r.monthly_salary) || 0;
      // If they've been paid this month, use the frozen tax. Otherwise compute live.
      const tax = r.tax_amount != null ? parseFloat(r.tax_amount) : calculateMonthlyTax(salary);
      return {
        id: r.id,
        person_type: r.person_type,
        code: r.code,
        first_name: r.first_name,
        last_name: r.last_name,
        monthly_salary: salary,
        tax_amount: tax,
        is_paid: !!r.is_paid,
        paid_date: r.paid_date || null,
      };
    });

    const totalSalary = rows.reduce((s, r) => s + r.monthly_salary, 0);
    const totalTax    = rows.reduce((s, r) => s + r.tax_amount, 0);
    const paidTax     = rows.filter(r => r.is_paid).reduce((s, r) => s + r.tax_amount, 0);

    res.json({
      period: { month: m, year: y },
      brackets: TAX_BRACKETS.map(b => ({ upTo: b.upTo === Infinity ? null : b.upTo, rate: b.rate })),
      rows,
      totals: {
        employees:        rows.length,
        gross_salary:     totalSalary,
        tax_total:        totalTax,
        tax_paid:         paidTax,
        tax_pending:      totalTax - paidTax,
      },
    });
  } catch (err) {
    console.error('GET /api/payroll/tax-report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;