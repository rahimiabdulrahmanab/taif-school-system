const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('../db.js');
const router  = express.Router();

// All routes here require a valid teacher JWT (enforced in server.js)
// req.user = { id, username, role, teacher_id }

function requireTeacher(req, res, next) {
  if (!req.user || req.user.role !== 'teacher' || !req.user.teacher_id) {
    return res.status(403).json({ error: 'Teacher account required' });
  }
  next();
}

// ── GET /api/teacher/profile ──────────────────────────────────
router.get('/profile', requireTeacher, async (req, res) => {
  try {
    const t = await pool.query(
      `SELECT id, first_name, last_name, teacher_code, subject, phone, photo
       FROM teachers WHERE id = $1`,
      [req.user.teacher_id]
    );
    if (!t.rows.length) return res.status(404).json({ error: 'Teacher not found' });
    res.json({ ...t.rows[0], username: req.user.username });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/teacher/subjects ─────────────────────────────────
// Returns all subjects assigned to this teacher, grouped with class info
router.get('/subjects', requireTeacher, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id, s.name AS subject_name, s.max_midterm, s.max_final,
        c.id AS class_id, c.name AS class_name, c.grade AS class_grade,
        -- Count students in class
        (SELECT COUNT(*) FROM students WHERE class_id = c.id AND is_active = true)::int AS student_count,
        -- Midterm status
        (SELECT status FROM marks
         WHERE subject_id = s.id AND exam_type = 'midterm'
         LIMIT 1) AS midterm_status,
        -- Final status
        (SELECT status FROM marks
         WHERE subject_id = s.id AND exam_type = 'final'
         LIMIT 1) AS final_status,
        -- Midterm marks count
        (SELECT COUNT(*) FROM marks WHERE subject_id = s.id AND exam_type = 'midterm')::int AS midterm_count,
        -- Final marks count
        (SELECT COUNT(*) FROM marks WHERE subject_id = s.id AND exam_type = 'final')::int AS final_count
      FROM subjects s
      JOIN classes c ON c.id = s.class_id
      WHERE s.teacher_id = $1
      ORDER BY c.name, s.name
    `, [req.user.teacher_id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/teacher/marks/:subject_id/:exam_type ─────────────
router.get('/marks/:subject_id/:exam_type', requireTeacher, async (req, res) => {
  try {
    const { subject_id, exam_type } = req.params;
    if (!['midterm','final'].includes(exam_type))
      return res.status(400).json({ error: 'exam_type must be midterm or final' });

    // Verify subject belongs to this teacher
    const subRes = await pool.query(
      `SELECT s.*, c.name AS class_name, c.grade AS class_grade
       FROM subjects s JOIN classes c ON c.id = s.class_id
       WHERE s.id = $1 AND s.teacher_id = $2`,
      [subject_id, req.user.teacher_id]
    );
    if (!subRes.rows.length)
      return res.status(403).json({ error: 'Access denied or subject not found' });
    const subject = subRes.rows[0];

    const students = await pool.query(
      `SELECT id, first_name, last_name, student_code, photo
       FROM students WHERE class_id = $1 AND is_active = true
       ORDER BY first_name, last_name`,
      [subject.class_id]
    );

    const marksRes = await pool.query(
      `SELECT * FROM marks WHERE subject_id = $1 AND exam_type = $2`,
      [subject_id, exam_type]
    );
    const marksMap = {};
    marksRes.rows.forEach(m => { marksMap[m.student_id] = m; });

    // Determine submission status for this exam_type
    const statuses = marksRes.rows.map(m => m.status).filter(Boolean);
    let batchStatus = 'empty';
    if (statuses.length > 0) {
      if (statuses.every(s => s === 'approved')) batchStatus = 'approved';
      else if (statuses.some(s => s === 'submitted')) batchStatus = 'submitted';
      else if (statuses.some(s => s === 'rejected')) batchStatus = 'rejected';
      else batchStatus = 'draft';
    }

    const rejectionNote = marksRes.rows.find(m => m.rejection_note)?.rejection_note || null;

    res.json({
      subject,
      exam_type,
      batch_status: batchStatus,
      rejection_note: rejectionNote,
      max_score: exam_type === 'midterm' ? (subject.max_midterm || 40) : (subject.max_final || 60),
      students: students.rows.map(s => ({
        ...s,
        score:  marksMap[s.id]?.score  ?? null,
        status: marksMap[s.id]?.status ?? null,
        mark_id: marksMap[s.id]?.id    ?? null,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/teacher/marks/save ──────────────────────────────
// Save marks as draft (can edit anytime until submitted)
router.post('/marks/save', requireTeacher, async (req, res) => {
  try {
    const { subject_id, exam_type, marks } = req.body;
    // marks = [{ student_id, score }]
    if (!subject_id || !exam_type || !Array.isArray(marks))
      return res.status(400).json({ error: 'subject_id, exam_type, and marks array required' });

    // Verify teacher owns this subject
    const subRes = await pool.query(
      'SELECT * FROM subjects WHERE id=$1 AND teacher_id=$2',
      [subject_id, req.user.teacher_id]
    );
    if (!subRes.rows.length) return res.status(403).json({ error: 'Access denied' });
    const subject  = subRes.rows[0];
    const maxScore = exam_type === 'midterm' ? (subject.max_midterm || 40) : (subject.max_final || 60);
    const year     = new Date().getFullYear().toString();

    // Approved marks can be re-edited — they revert to draft for re-approval

    let saved = 0;
    for (const m of marks) {
      const score = parseFloat(m.score);
      if (m.score === '' || m.score === null || m.score === undefined) continue;
      if (isNaN(score) || score < 0 || score > maxScore) continue;
      await pool.query(`
        INSERT INTO marks
          (student_id, subject_id, exam_type, term, score, max_score, academic_year, status, submitted_by)
        VALUES ($1,$2,$3,$3,$4,$5,$6,'draft',$7)
        ON CONFLICT (student_id, subject_id, exam_type)
        DO UPDATE SET score=$4, status='draft', submitted_by=$7
      `, [m.student_id, subject_id, exam_type, score, maxScore, year, req.user.id]);
      saved++;
    }

    res.json({ success: true, saved, message: `${saved} marks saved as draft` });
  } catch (err) {
    console.error('POST /api/teacher/marks/save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/teacher/marks/submit ────────────────────────────
// Submit all draft marks for this subject+exam_type for admin approval
router.post('/marks/submit', requireTeacher, async (req, res) => {
  try {
    const { subject_id, exam_type } = req.body;

    const subRes = await pool.query(
      'SELECT * FROM subjects WHERE id=$1 AND teacher_id=$2',
      [subject_id, req.user.teacher_id]
    );
    if (!subRes.rows.length) return res.status(403).json({ error: 'Access denied' });

    const draftRes = await pool.query(
      `SELECT COUNT(*) FROM marks WHERE subject_id=$1 AND exam_type=$2 AND status IN ('draft','rejected')`,
      [subject_id, exam_type]
    );
    if (parseInt(draftRes.rows[0].count) === 0)
      return res.status(400).json({ error: 'No draft marks to submit. Please save marks first.' });

    await pool.query(`
      UPDATE marks
      SET status='submitted', submitted_at=NOW(), rejection_note=NULL
      WHERE subject_id=$1 AND exam_type=$2 AND status IN ('draft','rejected')
    `, [subject_id, exam_type]);

    res.json({ success: true, message: 'Marks submitted for admin approval' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
