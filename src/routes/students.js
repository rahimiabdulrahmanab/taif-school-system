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
      enrolled_at, previous_debt,
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
        discount_type, discount_value, discount_note,
        enrolled_at, previous_debt
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                COALESCE($16::date, CURRENT_DATE),$17)
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
      enrolled_at || null,
      Math.max(0, parseFloat(previous_debt) || 0),
    ]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
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
      is_active, enrolled_at, previous_debt,
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
        discount_note  = $13, is_active      = $14,
        enrolled_at    = COALESCE($15::date, enrolled_at),
        previous_debt  = $16
      WHERE id = $17
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
      enrolled_at || null,
      Math.max(0, parseFloat(previous_debt) || 0),
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

// ══════════════════════════════════════════════════════════════
//  POST /api/students/graduate  — archive a class as Graduated
//  Body: { class_id }. Marks every active student in the class
//  graduated (kept in DB, dropped from active lists). Returns the
//  graduate list (name, father, class) for printing.
// ══════════════════════════════════════════════════════════════
router.post('/graduate', async (req, res) => {
  try {
    const { class_id } = req.body;
    if (!class_id) return res.status(400).json({ error: 'class_id is required' });

    const cls = await pool.query('SELECT name, section FROM classes WHERE id = $1', [class_id]);
    const className = cls.rows.length ? cls.rows[0].name : '';
    const classSection = cls.rows.length ? (cls.rows[0].section || '') : '';

    let graduated = [];
    try {
      const r = await pool.query(`
        UPDATE students
           SET graduated = TRUE, graduated_at = CURRENT_DATE, is_active = FALSE
         WHERE class_id = $1 AND is_active = TRUE
         RETURNING id, first_name, last_name, student_code, parent_name`,
        [class_id]
      );
      graduated = r.rows;
    } catch (e) {
      // graduated columns missing → degrade to just deactivating
      if (/graduated/.test(e.message)) {
        const r = await pool.query(`
          UPDATE students SET is_active = FALSE
           WHERE class_id = $1 AND is_active = TRUE
           RETURNING id, first_name, last_name, student_code, parent_name`,
          [class_id]
        );
        graduated = r.rows;
      } else { throw e; }
    }

    res.json({
      success:    true,
      class_name: className,
      count:      graduated.length,
      students:   graduated.map(s => ({
        name:        `${s.first_name} ${s.last_name}`,
        father_name: s.parent_name || '',
        class_name:  className,
        section:     classSection,
        student_code: s.student_code || '',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/students/promote  — year-end promotion
//  Every active student moves up one grade (class.grade_level is a
//  fixed Dari ordinal اول…دولسم = 1…12). Grade-12 (دولسم) students
//  graduate (archived). Section is preserved when a matching class
//  exists. Snapshot-based so order can't double-move anyone.
// ══════════════════════════════════════════════════════════════
const GRADE_ORDER = ['اول','دوهم','دریم','څلورم','پنځم','شپږم',
                     'اووم','اتم','نهم','لسم','یوولسم','دولسم'];

router.post('/promote', async (req, res) => {
  try {
    const classesRes = await pool.query(
      'SELECT id, name, grade_level, section FROM classes');
    const classes = classesRes.rows;
    const byId = {};
    classes.forEach(c => { byId[c.id] = c; });

    // Strict match: destination must share BOTH grade AND section.
    // No fallback to "any class at that grade" — 7-الف must go to 8-الف,
    // never to 8-ب. If the target class doesn't exist, those students
    // are reported as skipped so the admin can create it first.
    const findDest = (grade, section) =>
      classes.find(c =>
        c.grade_level === grade &&
        (c.section || '').trim() === (section || '').trim()) || null;

    const studentsRes = await pool.query(
      `SELECT id, first_name, last_name, student_code, parent_name, class_id
         FROM students WHERE is_active = TRUE`);

    const moves = {};          // "fromName→toName" → count
    const promoteUpdates = []; // { studentId, destId }
    const graduateIds = [];
    const graduateRows = [];
    const missingDest = {};    // "<grade> <section>" → count — destinations to create
    let skippedUntracked = 0;  // students whose class has no grade set

    for (const s of studentsRes.rows) {
      const cls = byId[s.class_id];
      if (!cls || !cls.grade_level) { skippedUntracked++; continue; }
      const gi = GRADE_ORDER.indexOf(cls.grade_level);
      if (gi === -1) { skippedUntracked++; continue; }

      if (gi === GRADE_ORDER.length - 1) {            // دولسم → graduate
        graduateIds.push(s.id);
        graduateRows.push({
          name: `${s.first_name} ${s.last_name}`,
          father_name: s.parent_name || '',
          class_name: cls.name,
          section: cls.section || '',
          student_code: s.student_code || '',
        });
        continue;
      }
      const nextGrade = GRADE_ORDER[gi + 1];
      const dest = findDest(nextGrade, cls.section);
      if (!dest) {
        const k = `${nextGrade}${cls.section ? ' ' + cls.section : ''}`;
        missingDest[k] = (missingDest[k] || 0) + 1;
        continue;
      }
      promoteUpdates.push({ studentId: s.id, destId: dest.id });
      const k = `${cls.name}${cls.section ? ' ' + cls.section : ''} → ${dest.name}${dest.section ? ' ' + dest.section : ''}`;
      moves[k] = (moves[k] || 0) + 1;
    }

    // Apply promotions
    for (const u of promoteUpdates) {
      await pool.query('UPDATE students SET class_id = $1 WHERE id = $2',
        [u.destId, u.studentId]);
    }
    // Graduate the final grade (archive — kept in DB, off active lists)
    if (graduateIds.length) {
      try {
        await pool.query(`
          UPDATE students
             SET graduated = TRUE, graduated_at = CURRENT_DATE, is_active = FALSE
           WHERE id = ANY($1)`, [graduateIds]);
      } catch (e) {
        if (/graduated/.test(e.message)) {
          await pool.query('UPDATE students SET is_active = FALSE WHERE id = ANY($1)', [graduateIds]);
        } else { throw e; }
      }
    }

    const missing = Object.entries(missingDest)
      .map(([label, count]) => ({ label, count }));
    const skipped = skippedUntracked + missing.reduce((s, m) => s + m.count, 0);

    res.json({
      success:         true,
      promoted:        promoteUpdates.length,
      graduated:       graduateIds.length,
      skipped,
      skipped_untracked: skippedUntracked,
      missing_destinations: missing,
      moves:          Object.entries(moves).map(([label, count]) => ({ label, count })),
      graduate_list:  graduateRows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /api/students/graduates  — all archived/graduated students
// ══════════════════════════════════════════════════════════════
router.get('/list/graduates', async (req, res) => {
  try {
    let q;
    try {
      q = await pool.query(`
        SELECT s.id, s.first_name, s.last_name, s.parent_name, s.student_code,
               s.photo, s.graduated_at,
               c.name AS class_name, c.section, c.grade_level
          FROM students s
          LEFT JOIN classes c ON c.id = s.class_id
         WHERE s.graduated = TRUE
         ORDER BY s.graduated_at DESC NULLS LAST, s.last_name, s.first_name
      `);
    } catch (e) {
      if (/graduated/.test(e.message)) {
        q = await pool.query(`
          SELECT s.id, s.first_name, s.last_name, s.parent_name, s.student_code,
                 s.photo, NULL::date AS graduated_at,
                 c.name AS class_name, c.section, c.grade_level
            FROM students s
            LEFT JOIN classes c ON c.id = s.class_id
           WHERE s.is_active = FALSE
           ORDER BY s.last_name, s.first_name
        `);
      } else { throw e; }
    }
    res.json(q.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/students/:id/restore  — un-graduate a student
// ══════════════════════════════════════════════════════════════
router.post('/:id/restore', async (req, res) => {
  try {
    try {
      await pool.query(
        `UPDATE students SET graduated = FALSE, graduated_at = NULL, is_active = TRUE WHERE id = $1`,
        [req.params.id]);
    } catch (e) {
      if (/graduated/.test(e.message)) {
        await pool.query('UPDATE students SET is_active = TRUE WHERE id = $1', [req.params.id]);
      } else { throw e; }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;