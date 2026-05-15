// ────────────────────────────────────────────────────────────────
//  Afghan Solar Hijri (Shamsi / Jalali) calendar — Dari month names
//  Shared utility loaded across admin, teacher, and gate pages.
// ────────────────────────────────────────────────────────────────

(function (global) {
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

  var SHAMSI_MONTHS_DARI = ['', 'حمل', 'ثور', 'جوزا', 'سرطان', 'اسد', 'سنبله', 'میزان', 'عقرب', 'قوس', 'جدی', 'دلو', 'حوت'];
  var _DAYS_DARI = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
  var _PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

  function toPersianDigits(input) {
    return String(input).replace(/[0-9]/g, function (d) { return _PERSIAN_DIGITS[d]; });
  }

  function _asDate(date) {
    return date instanceof Date ? date : new Date(date);
  }

  // "23 ثور 1404"
  function shamsiDari(date) {
    var d = _asDate(date);
    if (isNaN(d)) return '';
    var s = toShamsi(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return s.day + ' ' + SHAMSI_MONTHS_DARI[s.month] + ' ' + s.year;
  }

  // "۲۳ ثور ۱۴۰۴"
  function shamsiDariPD(date) {
    var d = _asDate(date);
    if (isNaN(d)) return '';
    var s = toShamsi(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return toPersianDigits(s.day) + ' ' + SHAMSI_MONTHS_DARI[s.month] + ' ' + toPersianDigits(s.year);
  }

  // "شنبه، ۲۳ ثور ۱۴۰۴"
  function shamsiDariFull(date) {
    var d = _asDate(date);
    if (isNaN(d)) return '';
    var s = toShamsi(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return _DAYS_DARI[d.getDay()] + '، ' + toPersianDigits(s.day) + ' ' + SHAMSI_MONTHS_DARI[s.month] + ' ' + toPersianDigits(s.year);
  }

  // "۲۳ ثور"
  function shamsiShort(date) {
    var d = _asDate(date);
    if (isNaN(d)) return '';
    var s = toShamsi(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return toPersianDigits(s.day) + ' ' + SHAMSI_MONTHS_DARI[s.month];
  }

  // "۰۲:۳۵ ب.ظ"
  function shamsiTime(date) {
    var d = _asDate(date);
    if (isNaN(d)) return '';
    var h = d.getHours();
    var m = String(d.getMinutes()).padStart(2, '0');
    var ampm = h >= 12 ? 'ب.ظ' : 'ق.ظ';
    h = h % 12 || 12;
    return toPersianDigits(String(h).padStart(2, '0')) + ':' + toPersianDigits(m) + ' ' + ampm;
  }

  // Current Shamsi year (e.g. ۱۴۰۴)
  function shamsiYear() {
    var n = new Date();
    return toShamsi(n.getFullYear(), n.getMonth() + 1, n.getDate()).year;
  }

  global.Shamsi = {
    toShamsi: toShamsi,
    fromShamsi: fromShamsi,
    toPersianDigits: toPersianDigits,
    shamsiDari: shamsiDari,
    shamsiDariPD: shamsiDariPD,
    shamsiDariFull: shamsiDariFull,
    shamsiShort: shamsiShort,
    shamsiTime: shamsiTime,
    shamsiYear: shamsiYear,
    MONTHS_DARI: SHAMSI_MONTHS_DARI,
    DAYS_DARI: _DAYS_DARI,
  };
})(window);
