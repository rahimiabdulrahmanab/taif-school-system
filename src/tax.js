// ── Afghanistan wage income tax — progressive (marginal) brackets ─
// Shared by payroll.js (live calculation) and reports.js (tax report),
// so the two can never disagree.
// Bracket 1: 0 – 5,000     AFN  → 0%
// Bracket 2: 5,000 – 12,500 AFN → 2%   on the portion above 5,000
// Bracket 3: 12,500+        AFN → 10%  on the portion above 12,500
const TAX_BRACKETS = [
  { upTo: 5000,     rate: 0    },
  { upTo: 12500,    rate: 0.02 },
  { upTo: Infinity, rate: 0.10 },
];

function calculateMonthlyTax(salary) {
  const s = Math.max(0, Number(salary) || 0);
  let tax = 0, prev = 0;
  for (const b of TAX_BRACKETS) {
    if (s <= prev) break;
    const slice = Math.min(s, b.upTo) - prev;
    tax += slice * b.rate;
    prev = b.upTo;
  }
  return Math.round(tax * 100) / 100;
}

module.exports = { TAX_BRACKETS, calculateMonthlyTax };
