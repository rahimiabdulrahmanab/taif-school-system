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

-- The legacy `amount_paid` and `original_fee` columns were NOT NULL in the
-- original schema. The app writes to `amount` only, so drop NOT NULL on the
-- legacy columns to prevent insert failures. Safe to re-run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'fee_payments' AND column_name = 'amount_paid') THEN
    EXECUTE 'ALTER TABLE fee_payments ALTER COLUMN amount_paid DROP NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'fee_payments' AND column_name = 'original_fee') THEN
    EXECUTE 'ALTER TABLE fee_payments ALTER COLUMN original_fee DROP NOT NULL';
  END IF;
END $$;

-- ── office_expenses: routes/UI display `paid_to`
ALTER TABLE office_expenses
  ADD COLUMN IF NOT EXISTS paid_to VARCHAR(200),
  ADD COLUMN IF NOT EXISTS notes   TEXT;

-- ── classes: the route uses `grade_level` and `description`, but the original
--    schema had `grade` (NOT NULL) and `room`. Add the columns the route needs
--    and drop NOT NULL on the legacy `grade` column so inserts don't fail.
ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS grade_level VARCHAR(30),
  ADD COLUMN IF NOT EXISTS description TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'classes' AND column_name = 'grade') THEN
    EXECUTE 'ALTER TABLE classes ALTER COLUMN grade DROP NOT NULL';
  END IF;
END $$;

-- ── class_teachers: the classes route reads/writes this join table, but the
--    original schema never created it. Without it, loading classes fails.
CREATE TABLE IF NOT EXISTS class_teachers (
  id          SERIAL PRIMARY KEY,
  class_id    INTEGER NOT NULL REFERENCES classes(id)  ON DELETE CASCADE,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject     VARCHAR(100),
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (class_id, teacher_id)
);
CREATE INDEX IF NOT EXISTS idx_class_teachers_class
  ON class_teachers (class_id);

-- ── subjects: the grades route does INSERT ... ON CONFLICT (class_id, name),
--    which needs a unique constraint on exactly those columns. The original
--    schema only had UNIQUE(name, class_id, academic_year). Add a matching
--    unique index so adding/updating a subject works.
CREATE UNIQUE INDEX IF NOT EXISTS subjects_class_name_uniq
  ON subjects (class_id, name);

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

-- Marker row for an unpaid month the admin chose to "carry forward" into the
-- student's running Total Due. The month is closed (no longer shows as
-- outstanding) and students.previous_debt is incremented by monthly_fee.
ALTER TABLE fee_payments
  ADD COLUMN IF NOT EXISTS carried_forward BOOLEAN DEFAULT FALSE;

-- ── Per-student unpaid-month history.
--    At registration the admin lists specific (year, month, amount) entries
--    for months the student didn't pay BEFORE the system was installed.
--    These appear in the student's outstanding-months list alongside the
--    months auto-generated from the install date forward.
CREATE TABLE IF NOT EXISTS student_unpaid_history (
  id            SERIAL PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  payment_year  INTEGER NOT NULL,
  payment_month INTEGER NOT NULL,
  owed_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE (student_id, payment_year, payment_month)
);
CREATE INDEX IF NOT EXISTS idx_unpaid_history_student
  ON student_unpaid_history (student_id);

-- ── Default install cutoff. Months from this Shamsi year/month forward are
--    auto-generated as expected and tracked paid/partial/unpaid. Months before
--    the cutoff only appear if explicitly listed in student_unpaid_history.
INSERT INTO settings (key, value)
  VALUES ('install_year', '1405')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value)
  VALUES ('install_month', '3')
  ON CONFLICT (key) DO NOTHING;

-- ── Per-month fee-due override (account-statement model).
--    Every Shamsi month from enrollment → today shows in a student's
--    statement with due = effective monthly fee BY DEFAULT. A row here
--    overrides the due for one specific month (e.g. the fee was different
--    in Jawza 1398, or a one-off discount). Sparse — only exceptions.
CREATE TABLE IF NOT EXISTS student_month_due (
  id            SERIAL PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  payment_year  INTEGER NOT NULL,
  payment_month INTEGER NOT NULL,
  amount_due    NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  updated_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE (student_id, payment_year, payment_month)
);
CREATE INDEX IF NOT EXISTS idx_month_due_student
  ON student_month_due (student_id);

-- ── Graduation: mark a class's students as graduated (archived).
--    They keep all records/history but drop out of active lists.
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS graduated    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS graduated_at DATE;

-- ── Payroll overtime: per teacher/staff per Shamsi pay month. The
--    overtime amount is added on top of net salary for that month.
CREATE TABLE IF NOT EXISTS payroll_overtime (
  id           SERIAL PRIMARY KEY,
  person_type  VARCHAR(10)  NOT NULL,          -- teacher | staff
  person_id    INTEGER      NOT NULL,
  pay_month    VARCHAR(20)  NOT NULL,          -- Shamsi "YYYY-MM"
  hours        NUMERIC(6,2) NOT NULL DEFAULT 0,
  amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes        TEXT,
  updated_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (person_type, person_id, pay_month)
);
CREATE INDEX IF NOT EXISTS idx_overtime_paymonth
  ON payroll_overtime (pay_month);
