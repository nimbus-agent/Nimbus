import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndex } from "./local-index.ts";
import {
  cleanupMigratedDbTemplate,
  materializeMigratedDb,
  openMigratedDb,
  openMigratedMemoryDb,
} from "./migrated-db-template.ts";

const roots: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "migrated-tpl-test-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  cleanupMigratedDbTemplate();
});

/** Every object SQLite reports, name + type + normalized DDL, as a comparable snapshot. */
function schemaSnapshot(db: Database): string {
  const rows = db
    .query("SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master ORDER BY type, name")
    .all() as { type: string; name: string; sql: string }[];
  return rows.map((r) => `${r.type}\t${r.name}\t${r.sql.replace(/\s+/g, " ").trim()}`).join("\n");
}

/**
 * The load-bearing assertion for this module. If a copied template ever stops matching what
 * `LocalIndex.ensureSchema` builds, every harness that switched to the copy is silently testing
 * against a different schema than production migrates to — so this compares the FULL
 * `sqlite_master` contents, not just the user_version, which would pass on a missing table.
 */
test("a copied template is schema-identical to a freshly migrated database", () => {
  const fresh = new Database(join(freshDir(), "fresh.db"));
  LocalIndex.ensureSchema(fresh);

  const copied = openMigratedDb(join(freshDir(), "copied.db"));

  expect(schemaSnapshot(copied)).toBe(schemaSnapshot(fresh));
  expect((copied.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
    (fresh.query("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  expect((copied.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
    LocalIndex.SCHEMA_VERSION,
  );

  fresh.close();
  copied.close();
});

/**
 * The in-memory path is a second reader of the same template, so it gets the same proof. A
 * `deserialize` that silently produced an empty or older database would otherwise look fine —
 * the tests using it construct their own rows anyway.
 */
test("an in-memory database from the template is schema-identical to a migrated one", () => {
  const fresh = new Database(":memory:");
  LocalIndex.ensureSchema(fresh);

  const mem = openMigratedMemoryDb();

  expect(schemaSnapshot(mem)).toBe(schemaSnapshot(fresh));
  expect((mem.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
    LocalIndex.SCHEMA_VERSION,
  );
  expect((mem.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);

  fresh.close();
  mem.close();
});

test("two in-memory databases from the template are independent", () => {
  const a = openMigratedMemoryDb();
  const b = openMigratedMemoryDb();

  a.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('only-in-a', 'github', 'pr', 'x', 'x', 0, 0)`,
  );

  expect((a.query("SELECT COUNT(*) AS n FROM item").get() as { n: number }).n).toBe(1);
  expect((b.query("SELECT COUNT(*) AS n FROM item").get() as { n: number }).n).toBe(0);

  a.close();
  b.close();
});

/**
 * Cleanup must be re-entrant AND non-destructive to the run that continues after it. The second
 * call has nothing to remove and must not throw; the call after that must still hand back a
 * usable database, because the template is rebuilt lazily rather than assumed to exist. Without
 * that property, `cleanupMigratedDbTemplate` firing early (it is registered on `exit`, and a
 * test file may call it in an `afterAll`) would break every later caller in the same process.
 */
test("cleanup is re-entrant, and the template rebuilds itself afterwards", () => {
  openMigratedDb(join(freshDir(), "before-cleanup.db")).close();

  cleanupMigratedDbTemplate();
  expect(() => cleanupMigratedDbTemplate()).not.toThrow();

  const after = openMigratedDb(join(freshDir(), "after-cleanup.db"));
  expect((after.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
    LocalIndex.SCHEMA_VERSION,
  );
  after.close();
});

test("openMigratedDb enables foreign keys, as ensureSchema does", () => {
  const db = openMigratedDb(join(freshDir(), "fk.db"));
  expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
  db.close();
});

/**
 * The isolation property the per-test `ensureSchema` pattern was buying. Sharing the template
 * must not become sharing the database — a row written through one handle must be invisible to
 * another caller's, or the speedup would have traded away the thing the tests rely on.
 */
test("two databases from the same template are independent files", () => {
  const a = openMigratedDb(join(freshDir(), "a.db"));
  const b = openMigratedDb(join(freshDir(), "b.db"));

  a.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('only-in-a', 'github', 'pr', 'x', 'x', 0, 0)`,
  );

  expect((a.query("SELECT COUNT(*) AS n FROM item").get() as { n: number }).n).toBe(1);
  expect((b.query("SELECT COUNT(*) AS n FROM item").get() as { n: number }).n).toBe(0);

  a.close();
  b.close();
});

/**
 * `materializeMigratedDb` exists for harnesses that migrate a path and then let something else
 * open it. If the copy left a handle open, or left WAL content stranded in a sidecar the copy
 * did not carry, a second connection would see an unmigrated or partially-migrated file.
 */
test("materializeMigratedDb leaves a complete file no handle is holding", () => {
  const path = join(freshDir(), "handed-off.db");
  materializeMigratedDb(path);

  const reopened = new Database(path, { create: false, readwrite: true });
  expect(
    (reopened.query("PRAGMA user_version").get() as { user_version: number }).user_version,
  ).toBe(LocalIndex.SCHEMA_VERSION);
  expect(
    (
      reopened.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'item'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
  reopened.close();
});
