import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";

/** How many of the V18 chain columns exist on `audit_log` right now (0 before V18, 2 after). */
function auditLogHashColumnCount(db: Database): number {
  const rows = db.query(`PRAGMA table_info(audit_log)`).all() as Array<{ name: string }>;
  return rows.filter((r) => r.name === "row_hash" || r.name === "prev_hash").length;
}

/**
 * Regression cover for #969.
 *
 * `bun:sqlite`'s `Database.close()` is a no-op when a statement created by
 * `db.prepare()` has not been finalized: the plain `close()` swallows the
 * failure, and `close(true)` reports `database is locked`. The file handle is
 * never released, so on Windows every subsequent `rmSync` of the containing
 * directory fails `EBUSY` — which is how #969 was found (30/30 leaked temp
 * dirs). The retained statement itself is platform-independent, so this
 * asserts on `close(true)` rather than on the Windows-only delete symptom.
 *
 * `db.query()` is cache-managed by Bun and released on close; only bare
 * `db.prepare()` needs an explicit `finalize()`.
 */
describe("db statement finalization (#969)", () => {
  const dirs: string[] = [];

  function freshDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-stmt-final-"));
    dirs.push(dir);
    return join(dir, "nimbus.db");
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      // maxRetries: 0 / retryDelay: 0 — if a regression ever re-pins a handle here, this
      // must fail FAST rather than block the hook's timeout budget. A leaked temp dir is
      // the accepted trade-off (#972, #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    }
  });

  it("leaves no unfinalized statement after LocalIndex.ensureSchema", () => {
    const db = new Database(freshDbPath());
    LocalIndex.ensureSchema(db);

    // close(true) throws "database is locked" if any prepared statement is
    // still live. A clean close is the whole assertion.
    expect(() => {
      db.close(true);
    }).not.toThrow();
  });

  it("leaves no unfinalized statement after the audit-chain backfill has rows to walk", () => {
    const db = new Database(freshDbPath());

    // The backfill only iterates on the V17 -> V18 step, and only over rows that
    // ALREADY exist when it runs. Migrating straight to current and inserting
    // afterwards would leave the loop body unexecuted — the statement leaks either
    // way, which is exactly why that weaker version of this test looked fine.
    // Stopping at 17 first is what puts real rows in front of the backfill.
    runIndexedSchemaMigrations(db, 17);
    expect(auditLogHashColumnCount(db)).toBe(0); // pre-V18 shape: no row_hash/prev_hash yet

    for (const [i, action] of ["a.one", "a.two", "a.three"].entries()) {
      db.run(
        `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp)
         VALUES (?, 'approved', '{}', ?)`,
        [action, i + 1],
      );
    }

    // Now run the rest, including V17 -> V18 with three rows to walk.
    LocalIndex.ensureSchema(db);

    // Prove the loop body actually ran, so this test cannot silently decay back
    // into the no-op version: every pre-existing row must now carry a chain hash.
    const unhashed = db
      .query(`SELECT COUNT(*) AS c FROM audit_log WHERE row_hash IS NULL`)
      .get() as { c: number };
    expect(unhashed.c).toBe(0);

    expect(() => {
      db.close(true);
    }).not.toThrow();
  });

  it("releases the underlying file handle so the directory can be removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-stmt-final-rm-"));
    const db = new Database(join(dir, "nimbus.db"));
    LocalIndex.ensureSchema(db);
    db.close();

    // On Windows this threw EBUSY for every iteration before #969 was fixed.
    expect(() => {
      rmSync(dir, { recursive: true, force: true });
    }).not.toThrow();
  });
});

/**
 * Source-scanning guard for #969. The runtime tests above cover the schema
 * path; this keeps the *class* of bug from returning at a new call site, which
 * is how three of the five `prepare()` sites drifted in the first place.
 */
describe("db.prepare() call sites are balanced by finalize() (#969)", () => {
  const SRC_ROOT = join(import.meta.dir, "..", "..", "..", "src");

  function walkTs(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkTs(full, acc);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        acc.push(full);
      }
    }
    return acc;
  }

  function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      count += 1;
      idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
  }

  /**
   * Comments must be stripped before counting: prose that mentions
   * `db.prepare()` — including the #969 comments at the fixed call sites —
   * otherwise inflates the count and makes the guard fire on clean code.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  it("every source file calling .prepare( also finalizes at least as many statements", () => {
    const offenders: string[] = [];
    let scanned = 0;
    let sitesSeen = 0;

    for (const file of walkTs(SRC_ROOT)) {
      const text = stripComments(readFileSync(file, "utf8"));
      const prepares = countOccurrences(text, ".prepare(");
      if (prepares === 0) {
        continue;
      }
      scanned += 1;
      sitesSeen += prepares;
      const finalizes = countOccurrences(text, ".finalize()");
      if (finalizes < prepares) {
        offenders.push(
          `${relative(SRC_ROOT, file).split(sep).join("/")}: ${String(prepares)} prepare( vs ${String(finalizes)} finalize()`,
        );
      }
    }

    // Guard the guard: if this drops to zero the scan silently stopped working.
    expect(scanned).toBeGreaterThan(0);
    expect(sitesSeen).toBeGreaterThanOrEqual(scanned);
    expect(offenders).toEqual([]);
  });
});
