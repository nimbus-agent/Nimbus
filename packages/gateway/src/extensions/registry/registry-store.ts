import type { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import type { RegistryChannel } from "./index-format.ts";
import { RegistryError } from "./registry-errors.ts";

export interface RegistryRow {
  name: string;
  url: string;
  rootKey: string;
  rootFingerprint: string;
  lastSequence: number;
  lastGeneratedAt: string;
  addedAt: number;
  lastFetchedAt: number | null;
}

export interface ExtensionSource {
  registry: string;
  rootFingerprint: string;
  channel: RegistryChannel;
}

type RegistryDbRow = {
  name: string;
  url: string;
  root_key: string;
  root_fingerprint: string;
  last_sequence: number;
  last_generated_at: string;
  added_at: number;
  last_fetched_at: number | null;
};

const COLUMNS =
  "name, url, root_key, root_fingerprint, last_sequence, last_generated_at, added_at, last_fetched_at";

function toRow(r: RegistryDbRow): RegistryRow {
  return {
    name: r.name,
    url: r.url,
    rootKey: r.root_key,
    rootFingerprint: r.root_fingerprint,
    lastSequence: r.last_sequence,
    lastGeneratedAt: r.last_generated_at,
    addedAt: r.added_at,
    lastFetchedAt: r.last_fetched_at,
  };
}

export function listRegistries(db: Database): RegistryRow[] {
  return (
    db.query(`SELECT ${COLUMNS} FROM extension_registry ORDER BY name`).all() as RegistryDbRow[]
  ).map(toRow);
}

export function getRegistry(db: Database, name: string): RegistryRow | undefined {
  const r = db
    .query(`SELECT ${COLUMNS} FROM extension_registry WHERE name = ?`)
    .get(name) as RegistryDbRow | null;
  return r === null ? undefined : toRow(r);
}

export function insertRegistry(db: Database, row: Omit<RegistryRow, "lastFetchedAt">): void {
  const clash = db
    .query("SELECT name, url FROM extension_registry WHERE name = ? OR url = ?")
    .get(row.name, row.url) as { name: string; url: string } | null;
  if (clash !== null) {
    throw new RegistryError(
      "ERR_REGISTRY_EXISTS",
      clash.name === row.name
        ? `a registry named "${row.name}" is already added`
        : `the registry at ${row.url} is already added as "${clash.name}"`,
    );
  }
  dbRun(db, `INSERT INTO extension_registry (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, [
    row.name,
    row.url,
    row.rootKey,
    row.rootFingerprint,
    row.lastSequence,
    row.lastGeneratedAt,
    row.addedAt,
  ]);
}

/**
 * Advances the anti-rollback floor. Conditional on the row still carrying the pinned key and a
 * floor no higher than `sequence`, so an overlapping fetch holding a stale snapshot cannot lower
 * it. Returns whether the row changed.
 */
export function recordRegistryFetch(
  db: Database,
  name: string,
  rootKey: string,
  sequence: number,
  generatedAt: string,
  now: number,
): boolean {
  const r = dbRun(
    db,
    "UPDATE extension_registry SET last_sequence = ?, last_generated_at = ?, last_fetched_at = ? WHERE name = ? AND root_key = ? AND last_sequence <= ?",
    [sequence, generatedAt, now, name, rootKey, sequence],
  );
  return r.changes > 0;
}

/** Deletes the registry row only; installed extensions keep their source columns (provenance). */
export function deleteRegistry(db: Database, name: string): boolean {
  const r = dbRun(db, "DELETE FROM extension_registry WHERE name = ?", [name]);
  return r.changes > 0;
}

export function setExtensionSource(db: Database, id: string, src: ExtensionSource): void {
  dbRun(
    db,
    "UPDATE extension SET source_registry = ?, source_root_fingerprint = ?, source_channel = ? WHERE id = ?",
    [src.registry, src.rootFingerprint, src.channel, id],
  );
}

/** Ids of installed extensions whose recorded source is the named registry (remove's orphans). */
export function listExtensionIdsFromRegistry(db: Database, registry: string): string[] {
  if (readIndexedUserVersion(db) < 71) {
    return [];
  }
  return (
    db
      .query("SELECT id FROM extension WHERE source_registry = ? ORDER BY id")
      .all(registry) as Array<{ id: string }>
  ).map((r) => r.id);
}

export function getExtensionSource(db: Database, id: string): ExtensionSource | undefined {
  if (readIndexedUserVersion(db) < 71) {
    return undefined;
  }
  const r = db
    .query(
      "SELECT source_registry, source_root_fingerprint, source_channel FROM extension WHERE id = ?",
    )
    .get(id) as {
    source_registry: string | null;
    source_root_fingerprint: string | null;
    source_channel: RegistryChannel | null;
  } | null;
  if (
    r === null ||
    r.source_registry === null ||
    r.source_root_fingerprint === null ||
    r.source_channel === null
  ) {
    return undefined;
  }
  return {
    registry: r.source_registry,
    rootFingerprint: r.source_root_fingerprint,
    channel: r.source_channel,
  };
}
