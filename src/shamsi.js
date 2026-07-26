// ────────────────────────────────────────────────────────────────
//  Afghan Solar Hijri (Shamsi / Jalali) calendar — backend helpers
//  Pay months are stored as Shamsi "YYYY-MM"; attendance dates are
//  Gregorian. These helpers bridge the two.
// ────────────────────────────────────────────────────────────────

function toShamsi(gy, gm, gd) {
  var g_y = gy - 1600, g_m = gm - 1, g_d = gd - 1, i;
  var g_dm = [31, (((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var g_day_no = 365 * g_y + Math.floor((g_y + 3) / 4) - Math.floor((g_y + 99) / 100) + Math.floor((g_y + 399) / 400);
  for (i = 0; i < g_m; ++i) g_day_no += g_dm[i];
  g_day_no += g_d;
  var j_day_no = g_day_no - 79;
  var j_np = Math.floor(j_day_no / 12053); j_day_no = j_day_no % 12053;
  var jy = 979 + 33 * j_np + 4 * Math.floor(j_day_no / 1461); j_day_no %= 1461;
  if (j_day_no >= 366) { jy += Math.floor((j_day_no - 1) / 365); j_day_no = (j_day_no - 1) % 365; }
  var j_dm = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
  for (i = 0; i < 11 && j_day_no >= j_dm[i]; ++i) j_day_no -= j_dm[i];
  return { year: jy, month: i + 1, day: j_day_no + 1 };
}

function fromShamsi(jy, jm, jd) {
  var jy2 = jy - 979, j_dm = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
  var j_np = Math.floor(jy2 / 33), left = jy2 - 33 * j_np;
  var j4 = Math.floor(left / 4), yr = left - 4 * j4;
  var j_day_no4 = jd - 1;
  for (var i = 0; i < jm - 1; i++) j_day_no4 += j_dm[i];
  var j_day_no3 = yr === 0 ? j_day_no4 : yr * 365 + j_day_no4 + 1;
  var j_day_no2 = j4 * 1461 + j_day_no3;
  var j_day_no1 = j_np * 12053 + j_day_no2;
  var g_day_no = j_day_no1 + 79;
  var gy = 1600 + 400 * Math.floor(g_day_no / 146097); g_day_no %= 146097;
  var leap = true;
  if (g_day_no >= 36525) { g_day_no--; gy += 100 * Math.floor(g_day_no / 36524); g_day_no %= 36524; if (g_day_no >= 365) g_day_no++; else leap = false; }
  gy += 4 * Math.floor(g_day_no / 1461); g_day_no %= 1461;
  if (g_day_no >= 366) { leap = false; g_day_no--; gy += Math.floor(g_day_no / 365); g_day_no %= 365; }
  var g_dm = [31, (leap ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (var j = 0; g_day_no >= g_dm[j]; j++) g_day_no -= g_dm[j];
  return { year: gy, month: j + 1, day: g_day_no + 1 };
}

// Build a Date (UTC-safe, time set to 00:00) from a {year,month,day} object
function _toDate(g) {
  return new Date(g.year, g.month - 1, g.day);
}

function _isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Given a Shamsi year + month, return the Gregorian date range that covers it.
// Returns { start: Date, end: Date, startISO, endISO, daysInMonth }.
// Robust against month-length quirks: end = (first day of next month) − 1 day.
function shamsiMonthRange(jy, jm) {
  const start = _toDate(fromShamsi(jy, jm, 1));
  const nextG = jm < 12 ? fromShamsi(jy, jm + 1, 1) : fromShamsi(jy + 1, 1, 1);
  const end = _toDate(nextG);
  end.setDate(end.getDate() - 1);
  const daysInMonth = Math.round((end - start) / 86400000) + 1;
  return { start, end, startISO: _isoDate(start), endISO: _isoDate(end), daysInMonth };
}

// Count "working days" between two Dates (inclusive) — every day except Friday.
// JS getDay(): 0=Sun … 5=Fri … 6=Sat.
function workingDaysBetween(startDate, endDate) {
  if (endDate < startDate) return 0;
  let count = 0;
  const d = new Date(startDate);
  while (d <= endDate) {
    if (d.getDay() !== 5) count++; // skip Fridays
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ── Kabul-local "today" ─────────────────────────────────────────
// The server may run in UTC (Render) while the school lives at UTC+4:30.
// Every "what day is it" decision must use Kabul time, or scans and month
// boundaries shift to the previous day between 00:00 and 04:30 local.
const KABUL_OFFSET_MS = 4.5 * 3600 * 1000;

// {gy, gm, gd} of the current Kabul calendar day
function kabulToday() {
  const d = new Date(Date.now() + KABUL_OFFSET_MS);
  return { gy: d.getUTCFullYear(), gm: d.getUTCMonth() + 1, gd: d.getUTCDate() };
}

// "YYYY-MM-DD" of the current Kabul day (for scan_date etc.)
function kabulTodayISO() {
  const k = kabulToday();
  const pad = n => String(n).padStart(2, '0');
  return `${k.gy}-${pad(k.gm)}-${pad(k.gd)}`;
}

// Shamsi {year, month, day} of the current Kabul day
function todayShamsi() {
  const k = kabulToday();
  return toShamsi(k.gy, k.gm, k.gd);
}

// Date object at Kabul midnight of today (for date-range comparisons)
function kabulTodayDate() {
  const k = kabulToday();
  return new Date(k.gy, k.gm - 1, k.gd);
}

module.exports = { toShamsi, fromShamsi, shamsiMonthRange, workingDaysBetween, _isoDate,
                   kabulToday, kabulTodayISO, todayShamsi, kabulTodayDate };
