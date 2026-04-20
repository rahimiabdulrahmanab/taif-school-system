const express = require('express');
const pool    = require('../db.js');
const router  = express.Router();

// GET all classes with student count and teachers list
router.get('/', async (req, res) => {
  try {
    const clsResult = await pool.query(`SELECT * FROM classes ORDER BY name`);
    const classes   = clsResult.rows;

    const enriched = await Promise.all(classes.map(async (c) => {
      const countRes = await pool.query(
        `SELECT COUNT(*)::integer AS cnt FROM students WHERE class_id = $1`, [c.id]
      );
      const teachersRes = await pool.query(`
        SELECT t.id, t.first_name, t.last_name, ct.subject
        FROM class_teachers ct
        JOIN teachers t ON t.id = ct.teacher_id
        WHERE ct.class_id = $1
        ORDER BY t.first_name
      `, [c.id]);

      return {
        ...c,
        student_count: countRes.rows[0].cnt,
        teachers:      teachersRes.rows,
      };
    }));

    res.json(enriched);
  } catch (err) {
    console.error('GET /api/classes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET single class with students and teachers
router.get('/:id', async (req, res) => {
  try {
    const cls = await pool.query(`SELECT * FROM classes WHERE id = $1`, [req.params.id]);
    if (!cls.rows.length) return res.status(404).json({ error: 'Not found' });

    const students = await pool.query(
      `SELECT id, first_name, last_name, student_code, photo
       FROM students WHERE class_id = $1 ORDER BY first_name, last_name`,
      [req.params.id]
    );

    const teachers = await pool.query(`
      SELECT t.id, t.first_name, t.last_name, t.photo, ct.subject
      FROM class_teachers ct
      JOIN teachers t ON t.id = ct.teacher_id
      WHERE ct.class_id = $1
      ORDER BY t.first_name
    `, [req.params.id]);

    res.json({ ...cls.rows[0], students: students.rows, teachers: teachers.rows });
  } catch (err) {
    console.error('GET /api/classes/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST create class
router.post('/', async (req, res) => {
  try {
    const { name, grade_level, section, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Class name is required' });
    const result = await pool.query(`
      INSERT INTO classes (name, grade_level, section, description)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [name, grade_level||null, section||null, description||null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A class with this name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT update class
router.put('/:id', async (req, res) => {
  try {
    const { name, grade_level, section, description } = req.body;
    const result = await pool.query(`
      UPDATE classes SET name=$1, grade_level=$2, section=$3, description=$4
      WHERE id=$5 RETURNING *
    `, [name, grade_level||null, section||null, description||null, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A class with this name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE class
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('UPDATE students SET class_id = NULL WHERE class_id = $1', [req.params.id]);
    await pool.query('DELETE FROM class_teachers WHERE class_id = $1', [req.params.id]);
    await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT assign student to class
router.put('/:id/assign-student', async (req, res) => {
  try {
    const { student_id } = req.body;
    await pool.query('UPDATE students SET class_id = $1 WHERE id = $2', [req.params.id, student_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT remove student from class
router.put('/:id/remove-student/:student_id', async (req, res) => {
  try {
    await pool.query('UPDATE students SET class_id = NULL WHERE id = $1', [req.params.student_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST assign teacher to class (with subject)
router.post('/:id/assign-teacher', async (req, res) => {
  try {
    const { teacher_id, subject } = req.body;
    await pool.query(`
      INSERT INTO class_teachers (class_id, teacher_id, subject)
      VALUES ($1, $2, $3)
      ON CONFLICT (class_id, teacher_id) DO UPDATE SET subject = $3
    `, [req.params.id, teacher_id, subject||null]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE remove teacher from class
router.delete('/:id/remove-teacher/:teacher_id', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM class_teachers WHERE class_id = $1 AND teacher_id = $2',
      [req.params.id, req.params.teacher_id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;