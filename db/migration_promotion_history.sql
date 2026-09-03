-- ═══════════════════════════════════════════════════════════════
--  PROMOTION AUDIT TRAIL + UNDO
--
--  Why this exists: POST /api/students/promote used to move every
--  student up a grade while recording NOTHING about where they came
--  from. When a promotion was run by mistake (or run twice) there was
--  no way to put the school back. This table is that missing record.
--
--  SAFE ON A LIVE DATABASE:
--    • additive only — creates ONE new table plus its indexes
--    • does not touch, move or delete a single existing row
--    • idempotent — re-running it changes nothing
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS student_class_history (
  id                SERIAL PRIMARY KEY,
  -- One id shared by every row written by a single promote run, so a
  -- whole run can be undone as a unit.
  batch_id          VARCHAR(40)  NOT NULL,
  student_id        INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  action            VARCHAR(20)  NOT NULL,   -- promote | graduate | undo

  -- The state BEFORE the change. This is what an undo restores.
  from_class_id     INTEGER,
  to_class_id       INTEGER,
  was_active        BOOLEAN,
  was_graduated     BOOLEAN,
  was_graduated_at  DATE,

  changed_by        INTEGER,                 -- admin_users.id, when known
  changed_at        TIMESTAMP DEFAULT NOW(),
  undone_at         TIMESTAMP                -- set when this row is reversed
);

CREATE INDEX IF NOT EXISTS idx_class_history_batch
  ON student_class_history (batch_id);

CREATE INDEX IF NOT EXISTS idx_class_history_student
  ON student_class_history (student_id);

CREATE INDEX IF NOT EXISTS idx_class_history_open
  ON student_class_history (changed_at DESC)
  WHERE undone_at IS NULL;
