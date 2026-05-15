const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const QRCode   = require('qrcode');
const pool     = require('../db');
const CONFIG   = require('../../school-config');

const router = express.Router();

// ── Photo upload ──────────────────────────────────────────────
function makeUpload(type) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', type);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        cb(null, `${Date.now()}${path.extname(file.originalname) || '.jpg'}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Images only'));
    },
  });
}

// ── Auto-generate codes ───────────────────────────────────────
async function nextCode(table, codeCol, prefix) {
  const year = CONFIG.current_year;
  const res  = await pool.query(
    `SELECT ${codeCol} FROM ${table} WHERE ${codeCol} LIKE $1 ORDER BY ${codeCol} DESC LIMIT 1`,
    [`${prefix}-${year}-%`]
  );
  if (!res.rows.length) return `${prefix}-${year}-001`;
  const num = parseInt(res.rows[0][codeCol].split('-').pop()) + 1;
  return `${prefix}-${year}-${String(num).padStart(3, '0')}`;
}

// ════════════════════════════════════════════════════
//  TEACHERS
// ════════════════════════════════════════════════════
const teacherUpload = makeUpload('teachers');

router.get('/teachers', async (req, res) => {
  try {
    const { search } = req.query;
    let q = `SELECT * FROM teachers WHERE is_active = true`;
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      q += ` AND (first_name ILIKE $1 OR last_name ILIKE $1 OR teacher_code ILIKE $1 OR subject ILIKE $1)`;
    }
    q += ` ORDER BY first_name, last_name`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/teachers/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM teachers WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/teachers', teacherUpload.single('photo'), async (req, res) => {
  try {
    const { first_name, last_name, date_of_birth, gender, subject, phone, address, monthly_salary, join_date } = req.body;
    const teacher_code = await nextCode('teachers', 'teacher_code', CONFIG.teacher_prefix);
    const photo = req.file ? req.file.filename : null;
    const r = await pool.query(`
      INSERT INTO teachers (teacher_code,barcode,first_name,last_name,date_of_birth,gender,subject,phone,address,photo,monthly_salary,join_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [teacher_code, teacher_code, first_name, last_name, date_of_birth||null, gender||null,
       subject||null, phone||null, address||null, photo, parseFloat(monthly_salary)||0, join_date||null]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/teachers/:id', teacherUpload.single('photo'), async (req, res) => {
  try {
    const { first_name, last_name, date_of_birth, gender, subject, phone, address, monthly_salary, join_date, is_active } = req.body;
    const ex = await pool.query('SELECT photo FROM teachers WHERE id=$1', [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Not found' });
    let photo = ex.rows[0].photo;
    if (req.file) {
      if (photo) { const p = path.join(__dirname,'..','uploads','teachers',photo); if (fs.existsSync(p)) fs.unlinkSync(p); }
      photo = req.file.filename;
    }
    const r = await pool.query(`
      UPDATE teachers SET first_name=$1,last_name=$2,date_of_birth=$3,gender=$4,subject=$5,
      phone=$6,address=$7,photo=$8,monthly_salary=$9,join_date=$10,is_active=$11 WHERE id=$12 RETURNING *`,
      [first_name,last_name,date_of_birth||null,gender||null,subject||null,phone||null,
       address||null,photo,parseFloat(monthly_salary)||0,join_date||null,is_active!=='false',req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/teachers/:id', async (req, res) => {
  try {
    const ex = await pool.query('SELECT photo FROM teachers WHERE id=$1', [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM teachers WHERE id=$1', [req.params.id]);
    if (ex.rows[0].photo) { const p = path.join(__dirname,'..','uploads','teachers',ex.rows[0].photo); if (fs.existsSync(p)) fs.unlinkSync(p); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/teachers/:id/qr', async (req, res) => {
  try {
    const r = await pool.query('SELECT teacher_code,first_name,last_name FROM teachers WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const { teacher_code, first_name, last_name } = r.rows[0];
    const qr = await QRCode.toDataURL(teacher_code, { width:280, margin:2, color:{dark:'#1A4A5C',light:'#ffffff'}, errorCorrectionLevel:'M' });
    res.json({ qr, teacher_code, name: `${first_name} ${last_name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════
//  STAFF
// ════════════════════════════════════════════════════
const staffUpload = makeUpload('staff');

router.get('/staff', async (req, res) => {
  try {
    const { search } = req.query;
    let q = `SELECT * FROM staff WHERE is_active = true`;
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      q += ` AND (first_name ILIKE $1 OR last_name ILIKE $1 OR staff_code ILIKE $1 OR role ILIKE $1)`;
    }
    q += ` ORDER BY first_name, last_name`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/staff/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM staff WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/staff', staffUpload.single('photo'), async (req, res) => {
  try {
    const { first_name, last_name, date_of_birth, gender, role, phone, address, monthly_salary, join_date } = req.body;
    const staff_code = await nextCode('staff', 'staff_code', CONFIG.staff_prefix);
    const photo = req.file ? req.file.filename : null;
    const r = await pool.query(`
      INSERT INTO staff (staff_code,barcode,first_name,last_name,date_of_birth,gender,role,phone,address,photo,monthly_salary,join_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [staff_code, staff_code, first_name, last_name, date_of_birth||null, gender||null,
       role||null, phone||null, address||null, photo, parseFloat(monthly_salary)||0, join_date||null]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/staff/:id', staffUpload.single('photo'), async (req, res) => {
  try {
    const { first_name, last_name, date_of_birth, gender, role, phone, address, monthly_salary, join_date, is_active } = req.body;
    const ex = await pool.query('SELECT photo FROM staff WHERE id=$1', [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Not found' });
    let photo = ex.rows[0].photo;
    if (req.file) {
      if (photo) { const p = path.join(__dirname,'..','uploads','staff',photo); if (fs.existsSync(p)) fs.unlinkSync(p); }
      photo = req.file.filename;
    }
    const r = await pool.query(`
      UPDATE staff SET first_name=$1,last_name=$2,date_of_birth=$3,gender=$4,role=$5,
      phone=$6,address=$7,photo=$8,monthly_salary=$9,join_date=$10,is_active=$11 WHERE id=$12 RETURNING *`,
      [first_name,last_name,date_of_birth||null,gender||null,role||null,phone||null,
       address||null,photo,parseFloat(monthly_salary)||0,join_date||null,is_active!=='false',req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/staff/:id', async (req, res) => {
  try {
    const ex = await pool.query('SELECT photo FROM staff WHERE id=$1', [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM staff WHERE id=$1', [req.params.id]);
    if (ex.rows[0].photo) { const p = path.join(__dirname,'..','uploads','staff',ex.rows[0].photo); if (fs.existsSync(p)) fs.unlinkSync(p); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/staff/:id/qr', async (req, res) => {
  try {
    const r = await pool.query('SELECT staff_code,first_name,last_name FROM staff WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const { staff_code, first_name, last_name } = r.rows[0];
    const qr = await QRCode.toDataURL(staff_code, { width:280, margin:2, color:{dark:'#1A4A5C',light:'#ffffff'}, errorCorrectionLevel:'M' });
    res.json({ qr, staff_code, name: `${first_name} ${last_name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;