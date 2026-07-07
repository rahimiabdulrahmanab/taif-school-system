-- ═══════════════════════════════════════════════════════════
--   STUDENTS: second parent WhatsApp number
--   Some fathers live abroad, so the school needs a second phone
--   and both fields must accept any international format.
--   Safe to re-run.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS parent_phone2 VARCHAR(30);
