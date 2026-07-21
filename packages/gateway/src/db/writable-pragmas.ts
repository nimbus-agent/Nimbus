import type { Database } from "bun:sqlite";
import { dbRun } from "./write.ts";

/**
 * How long a writable handle waits for a lock before returning `SQLITE_BUSY`.
 *
 * Kept here rather than repeated at each open site so the three production
 * writers cannot drift apart.
 */
export const BUSY_TIMEOUT_MS = 8000;

/**
 * Pragmas every writable production handle must carry.
 *
 * Without `journal_mode = WAL`, SQLite falls back to the rollback journal,
 * where readers and the writer block each other. Several handles are open
 * against the one `nimbus.db` concurrently — the main writer, the embedding
 * worker, and the I13 HTTP write handle — so delta sync, queries and
 * deployment-annotation writes serialize, and `busy_timeout` becomes the only
 * thing standing between contention and an error. It also makes the shutdown
 * `wal_checkpoint(TRUNCATE)` a silent no-op.
 *
 * `journal_mode` is a persistent property of the database FILE, not of the
 * connection: setting it once converts `nimbus.db` and every later handle —
 * including read-only ones, which cannot set it themselves — inherits WAL.
 *
 * Returns the journal mode SQLite actually adopted. The request can be
 * declined rather than raise: `:memory:` databases report `memory`, and WAL
 * needs shared memory, so it is unavailable on some network filesystems.
 * Those cases degrade to the old blocking behaviour, which is worse but still
 * correct — failing gateway startup over a filesystem quirk would be a worse
 * trade. Callers that must be sure (i.e. tests) assert on this return value.
 */
export function applyWritablePragmas(db: Database): string {
  dbRun(db, "PRAGMA journal_mode = WAL");
  dbRun(db, `PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  return readJournalMode(db);
}

/** The journal mode currently in force, lowercased (`wal`, `delete`, `memory`, …). */
export function readJournalMode(db: Database): string {
  const row = db.query("PRAGMA journal_mode;").get() as { journal_mode?: string } | null;
  return (row?.journal_mode ?? "unknown").toLowerCase();
}
