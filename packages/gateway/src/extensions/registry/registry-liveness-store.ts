import type { Database } from "bun:sqlite";
import { dbRun } from "../../db/write.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";

/** The schema version that introduced `registry_liveness_state`. */
export const LIVENESS_SCHEMA_VERSION = 80;

/**
 * Advances a registry's liveness floor, conditional like the trust-feed floor: a higher sequence, or
 * the same sequence with the same document. A different liveness key replaces the floor (the
 * registry rotated the key its index names). Callers check the schema version first.
 */
export function recordLivenessAccepted(
  db: Database,
  registry: string,
  f: {
    livenessKey: string;
    sequence: number;
    documentSha256: string;
    generatedAt: string;
    now: number;
  },
): "accepted" | "rollback" | "equivocation" {
  const r = dbRun(
    db,
    `INSERT INTO registry_liveness_state (registry, liveness_key, last_sequence, last_document_sha256, last_generated_at, last_fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(registry) DO UPDATE SET
       liveness_key = excluded.liveness_key,
       last_sequence = excluded.last_sequence,
       last_document_sha256 = excluded.last_document_sha256,
       last_generated_at = excluded.last_generated_at,
       last_fetched_at = excluded.last_fetched_at
     WHERE registry_liveness_state.liveness_key <> excluded.liveness_key
        OR registry_liveness_state.last_sequence < excluded.last_sequence
        OR (registry_liveness_state.last_sequence = excluded.last_sequence
            AND registry_liveness_state.last_document_sha256 = excluded.last_document_sha256)`,
    [registry, f.livenessKey, f.sequence, f.documentSha256, f.generatedAt, f.now],
  );
  if (r.changes > 0) return "accepted";
  const cur = db
    .query("SELECT last_sequence AS s FROM registry_liveness_state WHERE registry = ?")
    .get(registry) as { s: number } | null;
  return cur !== null && cur.s === f.sequence ? "equivocation" : "rollback";
}

/** Forgets a registry's floor. A no-op below V80, where the table does not exist. */
export function deleteLivenessFloor(db: Database, registry: string): void {
  if (readIndexedUserVersion(db) < LIVENESS_SCHEMA_VERSION) return;
  dbRun(db, "DELETE FROM registry_liveness_state WHERE registry = ?", [registry]);
}
