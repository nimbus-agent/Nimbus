import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import type { ResolvedDep } from "./dependency-types.ts";

/** V78 added `extension_dependency.depends_on_registry`. */
const REGISTRY_EDGE_SCHEMA_VERSION = 78;

export interface ForwardDep {
  readonly id: string;
  readonly range: string;
  readonly registry: string | null;
}

export interface ReverseDep {
  readonly extensionId: string;
  readonly range: string;
}

export function recordInstall(
  db: Database,
  extensionId: string,
  _version: string,
  deps: readonly ResolvedDep[],
  now: number,
): void {
  dbRun(db, "DELETE FROM extension_dependency WHERE extension_id = ?", [extensionId]);
  const withRegistry = readIndexedUserVersion(db) >= REGISTRY_EDGE_SCHEMA_VERSION;
  for (const dep of deps) {
    if (withRegistry) {
      dbRun(
        db,
        `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at, depends_on_registry)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(extension_id, depends_on_id) DO UPDATE SET range = excluded.range, created_at = excluded.created_at, depends_on_registry = excluded.depends_on_registry`,
        [extensionId, dep.id, dep.range, now, dep.registry],
      );
      continue;
    }
    dbRun(
      db,
      `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(extension_id, depends_on_id) DO UPDATE SET range = excluded.range, created_at = excluded.created_at`,
      [extensionId, dep.id, dep.range, now],
    );
  }
}

export function clearDeps(db: Database, extensionId: string): void {
  dbRun(db, "DELETE FROM extension_dependency WHERE extension_id = ?", [extensionId]);
}

export function forwardDeps(db: Database, extensionId: string): readonly ForwardDep[] {
  const registryColumn =
    readIndexedUserVersion(db) >= REGISTRY_EDGE_SCHEMA_VERSION ? "depends_on_registry" : "NULL";
  return db
    .query(
      `SELECT depends_on_id AS id, range, ${registryColumn} AS registry FROM extension_dependency WHERE extension_id = ?`,
    )
    .all(extensionId) as ForwardDep[];
}

export function reverseDeps(db: Database, dependsOnId: string): readonly ReverseDep[] {
  const rows = db
    .query(
      "SELECT extension_id AS extensionId, range FROM extension_dependency WHERE depends_on_id = ?",
    )
    .all(dependsOnId) as Array<{ extensionId: string; range: string }>;
  return rows;
}
