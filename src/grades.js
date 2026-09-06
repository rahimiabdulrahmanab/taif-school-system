// ── Afghan school grade ladder ─────────────────────────────────
// The single source of truth for "what order do classes come in" and
// "what is the next grade up". Shared by the Classes screen and the
// promotion logic so the two can never disagree — same reason
// src/tax.js and src/holidays.js exist.
//
// آمادګي is PRE-SCHOOL: small children getting ready to start grade 1.
// It is the FIRST rung of the ladder, not a separate track — its
// children are promoted into اول like any other grade. Because nothing
// feeds آمادګي from below, promoting it leaves those classes empty,
// which is exactly what the school wants: room for next year's intake.

const GRADE_ORDER = ['آمادګي',
                     'اول', 'دوهم', 'دریم', 'څلورم', 'پنځم', 'شپږم',
                     'اووم', 'اتم', 'نهم', 'لسم', 'یوولسم', 'دولسم'];

// The first rung. Kept as a name rather than a bare 0 so the intent is
// readable wherever it is used.
const PREP_GRADE = 'آمادګي';

// Section letters as they are stored in classes.section. Display names
// vary (باء vs ب), but the stored value is the single letter.
const SECTION_ORDER = ['الف', 'ب', 'ج', 'د', 'ه'];

// English labels, index-aligned with GRADE_ORDER.
const GRADE_LABEL_EN = ['Preparatory',
                        'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5',
                        'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10',
                        'Grade 11', 'Grade 12'];

// Position in the ladder: 0 = آمادګي, 1 = اول … 12 = دولسم.
// -1 means the class has no grade set and promotion will skip it.
function gradeIndex(grade) {
  return GRADE_ORDER.indexOf(String(grade || '').trim());
}

// Position of a section within a grade. Unknown sections sort last.
function sectionIndex(section) {
  const i = SECTION_ORDER.indexOf(String(section || '').trim());
  return i === -1 ? SECTION_ORDER.length : i;
}

// Pre-school. On the ladder, and promoted into اول — just labelled
// differently on screen so nobody mistakes it for grade 1 itself.
function isPrep(cls) {
  const g = cls && (cls.grade_level !== undefined ? cls.grade_level : cls);
  return String(g || '').trim() === PREP_GRADE;
}

// No grade set at all: promotion cannot place these students.
function isUnassigned(cls) {
  const g = cls && (cls.grade_level !== undefined ? cls.grade_level : cls);
  return gradeIndex(g) === -1;
}

// The grade one step up, or null at the top of the ladder / off it.
function nextGrade(grade) {
  const i = gradeIndex(grade);
  if (i === -1 || i >= GRADE_ORDER.length - 1) return null;
  return GRADE_ORDER[i + 1];
}

function isFinalGrade(grade) {
  return gradeIndex(grade) === GRADE_ORDER.length - 1;   // دولسم
}

// Sort comparator: آمادګي first, then اول … دولسم, sections in order
// inside each grade, and any class with no grade set after them all.
function compareClasses(a, b) {
  const ga = gradeIndex(a.grade_level), gb = gradeIndex(b.grade_level);
  const oa = ga === -1 ? 1 : 0,        ob = gb === -1 ? 1 : 0;
  if (oa !== ob) return oa - ob;                 // graded classes first
  if (ga !== gb) return ga - gb;                 // then up the ladder
  const sa = sectionIndex(a.section), sb = sectionIndex(b.section);
  if (sa !== sb) return sa - sb;                 // then by section
  return String(a.name || '').localeCompare(String(b.name || ''));
}

// Decorate a class row with the ordering metadata the UI groups on.
function withGradeMeta(cls) {
  const gi = gradeIndex(cls.grade_level);
  return {
    ...cls,
    grade_index:    gi,                                  // -1 = no grade set
    grade_number:   gi === -1 ? null : gi,               // 0 = آمادګي, 1..12
    grade_label_en: gi === -1 ? null : GRADE_LABEL_EN[gi],
    section_index:  sectionIndex(cls.section),
    is_prep:        gi === 0,                            // آمادګي
    is_unassigned:  gi === -1,
  };
}

module.exports = {
  GRADE_ORDER, SECTION_ORDER, GRADE_LABEL_EN, PREP_GRADE,
  gradeIndex, sectionIndex, isPrep, isUnassigned, nextGrade, isFinalGrade,
  compareClasses, withGradeMeta,
};
