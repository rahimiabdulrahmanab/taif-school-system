-- ═══════════════════════════════════════════════════════════════
--  CLASS INTEGRITY — make a bad grade_level impossible to store
--
--  Promotion decides where a class goes by matching grade_level and
--  section. Both are free text, so a typo or an invisible character
--  (this database already has three U+200C in one class NAME) makes a
--  class silently unpromotable. The application now normalises before
--  comparing and before writing; these constraints stop bad values at
--  the database, which is the layer that cannot be bypassed.
--
--  SAFE ON A LIVE DATABASE:
--    • adds constraints only — changes no row
--    • the CHECK is added NOT VALID, so existing rows are never
--      rejected; it applies to inserts and updates from now on
--    • the unique index is skipped, with a notice, if the data
--      already contains duplicates
-- ═══════════════════════════════════════════════════════════════

-- ── 1. grade_level must be NULL or one of the 13 known rungs ───
--    (آمادګي is pre-school and is the FIRST rung, before اول.)
ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_grade_level_known;

ALTER TABLE classes
  ADD CONSTRAINT classes_grade_level_known
  CHECK (
    grade_level IS NULL OR grade_level IN (
      'آمادګي',
      'اول', 'دوهم', 'دریم', 'څلورم', 'پنځم', 'شپږم',
      'اووم', 'اتم', 'نهم', 'لسم', 'یوولسم', 'دولسم'
    )
  ) NOT VALID;

-- Turn the above into a full guarantee once the existing rows are known
-- to be clean. Run this separately; it fails loudly if any row violates,
-- which is the point — you want to see those rows.
--     ALTER TABLE classes VALIDATE CONSTRAINT classes_grade_level_known;

-- ── 2. one class per (grade, section) ──────────────────────────
--    Two classes sharing a grade AND a section make the promotion
--    destination ambiguous — findDest would pick whichever came back
--    first. Prevent it, unless the data already has duplicates.
DO $integrity$
DECLARE
  dupes INT;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT grade_level, COALESCE(section, '') AS sec
      FROM classes
     WHERE grade_level IS NOT NULL
     GROUP BY grade_level, COALESCE(section, '')
    HAVING COUNT(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE NOTICE 'Skipped the unique index: % grade+section pair(s) are already duplicated. Merge or re-label those classes, then re-run this file.', dupes;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS classes_grade_section_uniq
      ON classes (grade_level, COALESCE(section, ''))
      WHERE grade_level IS NOT NULL;
  END IF;
END
$integrity$;
