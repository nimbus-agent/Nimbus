import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { ResolvedDep } from "./dependency-types.ts";

export interface ForwardDep {
  readonly id: string;
  readonly range: string;
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
  for (const dep of deps) {
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
  const rows = db
    .query("SELECT depends_on_id AS id, range FROM extension_dependency WHERE extension_id = ?")
    .all(extensionId) as Array<{ id: string; range: string }>;
  return rows;
}

export function reverseDeps(db: Database, dependsOnId: string): readonly ReverseDep[] {
  const rows = db
    .query(
      "SELECT extension_id AS extensionId, range FROM extension_dependency WHERE depends_on_id = ?",
    )
    .all(dependsOnId) as Array<{ extensionId: string; range: string }>;
  return rows;
}
