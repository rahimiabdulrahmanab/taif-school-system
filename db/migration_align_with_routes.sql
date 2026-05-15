-- ═══════════════════════════════════════════════════════════
--   ALIGN SCHEMA WITH APPLICATION CODE
--   Run this ONCE on your Neon database (or any DB created from
--   the original schema.sql). It adds columns the routes need
--   but the schema didn't include.
--
--   Safe to re-run: every statement uses IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════

-- ── fee_payments: routes use `amount`, `payment_year`, `payment_method`
ALTER TABLE fee_payments
  ADD COLUMN IF NOT EXISTS amount         NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS payment_year   VARCHAR(10),
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'cash';

-- Backfill `amount` from legacy `amount_paid` if needed
UPDATE fee_payments
   SET amount = amount_paid
 WHERE amount IS NULL
   AND amount_paid IS NOT NULL;

-- ── office_expenses: routes/UI display `paid_to`
ALTER TABLE office_expenses
  ADD COLUMN IF NOT EXISTS paid_to VARCHAR(200),
  ADD COLUMN IF NOT EXISTS notes   TEXT;

-- ── Helpful indexes for the new query patterns
CREATE INDEX IF NOT EXISTS idx_fee_payments_month_year
  ON fee_payments (payment_year, payment_month);

CREATE INDEX IF NOT EXISTS idx_fee_payments_student
  ON fee_payments (student_id, payment_date DESC);

-- ── payroll: capture how the salary was paid (cash/bank/etc.) and any notes
ALTER TABLE payroll
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS payment_notes  TEXT;

-- ── payroll: tax withheld per Afghanistan wage income tax brackets
ALTER TABLE payroll
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) DEFAULT 0;

-- ── staff_monthly_attendance: admin-confirmed present-days per teacher/staff
--    per Shamsi pay month. The gate scans give an auto count; the admin can
--    adjust and save here, and payroll uses the saved value when present.
CREATE TABLE IF NOT EXISTS staff_monthly_attendance (
  id           SERIAL PRIMARY KEY,
  person_type  VARCHAR(10) NOT NULL,            -- teacher | staff
  person_id    INTEGER     NOT NULL,
  pay_month    VARCHAR(20) NOT NULL,            -- Shamsi "YYYY-MM"
  present_days INTEGER     NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP   DEFAULT NOW(),
  UNIQUE (person_type, person_id, pay_month)
);

-- ── Legacy debt from before the system existed.
--    students.previous_debt = lump-sum carry-forward balance the student owed
--    when they were registered in the system (e.g. unpaid fees from a prior
--    school year that aren't broken into Shamsi months).
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS previous_debt NUMERIC(10,2) DEFAULT 0;

-- Mark fee_payments that go AGAINST the legacy debt (not a specific month).
-- The fee endpoint sums these to compute how much of the legacy debt is paid.
ALTER TABLE fee_payments
  ADD COLUMN IF NOT EXISTS is_previous_debt BOOLEAN DEFAULT FALSE;
