# Promotion Incident — Recovery Runbook

Grade 10 was promoted and the students landed in grade 12 instead of grade 11.

---

## 1. What actually happened

`POST /api/students/promote` moves **every active student up exactly one grade**,
based on `classes.grade_level`. Until the fix in this commit it had three
weaknesses, all of which matter here:

| Weakness | Consequence |
|---|---|
| No preview | One click applied the whole school immediately |
| No guard against a second run | Running it twice moves everyone up **two** grades |
| **No audit trail** | The previous `class_id` was never recorded — so there was nothing to restore from. This is why the app has no undo. |

There are only two ways grade 10 can end up in grade 12:

- **Cause A — promote ran twice.** 10 → 11 on the first run, 11 → 12 on the
  second. If this is what happened there is **hidden damage the school has not
  reported yet**: the students who were genuinely in grade 11 went to 12 on the
  first run and were then **archived as graduates** on the second. They have
  vanished from the active lists.
- **Cause B — a class is mislabelled.** The class the school calls "12" carries
  `grade_level = یوولسم` (11), so a single correct run put grade 10 into a class
  *named* 12. In this case no student data is wrong — the class label is.

The diagnostic in step 3 tells you which one it is. **They need different fixes,
so do not act before running it.**

### What was NOT touched

Promotion only ever writes `students.class_id`, and for the final grade
`students.is_active`, `graduated`, `graduated_at`. **No fee, payment, salary,
mark, or attendance record was changed, moved or deleted.** The fee ledger is
keyed on the student, not the class, so money is unaffected.

---

## 1b. What the diagnostic actually found (run 2026-09-03)

`node scripts/diagnose_promotion.js` plus follow-up read-only queries against
the live database established:

- **143 students were archived as graduates today**, all sitting in the two
  دولسم classes — 70 in دولسم (الف), 73 in دولسم (ب). Those classes now hold
  ~95 and ~100 students each, against 19–37 in every other class.
- **Every class is labelled correctly.** `grade_level` matches each class name,
  section values are clean (`الف` / `ب` / `ج`), and every promotion destination
  resolves. **Cause B is ruled out — this is cause A, repeated runs.**
- **Nothing else was written today** — no students added, no attendance, no
  fees, no expenses, no settings changes.
- **There is no evidence to reconstruct class moves from**: `marks` 0 rows,
  `subjects` 0, `fee_payments` 0, `attendance` 1 row (from June). Only the 143
  archived students left a timestamp, via `graduated_at`.

### Consequence: route 2 below is NOT available, and route 1 is now trivial

The whole database is 1,016 students, 42 teachers, 10 staff, 33 classes,
28 expenses, 1 income row, 1 attendance row. **There is no fee, mark or payroll
data that a full restore would lose.** So the careful branch-and-copy-back
procedure in route 1 is unnecessary here — a plain point-in-time restore of the
database to just before today's promotion returns the exact prior state and
loses nothing. Students' `monthly_fee` and `previous_debt` come back with them.

⏰ **This is the only route.** With no marks and no fees there is nothing to
rebuild from if the Neon history window closes. On the free plan that window is
24 hours.

---

## 2. Before anything else

1. **Do not press Promote again.** Every extra run moves the school up another grade.
2. **Do not run `db/schema.sql`.** It drops every table. (It now refuses to run
   against a database with data in it, but do not rely on that.)
3. **Write down roughly when the promotion was run** — date and time, and the
   admin who ran it. Step 4 depends on it.
4. Take a backup now: Admin → Settings → Backup → JSON.

---

## 3. Diagnose (read-only — changes nothing)

```bash
node scripts/diagnose_promotion.js
```

The database session is opened `READ ONLY`, so this cannot alter a record even
if it tried. It reports:

- **Section 1** — every class with its `grade_level`, flagging any class whose
  name and grade disagree (e.g. named "11" but labelled `دولسم`), any duplicate
  grade+section, and any class with no grade set. **Cause B shows up here.**
- **Section 2** — graduation batches by date. Two batches a day or two apart is
  the signature of **cause A**.
- **Section 3** — the reconstruction. Promotion never touches `marks` or
  `subjects`, so `subjects.class_id` still points at the class each student was
  actually taught in. This is the strongest evidence of the "before" state, and
  it prints exactly how many grades each group moved.

---

## 4. Repair

### Cause B (a class is mislabelled) — the easy case

No student data is wrong. Fix the `grade_level` on the class card, and move the
affected students to the correct class. Nothing else to do.

### Cause A (promote ran twice) — choose ONE route

#### Route 1 — Neon point-in-time restore (best; exact) ⏰ time-sensitive

The database is Neon. Neon keeps a history window (24 hours on the free plan,
up to 30 days on paid). **Do this today** — the window is the constraint.

> **Do NOT use Neon's "Restore branch to an earlier state" on `main`.** That
> rolls back *everything*, including every fee payment, mark and attendance
> record entered since the promotion. Create a **branch** and copy back only
> the four promotion columns.

1. Neon Console → your project → **Branches** → **Create branch** → choose
   *time* and pick a moment **just before the promotion ran**. Name it
   `before-promotion`. This is read-only history; `main` is untouched.
2. Copy the four columns out of the branch:

   ```bash
   psql "<BRANCH_CONNECTION_STRING>" -c "\copy (SELECT id, class_id, is_active, graduated, graduated_at FROM students) TO 'students_before.csv' WITH CSV HEADER"
   ```

3. Apply them back to `main`, **previewing inside the transaction first**:

   ```sql
   BEGIN;

   CREATE TEMP TABLE restore_students (
     id int, class_id int, is_active boolean, graduated boolean, graduated_at date);

   \copy restore_students FROM 'students_before.csv' WITH CSV HEADER

   -- PREVIEW: how many students would change, and how
   SELECT c_now.name AS now_in, c_old.name AS goes_back_to, COUNT(*)
     FROM students s
     JOIN restore_students r ON r.id = s.id
     LEFT JOIN classes c_now ON c_now.id = s.class_id
     LEFT JOIN classes c_old ON c_old.id = r.class_id
    WHERE s.class_id IS DISTINCT FROM r.class_id
    GROUP BY 1, 2 ORDER BY 3 DESC;

   -- Only if the preview looks right:
   UPDATE students s
      SET class_id     = r.class_id,
          is_active    = r.is_active,
          graduated    = r.graduated,
          graduated_at = r.graduated_at
     FROM restore_students r
    WHERE r.id = s.id
      AND (s.class_id     IS DISTINCT FROM r.class_id
        OR s.is_active    IS DISTINCT FROM r.is_active
        OR s.graduated    IS DISTINCT FROM r.graduated);

   COMMIT;   -- or ROLLBACK; if the preview was wrong
   ```

   This writes **only** the promotion columns. Students enrolled after the
   restore point are not in the CSV and are left completely alone, and no fee,
   mark or attendance row is read or written.

#### Route 2 — rebuild from marks (if the Neon window has passed)

Section 3 of the diagnostic reconstructs each student's real class from their
marks. That output is enough to build a corrective `UPDATE`, but the exact
mapping depends on the real class list — **send me the diagnostic output and I
will write the script against your actual data** rather than guessing at it here.

Students with no marks yet this year cannot be reconstructed this way and will
need the class register on paper.

---

## 5. Preventing it from happening again (already in this commit)

Run once, on the live database — it is additive and safe:

```bash
psql "$DATABASE_URL" -f db/migration_promotion_history.sql
```

From then on:

- **Promote shows a preview first.** It asks the server for a dry run
  (`?dry_run=1`, which writes nothing), lists exactly which classes move, how
  many students graduate, and warns that a second run moves everyone up two
  grades. Nothing is applied until that plan is confirmed.
- **Every run is recorded** in `student_class_history` — each student's previous
  class, and their previous active/graduated state — written in the *same
  transaction* as the promotion itself.
- **There is an Undo Promotion button** on the Classes page. It restores every
  student in the run to their previous class and un-archives anyone the run
  graduated. Nothing is deleted; the history row is stamped `undone_at`.

`GET /api/students/promote/history` lists past runs;
`POST /api/students/promote/undo` reverses one (admin only).

Undo covers runs made **after** this migration is applied. The run that caused
this incident predates it, so it must be repaired with section 4.
