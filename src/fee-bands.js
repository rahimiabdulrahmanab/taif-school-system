// ── What a grade costs ────────────────────────────────────────
// Taif charges by grade, not by student: everyone in آمادګي through دریم pays
// the same monthly fee, everyone in څلورم through اووم pays the next one, and
// so on. A student's own discount is applied on top of this and is never
// touched by a change of grade — a family on a 200 discount keeps it when the
// child moves up; only the amount it comes off changes.
//
// The school can change these figures without a new build: a JSON object in
// settings.grade_fees overrides the table below.
const pool = require('./db');
const { gradeIndex } = require('./grades.js');

// upTo is an index into grades.js's GRADE_ORDER: آمادګي is 0, اول 1 … دولسم 12.
const DEFAULT_BANDS = [
  { upTo: 3,  fee: 600 },    // آمادګي، اول، دوهم، دریم
  { upTo: 7,  fee: 700 },    // څلورم، پنځم، شپږم، اووم
  { upTo: 9,  fee: 950 },    // اتم، نهم
  { upTo: 12, fee: 1100 },   // لسم، یوولسم، دولسم
];

function parseBands(raw) {
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || !arr.length) return null;
  const bands = arr
    .map(b => ({ upTo: parseInt(b.upTo, 10), fee: parseFloat(b.fee) }))
    .filter(b => Number.isFinite(b.upTo) && Number.isFinite(b.fee) && b.fee >= 0)
    .sort((a, b) => a.upTo - b.upTo);
  return bands.length ? bands : null;
}

async function getBands() {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'grade_fees'`);
    if (r.rows.length && r.rows[0].value) {
      const parsed = parseBands(r.rows[0].value);
      if (parsed) return parsed;
    }
  } catch (_) { /* settings unreadable → the built-in table stands */ }
  return DEFAULT_BANDS;
}

// The standard fee for a grade, before any discount. Returns null for a grade
// the ladder does not recognise, so a caller can leave that student alone
// rather than guess a price for them.
function feeForGrade(grade, bands = DEFAULT_BANDS) {
  const idx = gradeIndex(grade);
  if (idx < 0) return null;
  const band = bands.find(b => idx <= b.upTo);
  return band ? band.fee : null;
}

module.exports = { DEFAULT_BANDS, getBands, feeForGrade };
