const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const pool     = require('../db');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'taif-school-jwt-secret-change-in-production';

// ── Login rate limiting ───────────────────────────────────────
// In-memory: after MAX_FAILS failed attempts for one (ip, username) pair
// within WINDOW_MS, further attempts are rejected until the window expires.
// Protects the admin account from online brute force without any new deps.
const MAX_FAILS  = 8;
const WINDOW_MS  = 15 * 60 * 1000;
const _fails = new Map(); // key -> { count, first }

function _failKey(req, username) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || '?';
  return `${ip}|${(username || '').toLowerCase()}`;
}
function isLockedOut(key) {
  const e = _fails.get(key);
  if (!e) return false;
  if (Date.now() - e.first > WINDOW_MS) { _fails.delete(key); return false; }
  return e.count >= MAX_FAILS;
}
function recordFail(key) {
  const e = _fails.get(key);
  if (!e || Date.now() - e.first > WINDOW_MS) _fails.set(key, { count: 1, first: Date.now() });
  else e.count++;
  // keep the map from growing forever
  if (_fails.size > 5000) {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [k, v] of _fails) if (v.first < cutoff) _fails.delete(k);
  }
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });

    const rlKey = _failKey(req, username);
    if (isLockedOut(rlKey)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }

    const result = await pool.query(
      'SELECT * FROM admin_users WHERE username = $1', [username]
    );
    if (!result.rows.length) {
      recordFail(rlKey);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user  = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      recordFail(rlKey);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    _fails.delete(rlKey);

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
