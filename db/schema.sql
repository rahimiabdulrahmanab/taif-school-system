-- ═══════════════════════════════════════════════════════════════
--  TAIF HIGH SCHOOL — Complete Database Schema
--  Run this file once in pgAdmin or psql to create all tables
-- ═══════════════════════════════════════════════════════════════

-- Drop existing tables in safe order
DROP TABLE IF EXISTS office_expenses     CASCADE;
DROP TABLE IF EXISTS payroll_advances    CASCADE;
DROP TABLE IF EXISTS payroll             CASCADE;
DROP TABLE IF EXISTS marks               CASCADE;
DROP TABLE IF EXISTS subjects            CASCADE;
DROP TABLE IF EXISTS fee_payments        CASCADE;
DROP TABLE IF EXISTS attendance          CASCADE;
DROP TABLE IF EXISTS students            CASCADE;
DROP TABLE IF EXISTS teachers            CASCADE;
DROP TABLE IF EXISTS staff               CASCADE;
DROP TABLE IF EXISTS classes             CASCADE;
DROP TABLE IF EXISTS admin_users         CASCADE;
DROP TABLE IF EXISTS settings            CASCADE;

-- ─── ADMIN USERS ────────────────────────────────────────────
CREATE TABLE admin_users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(150),
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ─── SETTINGS ───────────────────────────────────────────────
CREATE TABLE settings (
  key           VARCHAR(100) PRIMARY KEY,
  value         TEXT,
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- ─── CLASSES ────────────────────────────────────────────────
CREATE TABLE classes (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50)  NOT NULL UNIQUE,  -- e.g. A1, B1, C2
  grade         VARCHAR(30)  NOT NULL,          -- e.g. Grade 7
  section       VARCHAR(10),                    -- e.g. A
  room          VARCHAR(20),
  academic_year VARCHAR(10)  DEFAULT '2026',
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ─── STUDENTS ───────────────────────────────────────────────
CREATE TABLE students (
  id                SERIAL PRIMARY KEY,
  student_code      VARCHAR(30)  UNIQUE NOT NULL,   -- STU-2026-001
  barcode           VARCHAR(60)  UNIQUE NOT NULL,   -- printed on ID card
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  date_of_birth     DATE,
  gender            VARCHAR(10),
  class_id          INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  parent_name       VARCHAR(200),
  parent_phone      VARCHAR(25),                    -- WhatsApp number
  address           TEXT,
  photo             VARCHAR(255),                   -- filename in uploads/students/
  monthly_fee       NUMERIC(10,2) DEFAULT 0,
  discount_type     VARCHAR(10)   DEFAULT 'none',   -- none | fixed | percent
  discount_value    NUMERIC(10,2) DEFAULT 0,
  discount_note     TEXT,
  is_active         BOOLEAN DEFAULT TRUE,
  enrolled_at       DATE DEFAULT CURRENT_DATE,
  created_at        TIMESTAMP DEFAULT NOW()
);

-- ─── TEACHERS ───────────────────────────────────────────────
CREATE TABLE teachers (
  id                SERIAL PRIMARY KEY,
  teacher_code      VARCHAR(30)  UNIQUE NOT NULL,   -- TCH-2026-001
  barcode           VARCHAR(60)  UNIQUE NOT NULL,
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  date_of_birth     DATE,
  gender            VARCHAR(10),
  subject           VARCHAR(100),
  phone             VARCHAR(25),
  address           TEXT,
  photo             VARCHAR(255),
  monthly_salary    NUMERIC(10,2) DEFAULT 0,
  join_date         DATE DEFAULT CURRENT_DATE,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMP DEFAULT NOW()
);

-- ─── STAFF ──────────────────────────────────────────────────
CREATE TABLE staff (
  id                SERIAL PRIMARY KEY,
  staff_code        VARCHAR(30)  UNIQUE NOT NULL,   -- STF-2026-001
  barcode           VARCHAR(60)  UNIQUE NOT NULL,
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  date_of_birth     DATE,
  gender            VARCHAR(10),
  role              VARCHAR(100),                   -- e.g. Cleaner, Guard, Admin
  phone             VARCHAR(25),
  address           TEXT,
  photo             VARCHAR(255),
  monthly_salary    NUMERIC(10,2) DEFAULT 0,
  join_date         DATE DEFAULT CURRENT_DATE,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMP DEFAULT NOW()
);

-- ─── ATTENDANCE ─────────────────────────────────────────────
CREATE TABLE attendance (
  id              SERIAL PRIMARY KEY,
  person_type     VARCHAR(10)  NOT NULL,  -- student | teacher | staff
  person_id       INTEGER      NOT NULL,
  scan_time       TIMESTAMP    DEFAULT NOW(),
  scan_date       DATE         DEFAULT CURRENT_DATE,
  status          VARCHAR(10)  DEFAULT 'present', -- present | absent | late
  notes           TEXT
);

CREATE INDEX idx_attendance_date      ON attendance(scan_date);
CREATE INDEX idx_attendance_person    ON attendance(person_type, person_id);
CREATE INDEX idx_attendance_date_type ON attendance(scan_date, person_type);

-- ─── FEE PAYMENTS ───────────────────────────────────────────
CREATE TABLE fee_payments (
  id              SERIAL PRIMARY KEY,
  student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount_paid     NUMERIC(10,2) NOT NULL,
  original_fee    NUMERIC(10,2) NOT NULL,
  discount_amount NUMERIC(10,2) DEFAULT 0,
  payment_date    DATE    DEFAULT CURRENT_DATE,
  payment_month   VARCHAR(20),                   -- e.g. January 2026
  receipt_number  VARCHAR(30) UNIQUE,
  notes           TEXT,
  whatsapp_sent   BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ─── SUBJECTS ───────────────────────────────────────────────
CREATE TABLE subjects (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  class_id        INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  academic_year   VARCHAR(10) DEFAULT '2026',
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(name, class_id, academic_year)
);

-- ─── MARKS ──────────────────────────────────────────────────
CREATE TABLE marks (
  id              SERIAL PRIMARY KEY,
  student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  academic_year   VARCHAR(10) DEFAULT '2026',
  term            VARCHAR(10) NOT NULL,     -- midterm | final
  score           NUMERIC(5,2),
  max_score       NUMERIC(5,2),             -- 40 for midterm, 60 for final
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id, subject_id, academic_year, term)
);

-- ─── PAYROLL ────────────────────────────────────────────────
CREATE TABLE payroll (
  id                SERIAL PRIMARY KEY,
  person_type       VARCHAR(10) NOT NULL,   -- teacher | staff
  person_id         INTEGER     NOT NULL,
  pay_month         VARCHAR(20) NOT NULL,   -- e.g. January 2026
  base_salary       NUMERIC(10,2) NOT NULL,
  absent_days       INTEGER DEFAULT 0,
  deduction_amount  NUMERIC(10,2) DEFAULT 0,
  advance_taken     NUMERIC(10,2) DEFAULT 0,
  net_salary        NUMERIC(10,2) NOT NULL,
  is_paid           BOOLEAN DEFAULT FALSE,
  paid_date         DATE,
  created_at        TIMESTAMP DEFAULT NOW(),
  UNIQUE(person_type, person_id, pay_month)
);

-- ─── PAYROLL ADVANCES ───────────────────────────────────────
CREATE TABLE payroll_advances (
  id              SERIAL PRIMARY KEY,
  person_type     VARCHAR(10) NOT NULL,
  person_id       INTEGER     NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  advance_date    DATE DEFAULT CURRENT_DATE,
  pay_month       VARCHAR(20) NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ─── OFFICE EXPENSES ────────────────────────────────────────
CREATE TABLE office_expenses (
  id              SERIAL PRIMARY KEY,
  category        VARCHAR(100) NOT NULL,  -- Rent|Electricity|Cleaning|Stationery|Internet|Maintenance|Other
  description     TEXT,
  amount          NUMERIC(10,2) NOT NULL,
  expense_date    DATE DEFAULT CURRENT_DATE,
  expense_month   VARCHAR(20),
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════
-- DEFAULT DATA
-- ═══════════════════════════════════════════════════════════

-- Default admin user (password: admin123 — change after first login)
INSERT INTO admin_users (username, password_hash, full_name)
VALUES (
  'admin',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'School Administrator'
);

-- Default settings
INSERT INTO settings (key, value) VALUES
  ('school_name',        'Taif High School'),
  ('school_phone',       '+93 767 617 184'),
  ('school_email',       'info@rahimitechsolution.com'),
  ('school_address',     'Jalalabad, Afghanistan'),
  ('absence_alert_time', '09:00'),
  ('academic_year',      '2026'),
  ('currency',           'AFN');

-- ═══════════════════════════════════════════════════════════
-- VERIFICATION — run after setup to confirm all tables exist
-- ═══════════════════════════════════════════════════════════
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
-- ORDER BY table_name;