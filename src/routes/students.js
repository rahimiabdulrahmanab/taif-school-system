const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const QRCode   = require('qrcode');
const pool     = require('../db');
const CONFIG   = require('../../school-config');

const router = express.Router();

// ── Photo upload setup ────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'students');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  },
});

// ── Auto-generate student code ────────────────────────────────
// Format: TF + 6 random digits e.g. TF284756 — unique per student
async function nextStudentCode() {
  const prefix = CONFIG.student_prefix || 'TF';
  let code, exists;
  do {
    const digits = String(Math.floor(100000 + Math.random() * 900000));
    code = prefix + digits;
    const res = await pool.query('SELECT id FROM students WHERE student_code = $1', [code]);
    exists = res.rows.length > 0;
  } while (exists);
  return code;
}

// ══════════════════════════════════════════════════════════════
//  GET /api/students  — list all students
// ══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { search, class_id, active } = req.query;
    let query = `
      SELECT s.*, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE 1=1
    `;
    const params = [];

    if (active !== 'false') {
      query += ` AND s.is_active = true`;
    }
    if (class_id) {
      params.push(class_id);
      query += ` AND s.class_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (s.first_name ILIKE $${params.length}
                   OR s.last_name  ILIKE $${params.length}
                   OR s.student_code ILIKE $${params.length}
                   OR s.parent_phone ILIKE $${params.length})`;
    }
    query += ` ORDER BY s.first_name, s.last_name`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/students/:id  — single student
// ══════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.id = $1
    `, [req.params.id]);

    if (!result.rows.length)
      return res.status(404).json({ error: 'Student not found' });

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/students  — create student
// ══════════════════════════════════════════════════════════════
router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const {
      first_name, last_name, date_of_birth, gender,
      class_id, parent_name, parent_phone, address,
      monthly_fee, discount_type, discount_value, discount_note,
    } = req.body;

    const student_code = await nextStudentCode();
    const barcode      = student_code;
    const photo        = req.file ? req.file.filename : null;

    const result = await pool.query(`
      INSERT INTO students (
        student_code, barcode, first_name, last_name,
        date_of_birth, gender, class_id,
        parent_name, parent_phone, address,
        photo, monthly_fee,
        discount_type, discount_value, discount_note
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      student_code, barcode, first_name, last_name,
      date_of_birth || null, gender || null, class_id || null,
      parent_name || null, parent_phone || null, address || null,
      photo,
      parseFloat(monthly_fee) || 0,
      discount_type || 'none',
      parseFloat(discount_value) || 0,
      discount_note || null,
    ]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (req.file) fs.unlinkSync(req.file.path).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUT /api/students/:id  — update student
// ══════════════════════════════════════════════════════════════
router.put('/:id', upload.single('photo'), async (req, res) => {
  try {
    const {
      first_name, last_name, date_of_birth, gender,
      class_id, parent_name, parent_phone, address,
      monthly_fee, discount_type, discount_value, discount_note,
      is_active,
    } = req.body;

    // Get existing student to handle old photo
    const existing = await pool.query('SELECT photo FROM students WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });

    let photo = existing.rows[0].photo;
    if (req.file) {
      // Delete old photo
      if (photo) {
        const oldPath = path.join(__dirname, '..', 'uploads', 'students', photo);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      photo = req.file.filename;
    }

    const result = await pool.query(`
      UPDATE students SET
        first_name     = $1,  last_name      = $2,
        date_of_birth  = $3,  gender         = $4,
        class_id       = $5,  parent_name    = $6,
        parent_phone   = $7,  address        = $8,
        photo          = $9,  monthly_fee    = $10,
        discount_type  = $11, discount_value = $12,
        discount_note  = $13, is_active      = $14
      WHERE id = $15
      RETURNING *
    `, [
      first_name, last_name,
      date_of_birth || null, gender || null,
      class_id || null, parent_name || null,
      parent_phone || null, address || null,
      photo,
      parseFloat(monthly_fee) || 0,
      discount_type || 'none',
      parseFloat(discount_value) || 0,
      discount_note || null,
      is_active !== 'false',
      req.params.id,
    ]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  DELETE /api/students/:id
// ══════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT photo FROM students WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });

    const photo = existing.rows[0].photo;
    await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);

    if (photo) {
      const p = path.join(__dirname, '..', 'uploads', 'students', photo);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/students/:id/qr  — QR code as base64 PNG
// ══════════════════════════════════════════════════════════════
router.get('/:id/qr', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT student_code, first_name, last_name FROM students WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const { student_code, first_name, last_name } = result.rows[0];

    const qr = await QRCode.toDataURL(student_code, {
      width:           280,
      margin:          2,
      color:           { dark: '#1A4A5C', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });

    res.json({
      qr,
      student_code,
      name: `${first_name} ${last_name}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/students/qr/bulk  — all QR codes as JSON array
// ══════════════════════════════════════════════════════════════
router.get('/qr/bulk', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.student_code, s.first_name, s.last_name, c.name as class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.is_active = true
      ORDER BY s.first_name
    `);

    const items = await Promise.all(result.rows.map(async (s) => {
      const qr = await QRCode.toDataURL(s.student_code, {
        width: 200, margin: 1,
        color: { dark: '#1A4A5C', light: '#ffffff' },
      });
      return { ...s, qr };
    }));

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;