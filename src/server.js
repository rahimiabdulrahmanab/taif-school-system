require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const pool     = require('./db');
const CONFIG   = require('../school-config');

const app  = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));           // student/teacher/staff photos
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads'))); // school logo
app.use('/admin',   express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/gate',    express.static(path.join(__dirname, '..', 'public', 'gate')));

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
    const students = await pool.query('SELECT COUNT(*) FROM students WHERE is_active = true');
    const teachers = await pool.query('SELECT COUNT(*) FROM teachers WHERE is_active = true');
    const staff    = await pool.query('SELECT COUNT(*) FROM staff WHERE is_active = true');
    const present  = await pool.query("SELECT COUNT(*) FROM attendance WHERE scan_date = CURRENT_DATE AND person_type = 'student'");
    const total_s  = parseInt(students.rows[0].count);
    const present_n = parseInt(present.rows[0].count);
    res.json({
      students: total_s,
      teachers: parseInt(teachers.rows[0].count),
      staff:    parseInt(staff.rows[0].count),
      present:  present_n,
      absent:   Math.max(0, total_s - present_n),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Routes
const studentRoutes  = require('./routes/students');
const peopleRoutes   = require('./routes/people');
const classRoutes    = require('./routes/classes');
const attendanceRoutes = require('./routes/attendance');
const feeRoutes      = require('./routes/fees');
const payrollRoutes  = require('./routes/payroll');
const gradesRoutes   = require('./routes/grades');
const expensesRoutes = require('./routes/expenses');
const reportsRoutes  = require('./routes/reports');
const waRoutes       = require('./routes/whatsapp');
const settingsRoutes = require('./routes/settings');

app.use('/api/students',   studentRoutes);
app.use('/api',            peopleRoutes);
app.use('/api/classes',    classRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/fees',       feeRoutes);
app.use('/api/payroll',    payrollRoutes);
app.use('/api/grades',     gradesRoutes);
app.use('/api/expenses',   expensesRoutes);
app.use('/api/reports',    reportsRoutes);
app.use('/api/whatsapp',   waRoutes);
app.use('/api/settings',   settingsRoutes);

// Root redirect
app.get('/', (req, res) => res.redirect('/admin'));

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