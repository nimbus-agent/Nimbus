import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { runIndexedSchemaMigrations } from "../../src/index/migrations/runner.ts";

const SEED_CACHE = new Map<number, Uint8Array>();

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

export function seedDbFile(dbPath: string, version: number): void {
  writeFileSync(dbPath, migratedSeedBytes(version));
}

export function openSeededDbFile(dbPath: string, version: number): Database {
  seedDbFile(dbPath, version);
  return new Database(dbPath);
}

export function openSeededInMemoryDb(version: number): Database {
  return Database.deserialize(migratedSeedBytes(version));
}
