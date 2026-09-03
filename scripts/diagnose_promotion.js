#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
 *  PROMOTION DIAGNOSTIC — 100% READ-ONLY
 *
 *  Run this BEFORE attempting any repair. It puts the database session
 *  in READ ONLY mode and only ever runs SELECTs, so it cannot change,
 *  delete or move a single record.
 *
 *    node scripts/diagnose_promotion.js
 *
 *  It answers three questions:
 *    1. Are the classes themselves labelled correctly (grade_level)?
 *    2. Did a promotion run more than once?
 *    3. Where was each student ACTUALLY taught this year? Reconstructed
 *       from marks -> subjects.class_id, which promotion never touches.
 * ═══════════════════════════════════════════════════════════════════ */
require('dotenv').config();
const { Pool } = require('pg');

const GRADE_ORDER = ['اول','دوهم','دریم','څلورم','پنځم','شپږم',
                     'اووم','اتم','نهم','لسم','یوولسم','دولسم'];
const GRADE_NUM = {};
GRADE_ORDER.forEach((g, i) => { GRADE_NUM[g] = i + 1; });

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
               user: process.env.DB_USER, password: process.env.DB_PASSWORD });

const bar  = (c) => console.log((c || '─').repeat(76));
const head = (t) => { console.log(''); bar('═'); console.log('  ' + t); bar('═'); };
const pad  = (v, n) => String(v == null ? '-' : v).padEnd(n);

// First 1-2 digit number in a class name: "10-الف" -> 10, "Class 12" -> 12
function numInName(name) {
  const m = String(name || '').match(/\d{1,2}/);
  return m ? parseInt(m[0], 10) : null;
}

async function main() {
  // Belt and braces: this session cannot write even if the code tried to.
  await pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  console.log('\n  Session is READ ONLY — this script cannot modify anything.');

  const findings = [];

  // ── 1. CLASS LABELS ─────────────────────────────────────────────
  head('1. CLASSES — how each class is labelled');
  const cls = await pool.query(
    `SELECT c.id, c.name, c.grade_level, c.section,
            COUNT(s.id) FILTER (WHERE s.is_active)::int AS active_students
       FROM classes c
       LEFT JOIN students s ON s.class_id = c.id
      GROUP BY c.id, c.name, c.grade_level, c.section
      ORDER BY c.name`);

  console.log('  id  | name            | sect | grade_level  | g# | studs | flag');
  bar();
  const seen = {};
  for (const c of cls.rows) {
    const gnum = GRADE_NUM[c.grade_level] || null;
    const nnum = numInName(c.name);
    const flags = [];
    if (!c.grade_level)                flags.push('NO grade_level — promote SKIPS this class');
    else if (!gnum)                    flags.push('grade_level not one of the 12 known grades');
    if (gnum && nnum && gnum !== nnum) flags.push(`NAME SAYS ${nnum} BUT grade_level SAYS ${gnum}`);
    const key = `${c.grade_level}|${(c.section || '').trim()}`;
    if (c.grade_level) {
      if (seen[key]) flags.push(`DUPLICATE grade+section of class id ${seen[key]}`);
      else seen[key] = c.id;
    }
    if (flags.length) findings.push(`Class "${c.name}" (id ${c.id}): ${flags.join('; ')}`);
    console.log(`  ${pad(c.id, 3)} | ${pad(c.name, 15)} | ${pad(c.section, 4)} | ` +
                `${pad(c.grade_level, 12)} | ${pad(gnum, 2)} | ${pad(c.active_students, 5)} | ` +
                (flags.join('; ') || 'ok'));
  }

  // ── 2. GRADUATION BATCHES ───────────────────────────────────────
  head('2. GRADUATION BATCHES — every promote run graduates the top grade');
  let grads = { rows: [] };
  try {
    grads = await pool.query(
      `SELECT graduated_at::text AS day, COUNT(*)::int AS n
         FROM students
        WHERE graduated = TRUE AND graduated_at IS NOT NULL
        GROUP BY graduated_at ORDER BY graduated_at DESC LIMIT 15`);
  } catch (e) {
    console.log('  (graduated columns not present: ' + e.message + ')');
  }
  if (!grads.rows.length) console.log('  No graduation batches recorded.');
  for (const g of grads.rows) console.log(`  ${g.day} — ${g.n} student(s) archived`);

  if (grads.rows.length > 1) {
    const a = grads.rows[0], b = grads.rows[1];
    const days = Math.abs((new Date(a.day) - new Date(b.day)) / 86400000);
    if (days <= 3) {
      findings.push(
        `TWO graduation batches only ${days} day(s) apart (${b.day} and ${a.day}). ` +
        `That is what running promote twice looks like: the ${a.n} student(s) archived on ` +
        `${a.day} were most likely grade 11 and should NOT be graduates.`);
    }
  }

  // ── 3. WHERE STUDENTS WERE ACTUALLY TAUGHT ──────────────────────
  head('3. RECONSTRUCTION — the class where each student actually has marks');
  console.log('  Promotion never touches marks or subjects, so subjects.class_id still');
  console.log('  points at the class the student sat in. This is the recovery evidence.\n');
  let recon = { rows: [] };
  try {
    recon = await pool.query(
      `SELECT was_c.name AS was_class, was_c.grade_level AS was_grade,
              now_c.name AS now_class, now_c.grade_level AS now_grade,
              bool_or(s.graduated) AS any_graduated,
              COUNT(DISTINCT s.id)::int AS students
         FROM students s
         JOIN marks    m    ON m.student_id  = s.id
         JOIN subjects sub  ON sub.id        = m.subject_id
         JOIN classes  was_c ON was_c.id     = sub.class_id
         LEFT JOIN classes now_c ON now_c.id = s.class_id
        WHERE s.class_id IS DISTINCT FROM sub.class_id
        GROUP BY was_c.name, was_c.grade_level, now_c.name, now_c.grade_level
        ORDER BY students DESC`);
  } catch (e) {
    console.log('  (could not reconstruct: ' + e.message + ')');
  }

  if (!recon.rows.length) {
    console.log('  No mismatches: every student sits in the class their marks belong to.');
    console.log('  (If the promotion happened before any marks were entered this year,');
    console.log('   this check cannot see it — rely on section 2 and Neon PITR instead.)');
  } else {
    console.log('  has marks in       ->  is now in           | studs | grades moved');
    bar();
    for (const r of recon.rows) {
      const from = GRADE_NUM[r.was_grade], to = GRADE_NUM[r.now_grade];
      const jump = (from && to) ? (to - from) : null;
      const note = r.any_graduated && !r.now_class ? 'ARCHIVED AS GRADUATE'
                 : jump === null                   ? 'unknown'
                 : jump === 1                      ? '+1 (normal)'
                 : `${jump > 0 ? '+' : ''}${jump}  <-- ${jump === 2 ? 'PROMOTED TWICE' : 'UNEXPECTED'}`;
      console.log(`  ${pad(r.was_class, 18)} ->  ${pad(r.now_class || 'GRADUATED / none', 19)} | ` +
                  `${pad(r.students, 5)} | ${note}`);
      if (jump !== 1) {
        findings.push(`${r.students} student(s) with marks in "${r.was_class}" now sit in ` +
                      `"${r.now_class || 'GRADUATED'}" (${note}).`);
      }
    }
  }

  // ── 4. AUDIT TRAIL ──────────────────────────────────────────────
  head('4. AUDIT TRAIL');
  const hist = await pool.query(`SELECT to_regclass('public.student_class_history') AS t`);
  if (!hist.rows[0].t) {
    console.log('  student_class_history does NOT exist, so this database holds no record');
    console.log('  of previous class assignments — that is why the promotion cannot be');
    console.log('  undone from inside the app. Run db/migration_promotion_history.sql to');
    console.log('  make every future promotion undoable.');
  } else {
    const b = await pool.query(
      `SELECT batch_id, action, MIN(changed_at)::text AS at, COUNT(*)::int AS n
         FROM student_class_history
        GROUP BY batch_id, action
        ORDER BY MIN(changed_at) DESC LIMIT 10`);
    if (!b.rows.length) {
      console.log('  Table exists but is empty (no promotion has run since it was added).');
    }
    for (const r of b.rows) {
      console.log(`  ${r.at} | batch ${r.batch_id} | ${pad(r.action, 9)} | ${r.n} student(s)`);
    }
  }

  // ── VERDICT ─────────────────────────────────────────────────────
  head('VERDICT');
  if (!findings.length) {
    console.log('  Nothing anomalous found by these checks.');
  } else {
    findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log('\n  Read RECOVERY.md before changing anything.');
  }
  console.log('');
  await pool.end();
}

main().catch((e) => {
  console.error('\n  Diagnostic failed:', e.message, '\n');
  pool.end();
  process.exit(1);
});
