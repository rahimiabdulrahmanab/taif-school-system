const express = require('express');
const pool    = require('../db.js');
const router  = express.Router();

router.get('/subjects/:class_id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, t.first_name || ' ' || t.last_name AS teacher_name
      FROM subjects s
      LEFT JOIN teachers t ON t.id = s.teacher_id
      WHERE s.class_id = $1 ORDER BY s.name
    `, [req.params.class_id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/subjects', async (req, res) => {
  try {
    const { class_id, name, teacher_id, max_midterm, max_final } = req.body;
    const result = await pool.query(`
      INSERT INTO subjects (class_id, name, teacher_id, max_midterm, max_final)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (class_id, name) DO UPDATE SET teacher_id=$3, max_midterm=$4, max_final=$5
      RETURNING *
    `, [class_id, name, teacher_id||null, max_midterm||40, max_final||60]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/subjects/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM marks WHERE subject_id=$1', [req.params.id]);
    await pool.query('DELETE FROM subjects WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/marks', async (req, res) => {
  try {
    const { class_id, subject_id } = req.query;
    const students = await pool.query(
      `SELECT id, first_name, last_name, student_code, photo FROM students WHERE class_id=$1 ORDER BY first_name, last_name`,
      [class_id]
    );
    const marksRes = await pool.query(`SELECT * FROM marks WHERE subject_id=$1`, [subject_id]);
    const marksMap = {};
    marksRes.rows.forEach(m => {
      if (!marksMap[m.student_id]) marksMap[m.student_id] = {};
      marksMap[m.student_id][m.term] = m;
    });
    const subRes  = await pool.query('SELECT * FROM subjects WHERE id=$1', [subject_id]);
    const subject = subRes.rows[0] || { max_midterm: 40, max_final: 60 };
    const result  = students.rows.map(s => {
      const midRow   = marksMap[s.id] ? marksMap[s.id]['midterm'] : null;
      const finRow   = marksMap[s.id] ? marksMap[s.id]['final']   : null;
      const midScore = midRow ? parseFloat(midRow.score) : null;
      const finScore = finRow ? parseFloat(finRow.score) : null;
      const total    = (midScore !== null && finScore !== null) ? midScore + finScore : null;
      const maxTotal = (subject.max_midterm || 40) + (subject.max_final || 60);
      return {
        ...s,
        midterm_score: midScore,
        final_score:   finScore,
        total,
        max_total:     maxTotal,
        passed:        total !== null ? total >= 50 : null,
        grade:         total !== null ? getGrade(total, maxTotal) : null,
      };
    });
    res.json({ students: result, subject });
  } catch (err) {
    console.error('GET /api/grades/marks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/marks', async (req, res) => {
  try {
    const { student_id, subject_id, exam_type, score } = req.body;
    const subRes   = await pool.query('SELECT * FROM subjects WHERE id=$1', [subject_id]);
    if (!subRes.rows.length) return res.status(404).json({ error: 'Subject not found' });
    const subject  = subRes.rows[0];
    const maxScore = exam_type === 'midterm' ? (subject.max_midterm || 40) : (subject.max_final || 60);
    if (parseFloat(score) > maxScore) return res.status(400).json({ error: `Score cannot exceed ${maxScore}` });
    const year   = new Date().getFullYear().toString();
    const result = await pool.query(`
      INSERT INTO marks (student_id, subject_id, term, score, max_score, academic_year)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (student_id, subject_id, term) DO UPDATE SET score=$4
      RETURNING *
    `, [student_id, subject_id, exam_type, score, maxScore, year]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/grades/marks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/transcript/:student_id', async (req, res) => {
  try {
    const student = await pool.query(
      `SELECT s.*, c.name as class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=$1`,
      [req.params.student_id]
    );
    if (!student.rows.length) return res.status(404).json({ error: 'Not found' });
    const s = student.rows[0];
    if (!s.class_id) return res.json({ student: s, subjects: [] });
    const subjects = await pool.query(
      `SELECT sub.*, t.first_name||' '||t.last_name AS teacher_name FROM subjects sub LEFT JOIN teachers t ON t.id=sub.teacher_id WHERE sub.class_id=$1 ORDER BY sub.name`,
      [s.class_id]
    );
    const transcript = await Promise.all(subjects.rows.map(async (sub) => {
      const marks    = await pool.query(`SELECT * FROM marks WHERE student_id=$1 AND subject_id=$2`, [s.id, sub.id]);
      const midRow   = marks.rows.find(m => m.term === 'midterm');
      const finRow   = marks.rows.find(m => m.term === 'final');
      const midScore = midRow ? parseFloat(midRow.score) : null;
      const finScore = finRow ? parseFloat(finRow.score) : null;
      const total    = (midScore !== null && finScore !== null) ? midScore + finScore : null;
      const maxTotal = (sub.max_midterm || 40) + (sub.max_final || 60);
      return {
        subject_name:  sub.name,
        teacher_name:  sub.teacher_name,
        midterm_score: midScore,
        max_midterm:   sub.max_midterm || 40,
        final_score:   finScore,
        max_final:     sub.max_final || 60,
        total,
        max_total:     maxTotal,
        passed:        total !== null ? total >= 50 : null,
        mid_passed:    midScore !== null ? midScore >= 16 : null,
        grade:         total !== null ? getGrade(total, maxTotal) : null,
      };
    }));
    res.json({ student: s, subjects: transcript });
  } catch (err) {
    console.error('GET /api/grades/transcript error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function getGrade(score, max) {
  const pct = (score / max) * 100;
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B+';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  return 'F';
}

module.exports = router;