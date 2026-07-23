import type { Database } from "bun:sqlite";

/**
 * Shared graph walks used by more than one built-in agent. Extracted from
 * `impact.ts` (`subDownstreamCode`) when `why.ts` needed the same reverse
 * `depends_on` traversal — a sixth copy of a graph walk is not acceptable
 * under the repo's duplication floor.
 */
export type ReverseDependsOnRow = { entityId: string; label: string; serviceId: string };

/** Entities that declare `depends_on` → the given entity (reverse edge walk). */
export function reverseDependsOn(
  db: Database,
  toEntityId: string,
  limit = 50,
): ReverseDependsOnRow[] {
  const rows = db
    .query(
      `SELECT
         e.id    AS entity_id,
         e.label AS label,
         COALESCE(e.service, 'filesystem') AS service_id
       FROM graph_relation r
       JOIN graph_entity   e ON e.id = r.from_id
       WHERE r.to_id = ? AND r.type = 'depends_on'
       LIMIT ?`,
    )
    .all(toEntityId, limit) as Array<{ entity_id: string; label: string; service_id: string }>;
  return rows.map((r) => ({ entityId: r.entity_id, label: r.label, serviceId: r.service_id }));
}
