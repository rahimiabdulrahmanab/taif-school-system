require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const pool     = require('./db');
const CONFIG   = require('../school-config');

const auth = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));
app.use('/admin',   express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/gate',    express.static(path.join(__dirname, '..', 'public', 'gate')));
app.use('/login',   express.static(path.join(__dirname, '..', 'public', 'login')));
app.use('/teacher', express.static(path.join(__dirname, '..', 'public', 'teacher')));

// Config endpoint — merges school-config.js defaults with live DB settings
app.get('/api/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const db = {};
    result.rows.forEach(r => { db[r.key] = r.value; });

    res.json({
      name:             db.school_name        || CONFIG.name,
      name_short:       db.school_short_name  || CONFIG.name_short,
      abbreviation:     db.school_abbreviation|| CONFIG.abbreviation,
      tagline:          db.school_tagline     || CONFIG.tagline,
      phone:            db.school_phone       || CONFIG.phone,
      email:            db.school_email       || CONFIG.email,
      address:          db.school_address     || CONFIG.address,
      website:          db.school_website     || CONFIG.website || '',
      logo:             db.school_logo        || null,
      current_year:     db.academic_year      || CONFIG.current_year,
      currency:         db.currency           || CONFIG.currency,
      currency_symbol:  db.currency_symbol    || CONFIG.currency_symbol,
      default_fee:      db.default_monthly_fee|| '0',
      brand_color:      db.brand_color        || CONFIG.brand_color,
      accent_color:     db.accent_color       || CONFIG.accent_color,
      midterm_max:      parseInt(db.midterm_max  || CONFIG.midterm_max),
      final_max:        parseInt(db.final_max    || CONFIG.final_max),
      pass_mark:        parseInt(db.pass_mark    || CONFIG.pass_mark),
      absence_alert_time: db.absence_alert_time || CONFIG.absence_alert_time,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({ status: 'ok', message: `${CONFIG.name} System is running`, database: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [students, teachers, staff, present, feeMonth, outstanding] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM students WHERE is_active = true'),
      pool.query('SELECT COUNT(*) FROM teachers WHERE is_active = true'),
      pool.query('SELECT COUNT(*) FROM staff    WHERE is_active = true'),
      pool.query("SELECT COUNT(*) FROM attendance WHERE scan_date = CURRENT_DATE AND person_type = 'student'"),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM fee_payments WHERE DATE_TRUNC('month', payment_date) = DATE_TRUNC('month', CURRENT_DATE)`),
      pool.query(`SELECT COUNT(*) FROM students WHERE is_active = true AND id NOT IN (SELECT DISTINCT student_id FROM fee_payments WHERE DATE_TRUNC('month', payment_date) = DATE_TRUNC('month', CURRENT_DATE))`),
    ]);
    const total_s   = parseInt(students.rows[0].count);
    const present_n = parseInt(present.rows[0].count);
    res.json({
      students:    total_s,
      teachers:    parseInt(teachers.rows[0].count),
      staff:       parseInt(staff.rows[0].count),
      present:     present_n,
      absent:      Math.max(0, total_s - present_n),
      fee_month:   parseFloat(feeMonth.rows[0].total) || 0,
      outstanding: parseInt(outstanding.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard — attendance trend (last 30 days)
app.get('/api/dashboard/attendance-trend', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT scan_date::text, COUNT(*)::int AS count
      FROM attendance
      WHERE person_type = 'student'
        AND scan_date >= CURRENT_DATE - INTERVAL '29 days'
      GROUP BY scan_date ORDER BY scan_date
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dashboard — monthly fee collection for a year
app.get('/api/dashboard/fee-chart', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const result = await pool.query(`
      SELECT DATE_PART('month', payment_date)::int AS month,
             COALESCE(SUM(amount), 0)::float       AS total
      FROM fee_payments
      WHERE DATE_PART('year', payment_date) = $1
      GROUP BY DATE_PART('month', payment_date)
      ORDER BY month
    `, [year]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dashboard — class-wise attendance today
app.get('/api/dashboard/class-attendance', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.name,
             COUNT(DISTINCT s.id)::int          AS total,
             COUNT(DISTINCT a.person_id)::int   AS present
      FROM classes c
      LEFT JOIN students s  ON s.class_id = c.id AND s.is_active = true
      LEFT JOIN attendance a ON a.person_id = s.id
                             AND a.person_type = 'student'
                             AND a.scan_date = CURRENT_DATE
      GROUP BY c.id, c.name
      HAVING COUNT(DISTINCT s.id) > 0
      ORDER BY c.name
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dashboard scans
app.get('/api/dashboard/scans', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, s.first_name, s.last_name, c.name as class_name, 'student' as person_type
      FROM attendance a JOIN students s ON s.id = a.person_id
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE a.scan_date = CURRENT_DATE AND a.person_type = 'student'
      UNION ALL
      SELECT a.*, t.first_name, t.last_name, t.subject as class_name, 'teacher' as person_type
      FROM attendance a JOIN teachers t ON t.id = a.person_id
      WHERE a.scan_date = CURRENT_DATE AND a.person_type = 'teacher'
      UNION ALL
      SELECT a.*, st.first_name, st.last_name, st.role as class_name, 'staff' as person_type
      FROM attendance a JOIN staff st ON st.id = a.person_id
      WHERE a.scan_date = CURRENT_DATE AND a.person_type = 'staff'
      ORDER BY scan_time DESC LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auth routes (public — no middleware)
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// All routes below require a valid JWT
const studentRoutes    = require('./routes/students');
const peopleRoutes     = require('./routes/people');
const classRoutes      = require('./routes/classes');
const attendanceRoutes = require('./routes/attendance');
const feeRoutes        = require('./routes/fees');
const payrollRoutes    = require('./routes/payroll');
const gradesRoutes     = require('./routes/grades');
const expensesRoutes   = require('./routes/expenses');
const reportsRoutes    = require('./routes/reports');
const waRoutes         = require('./routes/whatsapp');
const settingsRoutes   = require('./routes/settings');
const teacherRoutes    = require('./routes/teacher');

// Attendance: POST /scan and GET / are public (gate kiosk — no login needed)
app.use('/api/attendance', (req, res, next) => {
  const isPublic =
    (req.method === 'POST' && req.path === '/scan') ||
    (req.method === 'GET'  && req.path === '/');
  if (isPublic) return next();
  return auth(req, res, next);
}, attendanceRoutes);
app.use('/api/students',   auth, studentRoutes);
app.use('/api',            auth, peopleRoutes);
app.use('/api/classes',    auth, classRoutes);
app.use('/api/fees',       auth, feeRoutes);
app.use('/api/payroll',    auth, payrollRoutes);
app.use('/api/grades',     auth, gradesRoutes);
app.use('/api/expenses',   auth, expensesRoutes);
app.use('/api/reports',    auth, reportsRoutes);
app.use('/api/whatsapp',   auth, waRoutes);
app.use('/api/settings',   auth, settingsRoutes);
app.use('/api/teacher',    auth, teacherRoutes);

// Root redirect
app.get('/', (req, res) => res.redirect('/login'));

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ${CONFIG.name.padEnd(40)} ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Server  →  http://localhost:${PORT}         ║`);
  console.log(`║  Admin   →  http://localhost:${PORT}/admin   ║`);
  console.log(`║  Gate    →  http://localhost:${PORT}/gate    ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;