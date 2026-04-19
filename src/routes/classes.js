const express = require('express');
const pool    = require('../db');
const router  = express.Router();

// GET all classes with student count and teacher name
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.*,
        t.first_name || ' ' || t.last_name AS teacher_name,
        COUNT(s.id)::integer AS student_count
      FROM classes c
      LEFT JOIN teachers t ON t.id = c.teacher_id
      LEFT JOIN students s ON s.class_id = c.id AND s.is_active = true
      GROUP BY c.id, t.first_name, t.last_name
      ORDER BY c.name
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single class with its students
router.get('/:id', async (req, res) => {
  try {
    const cls = await pool.query(`
      SELECT c.*, t.first_name || ' ' || t.last_name AS teacher_name
      FROM classes c
      LEFT JOIN teachers t ON t.id = c.teacher_id
      WHERE c.id = $1
    `, [req.params.id]);
    if (!cls.rows.length) return res.status(404).json({ error: 'Not found' });

    const students = await pool.query(`
      SELECT id, first_name, last_name, student_code, photo
      FROM students WHERE class_id = $1 AND is_active = true
      ORDER BY first_name, last_name
    `, [req.params.id]);

    res.json({ ...cls.rows[0], students: students.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create class
router.post('/', async (req, res) => {
  try {
    const { name, grade_level, section, teacher_id, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Class name is required' });
    const result = await pool.query(`
      INSERT INTO classes (name, grade_level, section, teacher_id, description)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [name, grade_level||null, section||null, teacher_id||null, description||null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A class with this name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT update class
router.put('/:id', async (req, res) => {
  try {
    const { name, grade_level, section, teacher_id, description } = req.body;
    const result = await pool.query(`
      UPDATE classes SET name=$1, grade_level=$2, section=$3, teacher_id=$4, description=$5
      WHERE id=$6 RETURNING *
    `, [name, grade_level||null, section||null, teacher_id||null, description||null, req.params.id]);
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
    await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT assign student to class (moves student, removes from old class)
router.put('/:id/assign-student', async (req, res) => {
  try {
    const { student_id } = req.body;
    // One student = one class only
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

module.exports = router;