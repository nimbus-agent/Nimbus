import type { Database } from "bun:sqlite";

/**
 * I9 — canonical identifier escaper. SQLite has no parameter-binding syntax
 * for identifiers (table/column names), only for values, so any identifier
 * that cannot be reduced to a literal from a fixed allowlist must be
 * interpolated through this function rather than a raw template literal.
 * Doubling embedded `"` is the standard SQLite quoted-identifier escape.
 *
 * This is the single canonical copy — every call site imports it from here
 * (`db/repair.ts`, `connectors/reindex.ts`) rather than redefining it, per
 * `docs/SECURITY-INVARIANTS.md` I9. Behaviour must not drift between callers.
 */
export function escapeIdentifier(id: string): string {
  return `"${id.replaceAll('"', '""')}"`;
}

let _diskSpaceWarning = false;
const _diskFullListeners: Array<() => void> = [];

export function isDiskSpaceWarning(): boolean {
  return _diskSpaceWarning;
}

export function setDiskSpaceWarning(value: boolean): void {
  const prev = _diskSpaceWarning;
  _diskSpaceWarning = value;
  if (!prev && value) {
    for (const fn of _diskFullListeners) {
      try {
        fn();
      } catch {
        /* notification errors must never crash the write path */
      }
    }
  }
}

export function onDiskFull(fn: () => void): () => void {
  _diskFullListeners.push(fn);
  return () => {
    const idx = _diskFullListeners.indexOf(fn);
    if (idx !== -1) {
      _diskFullListeners.splice(idx, 1);
    }
  };
}

export class DiskFullError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("SQLite database is full — free disk space and retry");
    this.name = "DiskFullError";
    this.cause = cause;
  }
}

const SQLITE_FULL = 13;

function isSqliteFull(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const e = err as Record<string, unknown>;
  const code = e["code"];
  if (typeof code === "number") {
    return (code & 0xff) === SQLITE_FULL;
  }
  if (typeof code === "string") {
    return code === "SQLITE_FULL";
  }
  return false;
}

function handleWriteError(err: unknown): never {
  if (isSqliteFull(err)) {
    setDiskSpaceWarning(true);
    throw new DiskFullError(err);
  }
  throw err;
}

export function dbRun(db: Database, sql: string, params?: unknown[]): ReturnType<Database["run"]> {
  try {
    if (params !== undefined && params.length > 0) {
      return db.run(sql, params as Parameters<Database["run"]>[1]);
    }
    return db.run(sql);
  } catch (err) {
    handleWriteError(err);
  }
}

export function dbExec(db: Database, sql: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    handleWriteError(err);
  }
}

export function dbStmtRun<S extends { run: (...args: never[]) => unknown }>(
  stmt: S,
  ...params: Parameters<S["run"]>
): ReturnType<S["run"]> {
  try {
    return stmt.run(...params) as ReturnType<S["run"]>;
  } catch (err) {
    handleWriteError(err);
  }
}
