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
      class_id, parent_name, parent_phone, parent_phone2, address,
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
        parent_name, parent_phone, parent_phone2, address,
        photo, monthly_fee,
        discount_type, discount_value, discount_note,
        enrolled_at, previous_debt
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                COALESCE($17::date, CURRENT_DATE),$18)
      RETURNING *
    `, [
      student_code, barcode, first_name, last_name,
      date_of_birth || null, gender || null, class_id || null,
      parent_name || null, parent_phone || null, parent_phone2 || null, address || null,
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
      class_id, parent_name, parent_phone, parent_phone2, address,
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
        parent_phone   = $7,  parent_phone2  = $8,
        address        = $9,  photo          = $10,
        monthly_fee    = $11,
        discount_type  = $12, discount_value = $13,
        discount_note  = $14, is_active      = $15,
        enrolled_at    = COALESCE($16::date, enrolled_at),
        previous_debt  = $17
      WHERE id = $18
      RETURNING *
    `, [
      first_name, last_name,
      date_of_birth || null, gender || null,
      class_id || null, parent_name || null,
      parent_phone || null, parent_phone2 || null,
      address || null, photo,
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
  const client = await pool.connect();
  try {
    const { class_id } = req.body;
    if (!class_id) return res.status(400).json({ error: 'class_id is required' });

    const cls = await client.query('SELECT name, section FROM classes WHERE id = $1', [class_id]);
    const className   = cls.rows.length ? cls.rows[0].name : '';
    const classSection = cls.rows.length ? (cls.rows[0].section || '') : '';

    // Read the prior state BEFORE changing anything, so graduating a class
    // can be undone exactly like a promotion. Until this was added, the
    // Graduate button archived a whole class with no record of it at all —
    // the same gap that made the September incident unrecoverable.
    const before = await client.query(
      `SELECT id, first_name, last_name, student_code, parent_name, class_id,
              is_active, COALESCE(graduated, FALSE) AS graduated, graduated_at
         FROM students
        WHERE class_id = $1 AND is_active = TRUE`, [class_id]);

    if (!before.rows.length) {
      return res.json({ success: true, class_name: className, count: 0,
                        students: [], undoable: false });
    }

    const undoable = (await client.query(
      `SELECT to_regclass('public.student_class_history') AS t`)).rows[0].t !== null;
    const batchId  = require('crypto').randomUUID();
    const ids      = before.rows.map(r => r.id);

    await client.query('BEGIN');

    if (undoable) {
      await client.query(`
        INSERT INTO student_class_history
          (batch_id, student_id, action, from_class_id, to_class_id,
           was_active, was_graduated, was_graduated_at, changed_by)
        SELECT $1, x.student_id, 'graduate', $2::int, NULL,
               x.was_active, x.was_graduated, x.was_graduated_at, $3
          FROM UNNEST($4::int[], $5::bool[], $6::bool[], $7::date[])
               AS x(student_id, was_active, was_graduated, was_graduated_at)`,
        [batchId, class_id, (req.user && req.user.id) || null,
         ids,
         before.rows.map(r => r.is_active),
         before.rows.map(r => r.graduated),
         before.rows.map(r => r.graduated_at)]);
    }

    await client.query(`
      UPDATE students
         SET graduated = TRUE, graduated_at = CURRENT_DATE, is_active = FALSE
       WHERE id = ANY($1)`, [ids]);

    await client.query('COMMIT');

    res.json({
      success:    true,
      class_name: className,
      count:      before.rows.length,
      batch_id:   undoable ? batchId : null,
      undoable,
      students:   before.rows.map(s => ({
        name:         `${s.first_name} ${s.last_name || ''}`.trim(),
        father_name:  s.parent_name || '',
        class_name:   className,
        section:      classSection,
        student_code: s.student_code || '',
      })),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/students/promote  — year-end promotion
//  Every active student moves up one grade (class.grade_level is a
//  fixed Dari ordinal اول…دولسم = 1…12). Grade-12 (دولسم) students
//  graduate (archived). Section is preserved when a matching class
//  exists. Snapshot-based so order can't double-move anyone.
// ══════════════════════════════════════════════════════════════
// The grade ladder lives in src/grades.js so the Classes screen and the
// promotion logic can never disagree about what "one grade up" means.
const { GRADE_ORDER, gradeIndex, sameSection, normalize } = require('../grades.js');

router.post('/promote', async (req, res) => {
  try {
    // Preview mode: ?dry_run=1 or { dry_run: true } computes the whole plan
    // and returns it WITHOUT writing anything.
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true'
                || req.body?.dry_run === true;

    // Optional scope: promote ONE class instead of the whole school. A class
    // is a set of students, and moving one set up is far safer than moving
    // every set at once — the office can do it class by class and check as
    // it goes. Everything else (preview, audit trail, undo) is identical.
    const scopeClassId = req.body?.class_id ?? req.query.class_id ?? null;

    const classesRes = await pool.query(
      'SELECT id, name, grade_level, section FROM classes');
    const classes = classesRes.rows;
    const byId = {};
    classes.forEach(c => { byId[c.id] = c; });

    // Strict match: destination must share BOTH grade AND section.
    // No fallback to "any class at that grade" — 7-الف must go to 8-الف,
    // never to 8-ب. If the target class doesn't exist, those students
    // are reported as skipped so the admin can create it first.
    // Compared through grades.js's normaliser, so an invisible character or a
    // stray space in grade_level/section can never silently drop a class out
    // of the promotion.
    const findDest = (grade, section) =>
      classes.find(c =>
        gradeIndex(c.grade_level) === gradeIndex(grade) &&
        gradeIndex(grade) !== -1 &&
        sameSection(c.section, section)) || null;

    // is_active/graduated come along so the audit trail can record the
    // exact state each student was in BEFORE the run — that is what an
    // undo restores.
    const studentsRes = await pool.query(
      `SELECT id, first_name, last_name, student_code, parent_name, class_id,
              is_active, COALESCE(graduated, FALSE) AS graduated, graduated_at
         FROM students
        WHERE is_active = TRUE
          AND ($1::int IS NULL OR class_id = $1::int)`,
      [scopeClassId ? parseInt(scopeClassId, 10) : null]);

    const moves = {};          // "fromName→toName" → count
    const promoteUpdates = []; // { studentId, destId }
    const graduateIds = [];
    const graduateBefore = [];  // prior state of each graduate, for undo
    const graduateRows = [];
    const missingDest = {};    // label → count, for classes left where they are
    const orphans = new Map(); // class_id → { cls, nextGrade, students[] }
    let skippedUntracked = 0;  // students whose class has no grade set

    for (const s of studentsRes.rows) {
      const cls = byId[s.class_id];
      if (!cls || !cls.grade_level) { skippedUntracked++; continue; }
      const gi = GRADE_ORDER.indexOf(cls.grade_level);
      if (gi === -1) { skippedUntracked++; continue; }

      if (gi === GRADE_ORDER.length - 1) {            // دولسم → graduate
        graduateIds.push(s.id);
        graduateBefore.push({ studentId: s.id, fromId: s.class_id,
                              wasActive: s.is_active, wasGraduated: s.graduated,
                              wasGraduatedAt: s.graduated_at });
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
        // Orphaned class: this section has no counterpart in the grade above
        // (e.g. لسم (ج) when grade 11 has only الف and باء). Nothing is
        // assumed here — the admin chooses a destination in the preview.
        if (!orphans.has(cls.id)) orphans.set(cls.id, { cls, nextGrade, students: [] });
        orphans.get(cls.id).students.push(s);
        continue;
      }
      promoteUpdates.push({ studentId: s.id, destId: dest.id, fromId: s.class_id,
                            wasActive: s.is_active, wasGraduated: s.graduated,
                            wasGraduatedAt: s.graduated_at });
      const k = `${cls.name}${cls.section ? ' ' + cls.section : ''} → ${dest.name}${dest.section ? ' ' + dest.section : ''}`;
      moves[k] = (moves[k] || 0) + 1;
    }

    // ── Orphaned classes ───────────────────────────────────────────────
    // A section with no counterpart in the grade above. There is no safe
    // default here, so the admin decides per class in the preview:
    //   class:<id> → send them all to that one class
    //   split      → spread across the next grade, emptiest section first
    //   create     → create the missing section, move the class up intact
    //   stay       → leave them where they are (what happens if not asked)
    const decisions = (req.body && req.body.decisions) || {};
    // Projected headcount per destination, so a split fills the emptiest first.
    const projected = {};
    promoteUpdates.forEach(u => { projected[u.destId] = (projected[u.destId] || 0) + 1; });

    const needsDecision = [];
    const createPlans   = [];

    for (const [cid, o] of orphans) {
      const siblings = classes.filter(c => c.grade_level === o.nextGrade);
      const raw      = decisions[cid] !== undefined ? decisions[cid] : decisions[String(cid)];
      const choice   = String(raw == null || raw === '' ? 'stay' : raw);
      const newName  = (o.nextGrade + ' (' + (o.cls.section || '') + ')').replace(' ()', '');

      needsDecision.push({
        class_id:    cid,
        class_name:  o.cls.name,
        section:     o.cls.section || '',
        grade_level: o.cls.grade_level,
        next_grade:  o.nextGrade,
        students:    o.students.length,
        chosen:      choice,
        options: [
          ...siblings.map(c => ({ value: 'class:' + c.id, label: c.name,
                                  current: projected[c.id] || 0 })),
          ...(siblings.length > 1
              ? [{ value: 'split', label: 'Split evenly across ' + o.nextGrade }] : []),
          { value: 'create', label: 'Create ' + newName },
          { value: 'stay',   label: 'Leave them where they are' },
        ],
      });

      if (choice === 'create') {
        createPlans.push({ name: newName, grade_level: o.nextGrade,
                           section: o.cls.section || null, students: o.students });
        moves[o.cls.name + ' → ' + newName + ' (new class)'] = o.students.length;
        continue;
      }

      let targets = [];
      if (choice === 'split') {
        targets = siblings.slice();
      } else if (choice.startsWith('class:')) {
        const t = byId[parseInt(choice.slice(6), 10)];
        if (t && t.grade_level === o.nextGrade) targets = [t];
      }

      if (!targets.length) {           // 'stay', or a choice we can't use
        const k = o.cls.name + ' → ' + o.nextGrade + ' (no matching section)';
        missingDest[k] = (missingDest[k] || 0) + o.students.length;
        continue;
      }

      for (const s of o.students) {
        // Always fill the emptiest destination, so sections stay balanced.
        targets.sort((a, b) => (projected[a.id] || 0) - (projected[b.id] || 0));
        const t = targets[0];
        projected[t.id] = (projected[t.id] || 0) + 1;
        promoteUpdates.push({ studentId: s.id, destId: t.id, fromId: s.class_id,
                              wasActive: s.is_active, wasGraduated: s.graduated,
                              wasGraduatedAt: s.graduated_at });
        const mk = o.cls.name + ' → ' + t.name;
        moves[mk] = (moves[mk] || 0) + 1;
      }
    }

    // Students routed into a class that does not exist yet are counted here;
    // they only join promoteUpdates once the class is created, inside the
    // transaction below.
    const createCount   = createPlans.reduce((n, p) => n + p.students.length, 0);
    const promotedCount = promoteUpdates.length + createCount;

    const missing = Object.entries(missingDest)
      .map(([label, count]) => ({ label, count }));
    const skipped = skippedUntracked + missing.reduce((s, m) => s + m.count, 0);

    // Is the audit trail available? Without it a run cannot be undone, and
    // the caller must be told so before anything is applied.
    const undoable = (await pool.query(
      `SELECT to_regclass('public.student_class_history') AS t`)).rows[0].t !== null;

    // ── DRY RUN ───────────────────────────────────────────────────
    // Preview only: report exactly what WOULD happen and change nothing.
    // The admin screen calls this first so the plan can be confirmed.
    if (dryRun) {
      return res.json({
        success:   true,
        dry_run:   true,
        applied:   false,
        scope_class_id: scopeClassId ? parseInt(scopeClassId, 10) : null,
        undoable,
        needs_decision: needsDecision,
        promoted:  promotedCount,
        graduated: graduateIds.length,
        skipped,
        skipped_untracked: skippedUntracked,
        missing_destinations: missing,
        moves:         Object.entries(moves).map(([label, count]) => ({ label, count })),
        graduate_list: graduateRows,
      });
    }

    // Apply promotions + graduation atomically — a crash halfway through
    // would otherwise leave half the school moved up and half not.
    const batchId = require('crypto').randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Any destination section the admin asked us to create is created
      // first, inside the same transaction, so its students can be routed
      // into it and recorded in the audit trail like every other move.
      for (const p of createPlans) {
        const ins = await client.query(
          `INSERT INTO classes (name, grade_level, section)
           VALUES ($1, $2, $3) RETURNING id`,
          [p.name, p.grade_level, p.section]);
        const newId = ins.rows[0].id;
        for (const s of p.students) {
          promoteUpdates.push({ studentId: s.id, destId: newId, fromId: s.class_id,
                                wasActive: s.is_active, wasGraduated: s.graduated,
                                wasGraduatedAt: s.graduated_at });
        }
      }

      // Write the audit trail FIRST, in the same transaction: if history
      // cannot be recorded, the promotion does not happen either.
      if (undoable) {
        const rows = [
          ...promoteUpdates.map(u => ({ ...u, action: 'promote', toId: u.destId })),
          ...graduateBefore.map(g => ({ ...g, action: 'graduate', toId: null })),
        ];
        if (rows.length) {
          await client.query(`
            INSERT INTO student_class_history
              (batch_id, student_id, action, from_class_id, to_class_id,
               was_active, was_graduated, was_graduated_at, changed_by)
            SELECT $1, x.student_id, x.action, x.from_class_id, x.to_class_id,
                   x.was_active, x.was_graduated, x.was_graduated_at, $2
              FROM UNNEST($3::int[], $4::text[], $5::int[], $6::int[],
                          $7::bool[], $8::bool[], $9::date[])
                   AS x(student_id, action, from_class_id, to_class_id,
                        was_active, was_graduated, was_graduated_at)`,
            [batchId, (req.user && req.user.id) || null,
             rows.map(r => r.studentId), rows.map(r => r.action),
             rows.map(r => r.fromId ?? null), rows.map(r => r.toId ?? null),
             rows.map(r => r.wasActive ?? null), rows.map(r => r.wasGraduated ?? null),
             rows.map(r => r.wasGraduatedAt ?? null)]);
        }
      }

      for (const u of promoteUpdates) {
        await client.query('UPDATE students SET class_id = $1 WHERE id = $2',
          [u.destId, u.studentId]);
      }
      // Graduate the final grade (archive — kept in DB, off active lists)
      if (graduateIds.length) {
        await client.query(`
          UPDATE students
             SET graduated = TRUE, graduated_at = CURRENT_DATE, is_active = FALSE
           WHERE id = ANY($1)`, [graduateIds]);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (e.code === '23505') {
        return res.status(400).json({
          error: 'A class with that name already exists, so the new section could not be created. Nothing was changed. Rename the existing class or pick a different destination.',
        });
      }
      throw e;
    } finally {
      client.release();
    }

    res.json({
      success:         true,
      applied:         true,
      scope_class_id:  scopeClassId ? parseInt(scopeClassId, 10) : null,
      batch_id:        undoable ? batchId : null,
      undoable,
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
//  GET /api/students/promote/history — past promotion runs
//  Newest first. Each row is one promote run that can be undone.
// ══════════════════════════════════════════════════════════════
router.get('/promote/history', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT h.batch_id,
             MIN(h.changed_at)                                   AS run_at,
             COUNT(*) FILTER (WHERE h.action = 'promote') ::int   AS promoted,
             COUNT(*) FILTER (WHERE h.action = 'graduate')::int   AS graduated,
             COUNT(*) FILTER (WHERE h.undone_at IS NULL) ::int    AS still_applied,
             MAX(h.undone_at)                                    AS undone_at,
             MAX(u.full_name)                                    AS changed_by
        FROM student_class_history h
        LEFT JOIN admin_users u ON u.id = h.changed_by
       GROUP BY h.batch_id
       ORDER BY MIN(h.changed_at) DESC
       LIMIT 20`);
    res.json(r.rows.map(x => ({ ...x, undone: x.still_applied === 0 })));
  } catch (err) {
    if (/student_class_history/.test(err.message)) {
      return res.json([]);   // migration not run yet — no history to show
    }
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/students/promote/undo — reverse a promotion
//  Body: { batch_id, class_id }  — both optional.
//    neither      → undo the most recent run, whole school
//    class_id     → undo only the students promoted OUT of that class,
//                   from the most recent run that still affects it
//    batch_id     → target a specific run instead of the latest one
//
//  Puts every student in the batch back into the class they were in
//  before that run, and un-archives anyone the run graduated. Nothing
//  is deleted: the history rows are kept and stamped undone_at.
//
//  NOTE: this restores the recorded previous class. If someone has
//  manually moved a student since the run, that manual move is
//  overwritten for the students in this batch.
// ══════════════════════════════════════════════════════════════
router.post('/promote/undo', async (req, res) => {
  const client = await pool.connect();
  try {
    const wanted  = req.body && req.body.batch_id ? String(req.body.batch_id) : null;
    const classId = req.body && req.body.class_id != null && req.body.class_id !== ''
      ? parseInt(req.body.class_id, 10) : null;

    // Newest run that still has un-undone rows matching the scope.
    const pick = await client.query(
      `SELECT batch_id FROM student_class_history
        WHERE undone_at IS NULL
          AND ($1::text IS NULL OR batch_id      = $1::text)
          AND ($2::int  IS NULL OR from_class_id = $2::int)
        ORDER BY changed_at DESC LIMIT 1`,
      [wanted, classId]);

    if (!pick.rows.length) {
      return res.status(404).json({
        error: classId
          ? 'This class has no promotion left to undo — it was never promoted, or it has already been put back.'
          : wanted
            ? 'That promotion run was not found, or it has already been undone.'
            : 'There is no promotion run on record to undo.',
      });
    }
    const batchId = pick.rows[0].batch_id;

    await client.query('BEGIN');

    // Students who were moved up a grade → back to their old class
    const back = await client.query(`
      UPDATE students s
         SET class_id = h.from_class_id
        FROM student_class_history h
       WHERE h.batch_id = $1 AND h.undone_at IS NULL
         AND ($2::int IS NULL OR h.from_class_id = $2::int)
         AND h.action = 'promote' AND s.id = h.student_id`, [batchId, classId]);

    // Students the run archived as graduates → fully restored
    const ungrad = await client.query(`
      UPDATE students s
         SET class_id     = h.from_class_id,
             is_active    = COALESCE(h.was_active, TRUE),
             graduated    = COALESCE(h.was_graduated, FALSE),
             graduated_at = h.was_graduated_at
        FROM student_class_history h
       WHERE h.batch_id = $1 AND h.undone_at IS NULL
         AND ($2::int IS NULL OR h.from_class_id = $2::int)
         AND h.action = 'graduate' AND s.id = h.student_id`, [batchId, classId]);

    await client.query(
      `UPDATE student_class_history SET undone_at = NOW()
        WHERE batch_id = $1 AND undone_at IS NULL
          AND ($2::int IS NULL OR from_class_id = $2::int)`, [batchId, classId]);

    await client.query('COMMIT');

    res.json({
      success:      true,
      batch_id:     batchId,
      class_id:     classId,
      restored:     back.rowCount,
      ungraduated:  ungrad.rowCount,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (/student_class_history/.test(err.message)) {
      return res.status(400).json({
        error: 'No promotion history in this database. Run db/migration_promotion_history.sql first — from then on every promotion can be undone.',
      });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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