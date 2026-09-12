-- ═══════════════════════════════════════════════════════════════
--  Fee follows the grade, and old months keep their old price
--  ------------------------------------------------------------
--  Taif charges by grade: آمادګي–دریم 600, څلورم–اووم 700,
--  اتم–نهم 950, لسم–دولسم 1100. Until now a promotion moved the
--  student but left the fee behind, so a child in څلورم was still
--  being billed the دریم price.
--
--  Raising students.monthly_fee on its own would silently re-price
--  every month the student has ALREADY been billed for — last
--  year's دریم months would start showing 700. So each change is
--  written here with the month it starts from, and the ledger asks
--  this table what the fee was in any given month.
--
--  Safe to run more than once. Adds only; changes no existing row.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS student_fee_history (
  id           SERIAL PRIMARY KEY,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  from_year    SMALLINT     NOT NULL,   -- Shamsi year this fee starts (0 = since always)
  from_month   SMALLINT     NOT NULL,   -- 1..12
  monthly_fee  NUMERIC(10,2) NOT NULL,  -- before the student's own discount
  reason       TEXT,
  batch_id     VARCHAR(64),             -- the promotion run, so Undo can remove it
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_student_fee_history_student
  ON student_fee_history (student_id, from_year, from_month);

CREATE INDEX IF NOT EXISTS idx_student_fee_history_batch
  ON student_fee_history (batch_id);

-- What the student was paying just before a promotion, so Undo can put the
-- fee back exactly as it was along with the class.
ALTER TABLE student_class_history
  ADD COLUMN IF NOT EXISTS was_monthly_fee NUMERIC(10,2);

-- The fee table itself, so the school can change the figures next year
-- without a new build. upTo is a rung on the grade ladder: آمادګي is 0,
-- اول is 1 … دولسم is 12.
INSERT INTO settings (key, value)
VALUES ('grade_fees',
        '[{"upTo":3,"fee":600},{"upTo":7,"fee":700},{"upTo":9,"fee":950},{"upTo":12,"fee":1100}]')
ON CONFLICT (key) DO NOTHING;
