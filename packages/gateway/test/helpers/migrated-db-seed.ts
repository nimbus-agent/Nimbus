/**
 * Cached migrated-DB seed for tests that need a fully-migrated SQLite state
 * but don't exercise the migration runner itself.
 *
 * The previous shape — `new Database(path); runIndexedSchemaMigrations(db, N)`
 * in each test's `beforeEach`/`makeHarness` — ran ~N sequential write
 * transactions against on-disk SQLite **per test**. Multiplied across tens
 * of tests running in parallel on a loaded CI worker, that occasionally
 * exceeded bun's ~5 s hook/test timeout, surfacing as spurious failures
 * with no production-code change (the "calls fetch immediately on start",
 * "200 on first valid POST", "provider='local' builds a runtime", etc.
 * pattern).
 *
 * This helper migrates a single `:memory:` DB **once per (process, version)**
 * via `db.serialize()`, caches the resulting bytes, and exposes two ways to
 * consume them:
 *
 *   - `seedDbFile(path, version)` — writes the cached bytes to a real file.
 *     Use when the code-under-test opens the DB itself from a path (e.g.
 *     `startReadOnlyHttpServer(path, …)`).
 *   - `openSeededDbFile(path, version)` — same, then returns an open `Database`
 *     handle. Use when the test also needs to query the DB.
 *
 * Important: do **NOT** use this helper in `runner-v<N>.test.ts` files —
 * those legitimately exercise the migration sequence. Use it only when the
 * test treats the migrated schema as a fixture, not as the subject under test.
 *
 * Keeping the cache per-process (Map at module scope) means every test file
 * pays the migration cost at most once across its run, regardless of how
 * many `beforeEach` calls it makes.
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { runIndexedSchemaMigrations } from "../../src/index/migrations/runner.ts";

const SEED_CACHE = new Map<number, Uint8Array>();

/** Migrate-once-then-memoize. Returns the bytes of an in-memory DB at version N. */
export function migratedSeedBytes(version: number): Uint8Array {
  const cached = SEED_CACHE.get(version);
  if (cached !== undefined) {
    return cached;
  }
  const seed = new Database(":memory:");
  if (version > 0) {
    runIndexedSchemaMigrations(seed, version);
  }
  const bytes = seed.serialize();
  seed.close();
  SEED_CACHE.set(version, bytes);
  return bytes;
}

/** Writes the cached migrated bytes to `dbPath`. Caller opens the DB. */
export function seedDbFile(dbPath: string, version: number): void {
  writeFileSync(dbPath, migratedSeedBytes(version));
}

/** Writes the cached migrated bytes to `dbPath` and opens it. */
export function openSeededDbFile(dbPath: string, version: number): Database {
  seedDbFile(dbPath, version);
  return new Database(dbPath);
}

/**
 * Returns a fresh in-memory Database deserialized from the cached migrated
 * bytes. Use as a drop-in for the `new Database(":memory:"); runIndexed…`
 * pattern. Each call returns an independent handle.
 */
export function openSeededInMemoryDb(version: number): Database {
  // Bun's `Database.deserialize` copies the bytes into a new connection.
  return Database.deserialize(migratedSeedBytes(version));
}
