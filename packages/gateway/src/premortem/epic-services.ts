import type { Database } from "bun:sqlite";

/**
 * The AFFECTED services an epic touched — `billing-api`, not `jira`.
 *
 * This is the single definition of "service" for pre-mortem. The theme pass
 * writes themes under these values and PR B's cohort lanes read them back, so
 * a second, divergent definition anywhere would leave every theme lookup
 * matching zero rows while both halves looked individually correct.
 *
 * Traversal: epic → children (`metadata.parent_key`, #1128) → each child's
 * INCOMING `resolves` edges (the graph stores `PR --resolves--> issue`) → the
 * PR ENTITY's `metadata.repo`, e.g. `acme/billing-api`.
 *
 * The last hop is a JSON field, NOT an `in_repo` edge: `graph-populator.ts`
 * writes `in_repo` only for commits and files (pointing at a workspace), never
 * for pull requests, so an edge traversal would return [] on every real index
 * while passing any test that seeded its own edges.
 *
 * Returns `[]` rather than guessing when any hop is missing. A brand-new epic
 * legitimately has no children, and PR B turns the empty result into a named
 * gap plus the `--service` prompt — never into a silently weaker cohort.
 */
export function affectedServicesForEpic(
  db: Database,
  epicItemId: string,
  epicKey: string,
): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT json_extract(pr.metadata, '$.repo') AS service
         FROM item child
         JOIN graph_relation res ON res.to_id = child.id AND res.type = 'resolves'
         JOIN graph_entity   pr  ON pr.id     = res.from_id
        WHERE json_extract(child.metadata, '$.parent_key') = ?
          AND child.id <> ?
          AND json_extract(pr.metadata, '$.repo') IS NOT NULL
        ORDER BY service ASC`,
    )
    .all(epicKey, epicItemId) as Array<{ service: string }>;
  return rows.map((r) => r.service);
}
