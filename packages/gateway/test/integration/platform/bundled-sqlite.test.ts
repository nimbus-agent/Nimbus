import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { load as loadSqliteVec } from "sqlite-vec";

import { buildBundledSqlite, SQLITE_PIN } from "../../../../../scripts/build-sqlite-darwin.ts";
import { SQLITE_PATH_ENV } from "../../../src/platform/sqlite-runtime.ts";

/**
 * What the bundled macOS SQLite must actually be able to do.
 *
 * `build-sqlite-darwin.test.ts` proves the compile LINE is right on every platform. This proves the
 * resulting LIBRARY is right, which only macOS can answer — and it is the check that matters,
 * because `Database.setCustomSQLite()` repoints the whole process: a library that loads sqlite-vec
 * but has no FTS5 would give this repo vector search and take keyword search away, and every unit
 * test in the tree would still pass.
 *
 * IT DOES NOT SKIP ITSELF INTO VACUITY. On darwin, a missing library is a FAILURE with the command
 * that produces it, never a skip — CI's `setup-nimbus-ci` action builds it and exports
 * `NIMBUS_SQLITE_PATH`, so absence there means the wiring broke, which is exactly the thing worth
 * failing on. Off darwin the one assertion that still means something — that the builder refuses to
 * run at all — is asserted rather than skipped, so this file is never inert.
 */

const isDarwin = process.platform === "darwin";

describe("the bundled macOS SQLite", () => {
  test.skipIf(isDarwin)(
    "refuses to build off darwin rather than emitting something unusable",
    async () => {
      await expect(buildBundledSqlite("dist", "dist/.sqlite-build")).rejects.toThrow(/darwin only/);
    },
  );

  test.skipIf(!isDarwin)("is present where the build placed it", () => {
    // Deliberately not `skipIf(!exists)`: on macOS this file's whole premise is that the artifact
    // was built, so a missing one is a red test naming the fix, not a silent pass.
    const path = process.env[SQLITE_PATH_ENV] ?? "";
    if (path === "") {
      throw new Error(
        `${SQLITE_PATH_ENV} is unset on darwin — run ` +
          "`bun scripts/build-sqlite-darwin.ts --dest dist` and point it at the result",
      );
    }
    expect(existsSync(path)).toBe(true);
  });

  describe.skipIf(!isDarwin)("once installed into this process", () => {
    // The bunfig preload (`scripts/test-preload/hermetic-credentials.ts`) already called
    // `ensureFullSqlite()` before any test file loaded, so this process is ALREADY pointed at the
    // library under test. Re-installing here would be a no-op at best; asserting through a plain
    // `Database` is what proves the real, production install took.

    test("loads the sqlite-vec extension, which is the whole reason it is bundled", () => {
      const db = new Database(":memory:");
      try {
        loadSqliteVec(db);
        const stmt = db.query<{ v: string }, []>("SELECT vec_version() AS v");
        try {
          expect(String(stmt.get()?.v ?? "")).not.toBe("");
        } finally {
          stmt.finalize();
        }
      } finally {
        db.close();
      }
    });

    test("speaks FTS5, so bundling it does not cost keyword search", () => {
      const db = new Database(":memory:");
      try {
        db.run("CREATE VIRTUAL TABLE ft USING fts5(body)");
        db.run("INSERT INTO ft(body) VALUES ('the quick brown fox')");
        const stmt = db.query<{ n: number }, []>(
          "SELECT count(*) AS n FROM ft WHERE ft MATCH 'brown'",
        );
        try {
          expect(stmt.get()?.n).toBe(1);
        } finally {
          stmt.finalize();
        }
      } finally {
        db.close();
      }
    });

    test("has the JSON functions the index queries depend on", () => {
      const db = new Database(":memory:");
      try {
        const stmt = db.query<{ v: number }, []>(
          `SELECT json_extract('{"a":{"b":7}}', '$.a.b') AS v`,
        );
        try {
          expect(stmt.get()?.v).toBe(7);
        } finally {
          stmt.finalize();
        }
      } finally {
        db.close();
      }
    });

    test("is the pinned release, not whatever the host happened to have", () => {
      // The assertion that makes the three above mean something: without it they would pass just as
      // well against Apple's build for FTS5/JSON, and this file would be proving the host rather
      // than the artifact.
      const db = new Database(":memory:");
      try {
        const stmt = db.query<{ v: string }, []>("SELECT sqlite_version() AS v");
        try {
          expect(stmt.get()?.v).toBe(SQLITE_PIN.version);
        } finally {
          stmt.finalize();
        }
      } finally {
        db.close();
      }
    });
  });
});
