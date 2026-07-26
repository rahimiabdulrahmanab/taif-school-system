// Current academic year for marks/grades records.
// Comes from Settings → academic_year so next year's marks are stored as a
// new set instead of overwriting this year's (transcript history survives).
const pool   = require('./db');
const CONFIG = require('../school-config');

async function currentAcademicYear() {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'academic_year'`);
    if (r.rows.length && r.rows[0].value) return String(r.rows[0].value).trim();
  } catch (_) { /* settings table missing — fall through */ }
  return String(CONFIG.current_year || new Date().getFullYear());
}

module.exports = { currentAcademicYear };
