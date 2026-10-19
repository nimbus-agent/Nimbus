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
 *
 * Three throughput pragmas ride along (all per-connection):
 * - `synchronous = NORMAL`, ONLY once WAL is confirmed. Under WAL this fsyncs at checkpoints rather
 *   than on every commit, and cannot corrupt the database; a power loss can drop the last few
 *   commits, which a re-sync restores. Under a rollback journal NORMAL is not corruption-safe, so a
 *   handle that fell back keeps SQLite's default (FULL).
 * - `temp_store = MEMORY`, so sorts and temporary indexes for large agent queries skip disk.
 * - `cache_size`, raised from SQLite's 2 MiB default to {@link PAGE_CACHE_KIB} KiB. Pages are
 *   allocated only as they are used, so an idle handle does not pay for it.
 */
export function applyWritablePragmas(db: Database): string {
  dbRun(db, "PRAGMA journal_mode = WAL");
  dbRun(db, `PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  const mode = readJournalMode(db);
  if (mode === "wal") dbRun(db, "PRAGMA synchronous = NORMAL");
  dbRun(db, "PRAGMA temp_store = MEMORY");
  dbRun(db, `PRAGMA cache_size = -${String(PAGE_CACHE_KIB)}`);
  return mode;
}

/** Per-connection page cache ceiling, in KiB (negative `cache_size` means KiB, not pages). */
export const PAGE_CACHE_KIB = 16_384;

/**
 * Refresh the query planner's statistics. Without them SQLite guesses between the `item` table's
 * single-column indexes, and nothing ran `ANALYZE` before this. The `0x10002` mask is SQLite's
 * recommendation for a long-lived connection at open: analyze any table that has never been
 * analyzed, with a row limit so a first run over a large index stays cheap. Best-effort — a
 * failure leaves the planner exactly where it was.
 */
export function optimizeQueryPlanner(db: Database, mask: "open" | "close" = "open"): void {
  try {
    dbRun(db, mask === "open" ? "PRAGMA optimize = 0x10002" : "PRAGMA optimize");
  } catch {
    /* best-effort: statistics are an optimisation, never a correctness requirement */
  }
}

/** The journal mode currently in force, lowercased (`wal`, `delete`, `memory`, …). */
export function readJournalMode(db: Database): string {
  const row = db.query("PRAGMA journal_mode;").get() as { journal_mode?: string } | null;
  return (row?.journal_mode ?? "unknown").toLowerCase();
}
