---
name: nimbus-db-migrations
description: >
  Reference for authoring SQLite migrations in the Nimbus Gateway: file location and
  numbering, the runner contract (transaction wrapping, pre-migration backups, ledger
  recording), the append-only schema rule, large-backfill batching, the _schema_migrations
  ledger, the new-table checklist, and FTS5/vec0 virtual-table cautions. Use this skill
  whenever the user is adding a schema migration, modifying an existing one, debugging
  a failed migration, asking why a migration cannot be rolled back, or adding a new
  table or column. Also trigger for questions like "what V<N> number do I use?", "can
  I drop this column?", "how do I backfill safely?", or "where does the pre-migration
  backup live?". Consult before creating any file under packages/gateway/src/index/.
---

# Nimbus DB Migrations

## Migration Location

Migrations are registered in a **single central runner** at `packages/gateway/src/index/migrations/runner.ts` via the `INDEXED_SCHEMA_STEPS` array. There is no directory of numbered migration files — each migration step is a function added to that array.

The SQL for each step lives in a sibling constant file following the naming pattern:

```
packages/gateway/src/index/<topic>-v<N>-sql.ts
```

Examples:
- `packages/gateway/src/index/tool-call-log-v29-sql.ts` — V29 `tool_call_log` table
- `packages/gateway/src/index/vec-items-1536-v30-sql.ts` — V30 `vec_items_1536` virtual table
- `packages/gateway/src/index/extension-dependency-v31-sql.ts` — V31 `extension_dependency` table

The SQL constant is exported from the file and consumed by the migration step function in `runner.ts`.

**Version numbers are strictly sequential — never reuse or skip a number.**

## Migration Runner Contract

The runner in `packages/gateway/src/index/migrations/runner.ts`:

- Applies each `INDEXED_SCHEMA_STEPS` entry in order via `applyIndexedSchemaStep`.
- Wraps each step in **a single transaction**.
- Writes a **pre-migration backup** via `applyIndexedSchemaStep` before each step runs.
- Records each step in `_schema_migrations` on success via `recordMigration`.
- On a thrown step: rolls back the transaction, restores the backup, marks the migration `failed` in the ledger, and exits with an error.

**Never write a migration that cannot be safely rolled back within a transaction.**

## Pre-migration Backup Rule

The backup is written by `applyIndexedSchemaStep` automatically before every step. **Never skip it.** If the backup write fails, the migration is **aborted** — this is intentional.

The backup lives at:

```
<dataDir>/backups/pre-migration-V<N>-<timestamp>.db
```

## Migration File Structure

Each migration step is a function added to `INDEXED_SCHEMA_STEPS` in `runner.ts`. The pattern follows:

```typescript
// In packages/gateway/src/index/<topic>-v<N>-sql.ts
export const V<N>_SCHEMA_SQL = `
  CREATE TABLE ...;
  CREATE INDEX ...;
`;

// In packages/gateway/src/index/migrations/runner.ts — add the step:
function migrateIndexedVNToVN(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, V<N>_SCHEMA_SQL);
    dbExec(db, "PRAGMA user_version = <N>");
    recordMigration(db, <N>, "<description>", now);
  })();
}

// Then add to INDEXED_SCHEMA_STEPS:
export const INDEXED_SCHEMA_STEPS: IndexedSchemaStep[] = [
  // ... existing steps ...
  { version: <N>, apply: migrateIndexedVNToVN },
];
```

See `runner-v31.test.ts` as the canonical test pattern for new migration steps.

**No `down()` function** — Nimbus migrations are append-only and forward-only. If you need to undo a migration, write a new migration that reverses it.

## Append-only Schema Rule

**Never** drop a column, rename a column, or drop a table in a migration unless it was added in the same phase and has no data.

Additive changes only:

- `CREATE TABLE`
- `CREATE INDEX`
- `ALTER TABLE ADD COLUMN`
- `CREATE VIRTUAL TABLE`

If a column rename is truly necessary: add the new column, backfill it, and **leave the old column in place with a deprecation comment**.

## Large Backfill Pattern

Migrations that backfill existing rows must process in batches to avoid locking the DB for extended periods:

```typescript
import { dbRun } from "../../db/write.ts";

const BATCH = 1000;
let offset = 0;
while (true) {
  const rows = db.query("SELECT id FROM table LIMIT ? OFFSET ?").all(BATCH, offset);
  if (rows.length === 0) break;
  db.transaction(() => {
    for (const row of rows) {
      dbRun(db, "UPDATE table SET col = ? WHERE id = ?", [value, row.id]);
    }
  })();
  offset += BATCH;
}
```

**Never process an unbounded number of rows in a single statement inside a migration.**

## `_schema_migrations` Ledger

Columns:

| Column | Type | Notes |
|---|---|---|
| `version` | integer | the `V<N>` number |
| `description` | text | from the step definition |
| `applied_at` | integer | unix ms |
| `status` | `applied` \| `failed` | runner-managed |

The runner inserts a row with `status = 'applied'` after each successful migration via `recordMigration`. **Never write to this table manually.**

## New Table Checklist

When adding a new table, always include:

- A primary key.
- `created_at INTEGER NOT NULL` (unix ms).
- Appropriate indexes for the expected query patterns.
- A `CHECK` constraint on any enum-like column.
- An entry in the schema reference at [`docs/schema-reference.md`](../../docs/schema-reference.md) (the canonical table-by-table reference, extracted from `architecture.md`).
- All write statements (`INSERT` / `UPDATE` / `DELETE` / `CREATE TABLE` / `CREATE INDEX`) go through `dbRun` / `dbExec` / `dbStmtRun` from `db/write.ts` (invariant `I14`). Direct `db.run(` / `db.exec(` outside the wrapper fails `bun run audit:invariants`.

## Virtual Table Caution

FTS5 and `vec0` virtual tables cannot be created inside a regular `ALTER TABLE` — they must be `CREATE VIRTUAL TABLE` statements.

When deleting rows from a source table that has an FTS5 shadow:

- **Delete from the FTS5 table first** using targeted row deletion: `DELETE FROM items_fts WHERE rowid = ?`.
- **Never** issue `INSERT INTO items_fts(items_fts) VALUES('rebuild')` inside a migration — that rebuilds the entire index and blocks reads.

## Coverage Gate

`packages/gateway/src/index/migrations/` ≥ **85% line coverage**. Migration steps are covered by the integration test suite (e.g. `runner-v31.test.ts`) which applies all steps against a fresh in-memory SQLite instance on every CI run.

## Authoring Checklist

- [ ] SQL constant created at `packages/gateway/src/index/<topic>-v<N>-sql.ts` with the next sequential version number — no reuse, no gaps.
- [ ] Migration step function `migrateIndexedV<prev>ToV<N>(db, now)` added to `runner.ts`; wraps in `db.transaction()`; calls `dbExec(db, V<N>_SCHEMA_SQL)`, `dbExec(db, "PRAGMA user_version = <N>")`, and `recordMigration(db, <N>, "description", now)`.
- [ ] Step registered in `INDEXED_SCHEMA_STEPS` array in `runner.ts`.
- [ ] All schema changes are additive (`CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE ADD COLUMN`, `CREATE VIRTUAL TABLE`); no drops or renames except for same-phase, no-data items.
- [ ] Backfills process in 1 000-row batches inside `db.transaction()`.
- [ ] No manual writes to `_schema_migrations`.
- [ ] New tables include primary key, `created_at INTEGER NOT NULL`, query-pattern indexes, and `CHECK` constraints on enum columns.
- [ ] FTS5 row deletes use targeted `DELETE FROM items_fts WHERE rowid = ?` — never the `'rebuild'` command.
- [ ] Schema reference in [`docs/schema-reference.md`](../../docs/schema-reference.md) updated for any new table.
- [ ] All write statements go through `dbRun` / `dbExec` / `dbStmtRun` from `db/write.ts` — no direct `db.run(` / `db.exec(` (invariant `I14`; `bun run audit:invariants` fails on violations).
- [ ] Integration test added (pattern: `runner-v31.test.ts`) covering the new step; `packages/gateway/src/index/migrations/` line coverage stays ≥ 85%.
