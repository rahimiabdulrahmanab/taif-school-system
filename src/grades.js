// ── Afghan school grade ladder ─────────────────────────────────
// The single source of truth for "what order do classes come in" and
// "what is the next grade up". Shared by the Classes screen and the
// promotion logic so the two can never disagree — same reason
// src/tax.js and src/holidays.js exist.
//
// Grades run اول (1) … دولسم (12). آمادګي (university-entrance prep)
// is deliberately NOT in this ladder: it sits outside the 1–12
// sequence, nobody is promoted into or out of it, and it is shown in
// its own row on the Classes screen.

const GRADE_ORDER = ['اول', 'دوهم', 'دریم', 'څلورم', 'پنځم', 'شپږم',
                     'اووم', 'اتم', 'نهم', 'لسم', 'یوولسم', 'دولسم'];

// Section letters as they are stored in classes.section. Display names
// vary (باء vs ب), but the stored value is the single letter.
const SECTION_ORDER = ['الف', 'ب', 'ج', 'د', 'ه'];

// English labels, index-aligned with GRADE_ORDER.
const GRADE_LABEL_EN = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5',
                        'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10',
                        'Grade 11', 'Grade 12'];

// 0-based position in the ladder, or -1 when the grade is unknown/unset
// (آمادګي, or a class whose grade_level was never filled in).
function gradeIndex(grade) {
  return GRADE_ORDER.indexOf(String(grade || '').trim());
}

// Position of a section within a grade. Unknown sections sort last.
function sectionIndex(section) {
  const i = SECTION_ORDER.indexOf(String(section || '').trim());
  return i === -1 ? SECTION_ORDER.length : i;
}

// A class outside the 1–12 ladder: آمادګي, or any class with no grade set.
function isPrep(cls) {
  return gradeIndex(cls && cls.grade_level) === -1;
}

// The grade one step up, or null at the top of the ladder / off it.
function nextGrade(grade) {
  const i = gradeIndex(grade);
  if (i === -1 || i >= GRADE_ORDER.length - 1) return null;
  return GRADE_ORDER[i + 1];
}

function isFinalGrade(grade) {
  return gradeIndex(grade) === GRADE_ORDER.length - 1;
}

// Sort comparator: grade 1 first … grade 12 last, sections in order
// inside each grade, and every off-ladder class (آمادګي) after them all.
function compareClasses(a, b) {
  const ga = gradeIndex(a.grade_level), gb = gradeIndex(b.grade_level);
  const oa = ga === -1 ? 1 : 0,        ob = gb === -1 ? 1 : 0;
  if (oa !== ob) return oa - ob;                 // ladder classes first
  if (ga !== gb) return ga - gb;                 // then by grade
  const sa = sectionIndex(a.section), sb = sectionIndex(b.section);
  if (sa !== sb) return sa - sb;                 // then by section
  return String(a.name || '').localeCompare(String(b.name || ''));
}

// Decorate a class row with the ordering metadata the UI groups on.
function withGradeMeta(cls) {
  const gi = gradeIndex(cls.grade_level);
  return {
    ...cls,
    grade_index:   gi,                                   // -1 = off the ladder
    grade_number:  gi === -1 ? null : gi + 1,            // 1..12
    grade_label_en: gi === -1 ? null : GRADE_LABEL_EN[gi],
    section_index: sectionIndex(cls.section),
    is_prep:       gi === -1,
  };
}

module.exports = {
  GRADE_ORDER, SECTION_ORDER, GRADE_LABEL_EN,
  gradeIndex, sectionIndex, isPrep, nextGrade, isFinalGrade,
  compareClasses, withGradeMeta,
};
