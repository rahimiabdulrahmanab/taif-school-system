// ── School holiday (non-billable / unpaid) months ─────────────
// Afghan schools close for Sartan (4) and Asad (5). Taif charges no
// student fee and pays no salary for those months.
//
// Stored school-wide as a comma-separated list of Shamsi month numbers
// in settings.non_billable_months, so one setting drives both the fee
// ledger and payroll — they can never disagree.
const pool = require('./db');

const DEFAULT_HOLIDAY_MONTHS = [4, 5];   // سرطان، اسد

async function getHolidayMonths() {
  try {
    const r = await pool.query(
      `SELECT value FROM settings WHERE key = 'non_billable_months'`);
    if (!r.rows.length || r.rows[0].value == null) return new Set(DEFAULT_HOLIDAY_MONTHS);
    const raw = String(r.rows[0].value).trim();
    if (raw === '') return new Set();    // explicitly cleared → every month is normal
    return new Set(raw.split(',')
      .map(x => parseInt(x.trim(), 10))
      .filter(n => n >= 1 && n <= 12));
  } catch (_) {
    return new Set(DEFAULT_HOLIDAY_MONTHS);
  }
}

module.exports = { DEFAULT_HOLIDAY_MONTHS, getHolidayMonths };
