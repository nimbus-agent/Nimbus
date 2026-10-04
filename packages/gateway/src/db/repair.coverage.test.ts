/**
 * `repairIndex` paths `repair.test.ts` cannot reach on its hand-rolled schema, driven here on the
 * REAL migrated schema (a real FTS5 `item_fts`, a real sqlite-vec `vec_items_384`):
 *  - a failed FTS consistency check followed by a rebuild that SUCCEEDS — the index really is
 *    rebuilt from `item`, so a phantom full-text entry disappears and real items still match;
 *  - a vec-orphan scan and an FK check that throw a NON-Error value, reported verbatim.
 *
 * A damaged FTS5 index cannot be produced on purpose (its shadow tables refuse writes, and the
 * plain `integrity-check` that `verifyIndex` runs does not compare against the content table), so
 * the corruption VERDICT is injected on this one connection: its `integrity-check` statement
 * throws exactly what SQLite reports for a damaged index. Every other statement — including the
 * rebuild itself — runs against the real database.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../index/local-index.ts";
import { isVecLoaded } from "../index/sqlite-vec-load.ts";
import { repairIndex } from "./repair.ts";

function migratedDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const VEC_AVAILABLE = ((): boolean => {
  const db = migratedDb();
  const ok = isVecLoaded(db);
  db.close();
  return ok;
})();

/** Runs `onSql` before every `run` on THIS connection; it throws to refuse a statement. */
function interceptRun(db: Database, onSql: (sql: string) => void): void {
  const realRun = db.run.bind(db);
  db.run = ((sql: string, ...params: unknown[]) => {
    onSql(sql);
    return (realRun as (s: string, ...p: unknown[]) => unknown)(sql, ...params);
  }) as unknown as Database["run"];
}

/** Runs `onSql` before every `query` on THIS connection; it throws to refuse a statement. */
function interceptQuery(db: Database, onSql: (sql: string) => void): void {
  const realQuery = db.query.bind(db);
  db.query = ((sql: string) => {
    onSql(sql);
    return realQuery(sql);
  }) as unknown as Database["query"];
}

function ftsMatches(db: Database, term: string): number {
  return db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH ?").all(term).length;
}

function repairAudits(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'db.repair'").get() as {
      n: number;
    }
  ).n;
}

describe("repairIndex on the real schema", () => {
  test("a failed FTS consistency check rebuilds item_fts from the item table", () => {
    const db = migratedDb();
    try {
      for (const n of [1, 2]) {
        upsertIndexedItem(db, {
          service: "github",
          type: "pr",
          externalId: `acme/api#${String(n)}`,
          title: `alpha bravo ${String(n)}`,
          modifiedAt: n,
          syncedAt: n,
        });
      }
      // An index entry with no row behind it — the kind of drift a rebuild exists to clear.
      db.run("INSERT INTO item_fts(rowid, title, body) VALUES (999, 'phantom entry', 'ghost')");
      expect(ftsMatches(db, "phantom")).toBe(1);

      let integrityChecks = 0;
      interceptRun(db, (sql) => {
        if (sql.includes("'integrity-check'")) {
          integrityChecks += 1;
          throw new Error('fts5: checksum mismatch for table "item_fts"');
        }
      });

      const report = repairIndex(db, CURRENT_SCHEMA_VERSION);

      expect(integrityChecks).toBe(1);
      expect(report.outcomes).toEqual([
        { action: "fts5_rebuild", status: "applied", detail: "item_fts rebuilt" },
      ]);
      expect(ftsMatches(db, "phantom")).toBe(0);
      expect(ftsMatches(db, "bravo")).toBe(2);
      expect(repairAudits(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("an FK check that throws a non-Error is reported with that value as the detail", () => {
    const db = migratedDb();
    try {
      interceptQuery(db, (sql) => {
        if (sql === "PRAGMA foreign_key_check") throw "fk check aborted: database is locked";
      });
      const report = repairIndex(db, CURRENT_SCHEMA_VERSION);
      expect(report.outcomes).toEqual([
        {
          action: "foreign_key_cascade_delete",
          status: "error",
          detail: "fk check aborted: database is locked",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test.skipIf(!VEC_AVAILABLE)(
    "a vec orphan scan that throws a non-Error is reported verbatim, and nothing is deleted",
    () => {
      const db = migratedDb();
      try {
        // A vector with no embedding_chunk row: verifyIndex counts 1 vec row against 0 chunks.
        const v = new Float32Array(384);
        v[0] = 1;
        db.run("INSERT INTO vec_items_384(rowid, embedding) VALUES (7, vec_f32(?))", [v]);

        interceptQuery(db, (sql) => {
          if (sql.includes("SELECT v.rowid FROM vec_items_384")) throw "vec scan aborted";
        });
        const report = repairIndex(db, CURRENT_SCHEMA_VERSION);

        expect(report.outcomes).toEqual([
          { action: "vec_orphan_delete", status: "error", detail: "vec scan aborted" },
        ]);
        const left = db.query("SELECT COUNT(*) AS n FROM vec_items_384").get() as { n: number };
        expect(left.n).toBe(1);
      } finally {
        db.close();
      }
    },
  );
});
