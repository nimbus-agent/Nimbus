import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";

/**
 * "My open work" snapshots (V91, Phase 10 MB1). The ONLY writer of `work_snapshot` (static D24 rule
 * `work-snapshot-confined`); a syncable reaches it through the `replaceWorkSnapshot` capability, which
 * binds the service. Reads are unrestricted.
 */
export const WORK_SNAPSHOT_SERVICES = ["jira", "linear", "github"] as const;
export type WorkSnapshotService = (typeof WORK_SNAPSHOT_SERVICES)[number];

export const WORK_SNAPSHOT_RELATIONS = ["assigned", "review_requested", "authored_open"] as const;
export type WorkSnapshotRelation = (typeof WORK_SNAPSHOT_RELATIONS)[number];

/** A bug guard far above every provider cap (3 pages of 100 at most). */
export const WORK_SNAPSHOT_MAX_IDS = 1000;

export function isWorkSnapshotService(service: string): service is WorkSnapshotService {
  return (WORK_SNAPSHOT_SERVICES as readonly string[]).includes(service);
}

/**
 * Replaces the (service, relation) snapshot with the items whose `external_id` is in `externalIds`,
 * in ONE transaction. An id with no `item` row is dropped (counted), never stored.
 */
export function replaceWorkSnapshotRows(
  db: Database,
  service: string,
  relation: WorkSnapshotRelation,
  externalIds: readonly string[],
  nowMs: number,
): { stored: number; dropped: number } {
  if (!isWorkSnapshotService(service)) {
    throw new Error(`work snapshots are not kept for service "${service}"`);
  }
  if (!(WORK_SNAPSHOT_RELATIONS as readonly string[]).includes(relation)) {
    throw new Error(`unknown work snapshot relation "${String(relation)}"`);
  }
  if (externalIds.length > WORK_SNAPSHOT_MAX_IDS) {
    throw new Error(`a work snapshot holds at most ${String(WORK_SNAPSHOT_MAX_IDS)} items`);
  }
  const unique = [...new Set(externalIds)];
  const resolve = db.query("SELECT id FROM item WHERE service = ? AND external_id = ?");
  try {
    return db.transaction(() => {
      dbRun(db, "DELETE FROM work_snapshot WHERE service = ? AND relation = ?", [service, relation]);
      let stored = 0;
      for (const ext of unique) {
        const row = resolve.get(service, ext) as { id: string } | null;
        if (row === null) continue;
        dbRun(
          db,
          "INSERT INTO work_snapshot (service, relation, item_id, captured_at) VALUES (?, ?, ?, ?)",
          [service, relation, row.id, nowMs],
        );
        stored += 1;
      }
      return { stored, dropped: unique.length - stored };
    })();
  } finally {
    resolve.finalize();
  }
}

export interface WorkSnapshotMember {
  readonly itemId: string;
  readonly capturedAt: number;
}

export function listWorkSnapshot(
  db: Database,
  service: string,
  relation: WorkSnapshotRelation,
): WorkSnapshotMember[] {
  const rows = db
    .query(
      "SELECT item_id, captured_at FROM work_snapshot WHERE service = ? AND relation = ? ORDER BY item_id",
    )
    .all(service, relation) as Array<{ item_id: string; captured_at: number }>;
  return rows.map((r) => ({ itemId: r.item_id, capturedAt: r.captured_at }));
}
