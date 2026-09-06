# Taif High School Management System

Built by Rahimi Tech Solution — Jalalabad, Afghanistan

## Development

```bash
# Install dependencies
npm install

# Run in development (browser only)
npm run dev

# Run as Electron desktop app
npm start
```

## Build Windows .exe

```bash
# Build installer
npm run build:win
```

The installer will be in the `dist/` folder.

## Requirements

- Node.js v18+
- PostgreSQL 14+
- Windows 10/11 (for .exe build)

## Database Setup

### A NEW, EMPTY database

1. Create a PostgreSQL database named `taif_school`
2. Copy `env.example` to `.env` and fill in your DB credentials
3. Run `db/schema.sql` to create the base tables
4. Then run the migrations **in this exact order**. `schema.sql` alone does
   **not** produce a working database — it still describes the original data
   model, and most of the app (fee ledger, teacher portal, income, class
   teachers, promotion history) lives in the migrations:

   | # | File | Adds |
   |---|------|------|
   | 1 | `db/migration_align_with_routes.sql` | fee ledger columns, `external_income`, `class_teachers`, `student_month_due`, graduation columns |
   | 2 | `db/migration_teacher_portal.sql`    | user roles, subject teachers, mark approval workflow |
   | 3 | `db/migration_marks_unique.sql`      | `exam_type` + unique key on marks |
   | 4 | `db/migration_audit_fixes.sql`       | year-aware marks key (supersedes #3), one-scan-per-day rule |
   | 5 | `db/migration_parent_phone2.sql`     | second parent WhatsApp number |
   | 6 | `db/migration_promotion_history.sql` | promotion audit trail + undo |
   | 7 | `db/migration_class_integrity.sql`   | rejects unknown grade levels, one class per grade+section |
   | 8 | `db/migration_fee_receipts.sql`      | receipt serial per fee payment, day index for reconciliation |

### An EXISTING database that already holds school data

**Never run `db/schema.sql`.** It drops every table. It now aborts and rolls
itself back if it finds data, but do not rely on that — just don't run it.

Run only the migration files above. Each is additive and idempotent
(`IF NOT EXISTS`), so re-running one is safe. Two exceptions worth knowing
before you run them on a live database: `migration_marks_unique.sql` and
`migration_audit_fixes.sql` both DELETE duplicate `marks` rows in order to
create a unique index. Take a backup first (Admin → Settings → Backup).

## Contact

Rahimi Tech Solution  
Phone: +93 767 617 184  
Email: info@rahimitechsolution.com
