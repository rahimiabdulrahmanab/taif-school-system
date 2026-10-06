// ── Afghanistan wage income tax ───────────────────────────────
// The rule the school was given, in force from Mizan 1405:
//
//   • monthly salary of 10,000 AFN or less → no tax
//   • above 10,000 AFN                     → 10% of the WHOLE salary
//
// This is NOT a marginal rate, and the difference matters: a salary of
// 10,001 is taxed 1,000.10 on all of it, so that person takes home less
// than someone earning 10,000 and does not catch up until 11,112 AFN.
// That is what the policy says. It is written out here so that nobody
// reading the ledger later mistakes the step for a bug and "fixes" it.
//
// Shared by payroll.js (live calculation and the moment a salary is paid)
// and reports.js, so no two screens can disagree about what is owed.
const TAX_FREE_UPTO = 10000;   // AFN earned per month with no tax at all
const TAX_RATE      = 0.10;    // applied to the whole salary once above it

function calculateMonthlyTax(salary) {
  const s = Math.max(0, Number(salary) || 0);
  if (s <= TAX_FREE_UPTO) return 0;
  return Math.round(s * TAX_RATE * 100) / 100;
}

// How the rule is shown on the report the school files with the government.
// `whole` says the rate applies to the entire salary rather than to the
// slice above the line — without it the printed table would describe a
// marginal tax the school is not charging.
const TAX_BRACKETS = [
  { upTo: TAX_FREE_UPTO, rate: 0 },
  { upTo: Infinity, rate: TAX_RATE, whole: true },
];

module.exports = { TAX_BRACKETS, TAX_FREE_UPTO, TAX_RATE, calculateMonthlyTax };
