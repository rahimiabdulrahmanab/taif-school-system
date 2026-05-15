// ═══════════════════════════════════════════════════════
//  SCHOOL CONFIGURATION FILE
//  Change this file when deploying for a different school
//  Everything in the system reads from here
// ═══════════════════════════════════════════════════════

const SCHOOL_CONFIG = {

  // ── School Identity ──────────────────────────────────
  name:         'Taif High School',
  name_short:   'Taif',
  abbreviation: 'TS',                          // shown in logo badge
  tagline:      'Management System',

  // ── Contact Info ─────────────────────────────────────
  phone:        '+93 767 617 184',
  email:        'info@rahimitechsolution.com',
  address:      'Jalalabad, Afghanistan',
  website:      '',

  // ── Academic Settings ────────────────────────────────
  current_year: '2026',                         // academic year
  currency:     'AFN',                          // currency label
  currency_symbol: '؋',

  // ── ID Code Prefixes ─────────────────────────────────
  student_prefix: 'TF',                        // STU-2026-001
  teacher_prefix: 'TCH',                        // TCH-2026-001
  staff_prefix:   'STF',                        // STF-2026-001

  // ── Grading Rules ────────────────────────────────────
  midterm_max:  40,                             // midterm out of 40
  final_max:    60,                             // final out of 60
  pass_mark:    40,                             // combined pass mark

  // ── Gate & Attendance ────────────────────────────────
  absence_alert_time: '09:00',                  // time to flag absences

  // ── Brand Colors (CSS variables) ─────────────────────
  brand_color:  '#1A4A5C',
  accent_color: '#5DCAA5',

};

module.exports = SCHOOL_CONFIG;