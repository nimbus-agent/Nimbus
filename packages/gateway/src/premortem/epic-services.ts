import type { Database } from "bun:sqlite";

/**
 * The AFFECTED services an epic touched — `billing-api`, not `jira`.
 *
 * This is the single definition of "service" for pre-mortem. The theme pass
 * writes themes under these values and PR B's cohort lanes read them back, so
 * a second, divergent definition anywhere would leave every theme lookup
 * matching zero rows while both halves looked individually correct.
 *
 * Traversal: epic → children (`metadata.parent_key`, #1128, scoped to the
 * epic's own `item.service` so two trackers can never collide on a bare key
 * like `PROJ-1`) → each child's `graph_entity` row (`type = 'issue'`,
 * `external_id = item.id` — `graph_entity.id` is a deterministic
 * `sha256(type + "\0" + externalId)` hash, NOT the item id, so this hop must
 * go through `graph_entity`, mirroring the `type` + `external_id` lookup
 * precedent in `agents/impact.ts`'s `resolveStartEntity`) → that entity's
 * INCOMING `resolves` edges (the graph stores `PR --resolves--> issue`) → the
 * PR ENTITY's `metadata.repo`, e.g. `acme/billing-api`.
 *
 * The `type` string `'issue'` is confirmed against `graph-populator.ts`:
 * `syncGraphFromIndexedItem` dispatches on `row.type === "issue"` into
 * `syncIssueGraph`, which writes `upsertGraphEntity({ type: "issue",
 * externalId: row.id, ... })` — the same for Jira and Linear rows, since the
 * dispatch key is the indexed item's `type`, not its `service`.
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
         JOIN graph_entity   child_ent ON child_ent.type = 'issue'
                                       AND child_ent.external_id = child.id
         JOIN graph_relation res       ON res.to_id = child_ent.id AND res.type = 'resolves'
         JOIN graph_entity   pr        ON pr.id     = res.from_id
        WHERE json_extract(child.metadata, '$.parent_key') = ?
          AND child.id <> ?
          AND child.service = (SELECT service FROM item WHERE id = ?)
          AND json_extract(pr.metadata, '$.repo') IS NOT NULL
        ORDER BY service ASC`,
    )
    .all(epicKey, epicItemId, epicItemId) as Array<{ service: string }>;
  return rows.map((r) => r.service);
}

/**
 * The batch form of `affectedServicesForEpic`, for a whole discover batch at
 * once. `premortem-pass.ts` used to call the single-epic form once per epic —
 * up to `DEFAULT_BATCH_SIZE` full scans of `item` per pass batch, back to
 * back with no `await` between them, on a job whose entire justification is
 * that it must not degrade the interactive gateway (there is no expression
 * index on `json_extract(metadata, '$.parent_key')` anywhere in this repo).
 * This collapses that to ONE query.
 *
 * Joins `item` to itself (`epic` / `child`) rather than taking `epicKey`
 * per-call: `child.service = epic.service` and
 * `json_extract(child.metadata, '$.parent_key') = epic.external_id` reproduce
 * the single-epic query's own-service scoping and parent-key match without a
 * second round-trip to look either up. Bound params only (I9): the `IN (...)`
 * placeholder count is built from the input length, never interpolated
 * values.
 *
 * Returns a `Map` so a caller can distinguish "resolved, zero services" from
 * "not in the input at all" — though today every epic that was queried gets
 * an (possibly empty) entry only when it produced at least one row; callers
 * fall back to `[]` via `?? []`, matching the single-epic function's return
 * shape for an unresolved epic.
 */
export function affectedServicesForEpics(
  db: Database,
  epicItemIds: readonly string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (epicItemIds.length === 0) {
    return result;
  }
  const placeholders = epicItemIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT epic.id AS epicItemId, json_extract(pr.metadata, '$.repo') AS service
         FROM item epic
         JOIN item child             ON json_extract(child.metadata, '$.parent_key') = epic.external_id
                                      AND child.service = epic.service
                                      AND child.id <> epic.id
         JOIN graph_entity   child_ent ON child_ent.type = 'issue'
                                       AND child_ent.external_id = child.id
         JOIN graph_relation res       ON res.to_id = child_ent.id AND res.type = 'resolves'
         JOIN graph_entity   pr        ON pr.id     = res.from_id
        WHERE epic.id IN (${placeholders})
          AND json_extract(pr.metadata, '$.repo') IS NOT NULL
        ORDER BY epic.id ASC, service ASC`,
    )
    .all(...epicItemIds) as Array<{ epicItemId: string; service: string }>;
  for (const r of rows) {
    const services = result.get(r.epicItemId) ?? [];
    // DISTINCT per epic: rows arrive service-sorted, so a plain de-dupe
    // preserves the same sorted order the single-epic function returns.
    if (services[services.length - 1] !== r.service) {
      services.push(r.service);
    }
    result.set(r.epicItemId, services);
  }
  return result;
}
