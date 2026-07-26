-- ═══════════════════════════════════════════════════════════
--   AUDIT FIXES — data-integrity constraints
--   Safe to re-run.
-- ═══════════════════════════════════════════════════════════

-- ── attendance: one row per person per day, enforced by the DB so two
--    simultaneous gate scans can't create duplicates. Dedupe first.
DELETE FROM attendance a
 USING attendance b
 WHERE a.person_type = b.person_type
   AND a.person_id   = b.person_id
   AND a.scan_date   = b.scan_date
   AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_person_day_uniq
  ON attendance (person_type, person_id, scan_date);

-- ── marks: key by academic year as well, so next year's marks start a
--    fresh set instead of overwriting this year's transcript.
ALTER TABLE marks
  ADD COLUMN IF NOT EXISTS exam_type VARCHAR(20);

UPDATE marks SET exam_type = term WHERE exam_type IS NULL AND term IS NOT NULL;
UPDATE marks SET academic_year = '2026' WHERE academic_year IS NULL;

-- Dedupe on the new 4-column key (keep newest row)
DELETE FROM marks m
 USING marks m2
 WHERE m.student_id    = m2.student_id
   AND m.subject_id    = m2.subject_id
   AND m.exam_type     = m2.exam_type
   AND m.academic_year = m2.academic_year
   AND m.id < m2.id;

-- Replace the year-less unique index with the year-aware one.
-- (Code and this migration must deploy together: the routes now use
--  ON CONFLICT (student_id, subject_id, exam_type, academic_year).)
DROP INDEX IF EXISTS marks_student_subject_exam_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS marks_student_subject_exam_year_uniq
  ON marks (student_id, subject_id, exam_type, academic_year);
