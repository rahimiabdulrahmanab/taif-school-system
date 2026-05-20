-- ═══════════════════════════════════════════════════════════
--   MARKS: align unique constraint with the route's ON CONFLICT
--   The route saves with ON CONFLICT (student_id, subject_id,
--   exam_type), but the table was created with UNIQUE on
--   (student_id, subject_id, academic_year, term). The mismatch
--   silently broke "Save Marks" and made transcripts empty.
--
--   Safe to re-run.
-- ═══════════════════════════════════════════════════════════

-- 1. Ensure exam_type column exists (teacher_portal migration adds it,
--    but DBs that skipped that migration are missing it)
ALTER TABLE marks
  ADD COLUMN IF NOT EXISTS exam_type VARCHAR(20);

-- 2. Backfill exam_type from legacy `term` column when it's missing
UPDATE marks
   SET exam_type = term
 WHERE exam_type IS NULL
   AND term IS NOT NULL;

-- 3. Drop duplicate rows that would block the new unique index.
--    Keep the row with the highest id (most recent insert) per
--    (student_id, subject_id, exam_type).
DELETE FROM marks m
 USING marks m2
 WHERE m.student_id = m2.student_id
   AND m.subject_id = m2.subject_id
   AND m.exam_type  = m2.exam_type
   AND m.id < m2.id;

-- 4. Create the unique index the ON CONFLICT clause expects
CREATE UNIQUE INDEX IF NOT EXISTS marks_student_subject_exam_uniq
  ON marks (student_id, subject_id, exam_type);
