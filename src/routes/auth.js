const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const pool     = require('../db');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'taif-school-jwt-secret-change-in-production';

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });

    const result = await pool.query(
      'SELECT * FROM admin_users WHERE username = $1', [username]
    );
    if (!result.rows.length)
      return res.status(401).json({ error: 'Invalid username or password' });

    const user  = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid username or password' });

    const role      = user.role || 'admin';
    const teacherId = user.teacher_id || null;

    const token = jwt.sign(
      { id: user.id, username: user.username, full_name: user.full_name, role, teacher_id: teacherId },
      SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role, teacher_id: teacherId },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token' });

  try {
    const user = jwt.verify(header.slice(7), SECRET);
    res.json({ id: user.id, username: user.username, full_name: user.full_name, role: user.role, teacher_id: user.teacher_id });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res) => {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const user = jwt.verify(header.slice(7), SECRET);
    const { current_password, new_password } = req.body;

    if (!new_password || new_password.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const result = await pool.query('SELECT * FROM admin_users WHERE id=$1', [user.id]);
    const valid  = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE admin_users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    res.json({ success: true });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

module.exports = router;
