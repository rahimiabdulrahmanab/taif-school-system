-- ═══════════════════════════════════════════════════════════════
--  TEACHER PORTAL MIGRATION
--  Run this ONCE on your existing database (do NOT re-run schema.sql)
--  Open pgAdmin → Query Tool → paste & run
-- ═══════════════════════════════════════════════════════════════

-- 1. Add role + teacher link to admin_users
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS role       VARCHAR(20)  DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL;

-- 2. Ensure existing rows stay as admin
UPDATE admin_users SET role = 'admin' WHERE role IS NULL;

-- 3. Add missing columns to subjects (if not already present from earlier)
ALTER TABLE subjects
  ADD COLUMN IF NOT EXISTS teacher_id  INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS max_midterm NUMERIC(5,2) DEFAULT 40,
  ADD COLUMN IF NOT EXISTS max_final   NUMERIC(5,2) DEFAULT 60;

-- 4. Add submission workflow columns to marks
ALTER TABLE marks
  ADD COLUMN IF NOT EXISTS exam_type      VARCHAR(20),  -- midterm | final  (may already exist)
  ADD COLUMN IF NOT EXISTS status         VARCHAR(20)  DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS submitted_by   INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMP,
  ADD COLUMN IF NOT EXISTS approved_by    INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rejection_note TEXT;

-- 5. Existing marks entered by admin are already approved
UPDATE marks SET status = 'approved' WHERE status IS NULL;

-- 6. Fix unique constraint on marks — may need exam_type if column was just added
-- (Only run if the UNIQUE constraint does not already include exam_type)
-- ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_student_id_subject_id_academic_year_term_key;
-- ALTER TABLE marks ADD CONSTRAINT marks_student_subject_exam_unique
--   UNIQUE (student_id, subject_id, exam_type);

-- Verification
SELECT 'admin_users columns' AS check, column_name
  FROM information_schema.columns
  WHERE table_name = 'admin_users' AND column_name IN ('role','teacher_id')
UNION ALL
SELECT 'marks columns', column_name
  FROM information_schema.columns
  WHERE table_name = 'marks' AND column_name IN ('status','submitted_by','exam_type');
