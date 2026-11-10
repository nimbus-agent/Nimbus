import type { Database } from "bun:sqlite";

import { dbExec, dbRun, escapeIdentifier } from "../db/write.ts";

/**
 * V87 (Phase 10 SA1): `audit_log.hitl_status` and `egress_ledger.hitl_status` gain a fourth value,
 * `standing_approved` (reserved for I55; nothing produces it yet). SQLite cannot alter a CHECK, so
 * each table is rebuilt: the new table is made from the CURRENT table's own DDL with the CHECK list
 * rewritten, so every column, default and constraint added since the table was born is carried
 * over without being restated here. The historical DDL (`schema-sql.ts`, `egress-ledger-v44-sql.ts`)
 * is NOT edited: a fresh install runs every step up to 87 and reaches the same table.
 *
 * Indexes and triggers go with a dropped table, so they are snapshotted first, re-run verbatim once
 * the renamed table exists again, and compared with a second snapshot (a lost index or an
 * append-only trigger would otherwise vanish silently).
 */
export const HITL_STATUS_V87_TABLES = ["audit_log", "egress_ledger"] as const;

export const STANDING_APPROVED = "standing_approved";

/**
 * One-shot reads through `prepare` + `finalize`. A cached `db.query` statement left a connection
 * that had migrated through this step unable to `close(true)` (Windows EBUSY on the file delete);
 * a statement finalized here cannot outlive the step.
 */
function readRows(db: Database, sql: string, ...params: string[]): unknown[] {
  const stmt = db.prepare(sql);
  try {
    return stmt.all(...params);
  } finally {
    stmt.finalize();
  }
}

type SchemaObject = { type: string; name: string; sql: string };

/** The table's indexes and triggers (`sqlite_autoindex_*` have NULL sql and are rebuilt by CREATE TABLE). */
function snapshotDependents(db: Database, table: string): SchemaObject[] {
  return readRows(
    db,
    `SELECT type, name, sql FROM sqlite_master
      WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
      ORDER BY type, name`,
    table,
  ) as SchemaObject[];
}

/**
 * Refuse a rebuild that would silently break something else: a view, or a trigger on ANOTHER
 * table, whose SQL names this table. None exists today; the check keeps a future one from being
 * left dangling by the DROP.
 */
function assertNoOtherReferences(db: Database, table: string): void {
  const rows = readRows(
    db,
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND ((type = 'view') OR (type = 'trigger' AND tbl_name <> ?))`,
    table,
  ) as SchemaObject[];
  const mention = new RegExp(`\\b${table}\\b`);
  const hit = rows.find((r) => mention.test(r.sql));
  if (hit !== undefined) {
    throw new Error(`V87: ${hit.type} ${hit.name} references ${table}; rebuild refused`);
  }
}

/**
 * The table's DDL, renamed to `<table>_v87`, with `'standing_approved'` added to the
 * `hitl_status` CHECK list. Both rewrites are anchored and must match exactly once.
 */
export function v87TableSql(currentSql: string, table: string): string {
  const create = new RegExp(`^CREATE TABLE\\s+"?${table}"?(?=\\s*\\()`);
  if (!create.test(currentSql)) {
    throw new Error(`V87: ${table} DDL does not start with CREATE TABLE ${table}`);
  }
  const check = /CHECK\s*\(\s*hitl_status\s+IN\s*\(([^()]*)\)\s*\)/g;
  const matches = currentSql.match(check) ?? [];
  if (matches.length !== 1) {
    throw new Error(`V87: expected one hitl_status CHECK in ${table}, found ${matches.length}`);
  }
  return currentSql
    .replace(create, `CREATE TABLE ${table}_v87`)
    .replace(check, (_m, list: string) => {
      if (list.includes(STANDING_APPROVED)) {
        throw new Error(`V87: ${table} already allows ${STANDING_APPROVED}`);
      }
      return `CHECK(hitl_status IN (${list.trim()},'${STANDING_APPROVED}'))`;
    });
}

function countRows(db: Database, table: string): number {
  const rows = readRows(db, `SELECT COUNT(*) AS n FROM ${escapeIdentifier(table)}`) as Array<{
    n: number;
  }>;
  return rows[0]?.n ?? 0;
}

function autoincrementSeq(db: Database, table: string): number | undefined {
  const rows = readRows(db, "SELECT seq FROM sqlite_sequence WHERE name = ?", table) as Array<{
    seq: number;
  }>;
  return rows[0]?.seq;
}

/**
 * `ALTER TABLE ... RENAME` re-parses every trigger in the database to rewrite references, and the
 * session-memory triggers name the sqlite-vec virtual tables: on a connection that has not loaded
 * the extension yet (`LocalIndex.ensureSchema` migrates BEFORE it loads it, and a host where it
 * cannot load at all) that re-parse fails with "no such module: vec0". Nothing but the table itself
 * refers to the renamed name (checked by `assertNoOtherReferences`), so the legacy rename, which
 * skips that rewrite, loses nothing. The pragma is connection state, not transactional: it is put
 * back whatever happens.
 */
function renameWithoutSchemaReparse(db: Database, from: string, to: string): void {
  const [before] = readRows(db, "PRAGMA legacy_alter_table") as Array<{
    legacy_alter_table: number;
  }>;
  dbExec(db, "PRAGMA legacy_alter_table = ON");
  try {
    dbExec(db, `ALTER TABLE ${escapeIdentifier(from)} RENAME TO ${escapeIdentifier(to)}`);
  } finally {
    dbExec(db, `PRAGMA legacy_alter_table = ${before?.legacy_alter_table === 1 ? "ON" : "OFF"}`);
  }
}

function rebuildTable(db: Database, table: string): void {
  assertNoOtherReferences(db, table);
  const dependents = snapshotDependents(db, table);
  const [current] = readRows(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  ) as Array<{ sql: string }>;
  if (current === undefined) throw new Error(`V87: table ${table} is missing`);
  const columns = (
    readRows(db, `PRAGMA table_info(${escapeIdentifier(table)})`) as Array<{ name: string }>
  ).map((c) => escapeIdentifier(c.name));
  const list = columns.join(", ");
  const before = countRows(db, table);
  const seq = autoincrementSeq(db, table);

  const staging = `${table}_v87`;
  dbExec(db, v87TableSql(current.sql, table));
  dbExec(
    db,
    `INSERT INTO ${escapeIdentifier(staging)} (${list}) SELECT ${list} FROM ${escapeIdentifier(table)}`,
  );
  if (countRows(db, staging) !== before) {
    throw new Error(`V87: ${table} copy produced a different row count`);
  }
  dbExec(db, `DROP TABLE ${escapeIdentifier(table)}`);
  renameWithoutSchemaReparse(db, staging, table);
  // An AUTOINCREMENT counter can be ahead of MAX(id) (pruned tail rows): never let an id be reused.
  if (seq !== undefined) {
    dbRun(db, "UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?", [seq, table]);
  }
  // Only now do the indexes and triggers have a table to attach to.
  for (const o of dependents) dbExec(db, o.sql);
  const after = snapshotDependents(db, table);
  if (JSON.stringify(after) !== JSON.stringify(dependents)) {
    throw new Error(`V87: ${table} indexes or triggers differ after the rebuild`);
  }
}

/** Rebuild both tables. Call inside the migration's transaction. */
export function rebuildHitlStatusTables(db: Database): void {
  for (const table of HITL_STATUS_V87_TABLES) rebuildTable(db, table);
}
