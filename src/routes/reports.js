const express = require('express');
const pool    = require('../db.js');
const { kabulTodayISO, todayShamsi } = require('../shamsi.js');
const { calculateMonthlyTax } = require('../tax.js');
// The one ledger every money screen reads, so a printed report cannot quote
// a different figure from the one the office is looking at.
const { computeBalances } = require('./fees.js');
const { getHolidayMonths } = require('../holidays.js');
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
    const d = date || kabulTodayISO();

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
// Every student, with their whole fee position for the chosen month — what
// they are charged, what they paid, and what they still owe altogether.
//
// The figures come from computeBalances, the same running ledger the Fee
// Collection screen reads, so a printed report and the screen can never
// quote different numbers at a parent. The old version answered a narrower
// question — who paid this month and who did not — and built the "unpaid"
// list straight from the students table, which swept in graduates and
// inactive students and billed them all a flat monthly fee.
router.get('/fees', async (req, res) => {
  try {
    const { month, year, class_id } = req.query;
    const cur = todayShamsi();
    const m = parseInt(month) || cur.month;
    const y = parseInt(year)  || cur.year;

    const params = [];
    let where = 'WHERE s.is_active = TRUE AND COALESCE(s.graduated, FALSE) = FALSE';
    if (class_id) { params.push(class_id); where += ` AND s.class_id = $${params.length}`; }

    const students = await pool.query(`
      SELECT s.id, s.first_name, s.last_name, s.student_code, s.parent_name,
             s.monthly_fee, s.discount_type, s.discount_value,
             c.name AS class_name, c.grade_level, c.section
        FROM students s
        LEFT JOIN classes c ON c.id = s.class_id
        ${where}`, params);

    const ledger = new Map();
    (await computeBalances({ periodYear: y, periodMonth: m }))
      .forEach(b => ledger.set(b.student_id, b));

    const rows = students.rows.map(s => {
      const b = ledger.get(s.id) || {};
      const paid = +(b.period_paid || 0);
      const due  = +(b.period_due  || 0);
      return {
        student_id:   s.id,
        first_name:   s.first_name,
        last_name:    s.last_name || '',
        parent_name:  s.parent_name || '',
        student_code: s.student_code || '',
        class_name:   s.class_name || '',
        monthly_fee:    parseFloat(s.monthly_fee) || 0,
        discount_type:  s.discount_type,
        discount_value: parseFloat(s.discount_value) || 0,
        month_due:    due,
        month_paid:   paid,
        month_status: b.period_holiday ? 'holiday'
                    : (due <= 0 && paid <= 0) ? 'none'
                    : paid <= 0 ? 'unpaid'
                    : paid + 0.001 >= due ? 'paid' : 'partial',
        total_balance: +(b.total_balance || 0),
        unpaid_months: b.unpaid_months || 0,
      };
    }).sort((a, b) =>
      (a.class_name || '').localeCompare(b.class_name || '', 'fa') ||
      (a.first_name || '').localeCompare(b.first_name || '', 'fa'));

    const sum = (f) => rows.reduce((t, r) => t + f(r), 0);
    res.json({
      month: m, year: y,
      students: rows,
      totals: {
        students:        rows.length,
        collected:       +sum(r => r.month_paid).toFixed(2),
        billed:          +sum(r => r.month_due).toFixed(2),
        outstanding:     +sum(r => r.total_balance).toFixed(2),
        fully_paid:      rows.filter(r => r.month_status === 'paid').length,
        partly_paid:     rows.filter(r => r.month_status === 'partial').length,
        not_paid:        rows.filter(r => r.month_status === 'unpaid').length,
        owing_anything:  rows.filter(r => r.total_balance > 0).length,
      },
      // Kept so anything still reading the old shape does not break.
      total_collected: +sum(r => r.month_paid).toFixed(2),
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
    // SUM all advances per person — multiple advances per month are allowed
    const advMap = {};
    advRes.rows.forEach(a => {
      const k = `${a.person_type}-${a.person_id}`;
      advMap[k] = (advMap[k] || 0) + (parseFloat(a.amount) || 0);
    });
    // Overtime sums per person (table may not exist on old DBs)
    const otMap = {};
    try {
      const otRes = await pool.query(
        `SELECT person_type, person_id, COALESCE(SUM(amount),0)::float AS total
           FROM payroll_overtime WHERE pay_month=$1 GROUP BY person_type, person_id`, [payMonth]);
      otRes.rows.forEach(o => { otMap[`${o.person_type}-${o.person_id}`] = o.total; });
    } catch (_) {}

    // Same salary model as the payroll page:
    //   net = salary − tax − (absence, paid rows only) + overtime − advances
    // Paid rows use the FROZEN figures stored at payment time.
    // Holiday months earn no salary — overtime only.
    const holidayMonths = await getHolidayMonths();
    const isHolidayMonth = holidayMonths.has(m);

    const result = people.map(p => {
      const key    = `${p.person_type}-${p.id}`;
      const paid   = payMap[key] || null;
      const salary = isHolidayMonth ? 0 : (parseFloat(p.monthly_salary) || 0);
      if (paid) {
        return {
          ...p, salary,
          advance: parseFloat(paid.advance_taken || 0),
          tax:     parseFloat(paid.tax_amount || 0),
          net:     parseFloat(paid.net_salary || 0),
          is_paid: true,
        };
      }
      const adv = advMap[key] || 0;
      const tax = calculateMonthlyTax(salary);
      const ot  = otMap[key] || 0;
      return {
        ...p, salary,
        advance: adv,
        tax,
        net: Math.max(0, salary - tax + ot - adv),
        is_paid: false,
      };
    });

    res.json({
      month: m, year: y, people: result,
      is_holiday_month: isHolidayMonth,
      total_salary: result.reduce((s,p)=>s+p.salary,0),
      total_paid:   result.filter(p=>p.is_paid).reduce((s,p)=>s+p.net,0),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Expense Report ────────────────────────────────────────────
router.get('/expenses', async (req, res) => {
  try {
    // Same rule as GET /api/expenses — the UI sends a Gregorian date range
    // derived from the selected Shamsi month. Fall back to Gregorian
    // month/year only when no range is supplied.
    const { month, year, start_date, end_date } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const result = (start_date && end_date)
      ? await pool.query(`
          SELECT * FROM office_expenses
          WHERE expense_date >= $1::date AND expense_date <= $2::date
          ORDER BY expense_date DESC
        `, [start_date, end_date])
      : await pool.query(`
          SELECT * FROM office_expenses
          WHERE EXTRACT(MONTH FROM expense_date)=$1 AND EXTRACT(YEAR FROM expense_date)=$2
          ORDER BY expense_date DESC
        `, [m, y]);
    const total = result.rows.reduce((s, e) => s + parseFloat(e.amount), 0);
    res.json({ month: m, year: y, start_date: start_date || null, end_date: end_date || null,
               expenses: result.rows, total });
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