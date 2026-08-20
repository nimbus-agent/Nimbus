import type { Database } from "bun:sqlite";

export type SubstrateProbe = {
  readonly probeSql: string;
  readonly passed: boolean;
  readonly rowCount: number;
};

export type NegationGaps = {
  readonly excludedNoCoverage: number;
  readonly excludedTruncated: number;
};

/**
 * Re-exported so the CLI prints the REAL window rather than restating "2h" and drifting.
 *
 * `CORRELATION_WINDOW_MS` was module-PRIVATE in `graph/graph-populator.ts` — it is now
 * exported there for this re-export, rather than copying its value here, which would be
 * exactly the drift this re-export exists to prevent.
 */
export { CORRELATION_WINDOW_MS } from "../graph/graph-populator.ts";

function probe(db: Database, probeSql: string): SubstrateProbe {
  const row = db.query(probeSql).get() as { n?: number } | null;
  const rowCount = typeof row?.n === "number" ? row.n : 0;
  return { probeSql, passed: rowCount > 0, rowCount };
}

export function probePrFileCoverage(db: Database): SubstrateProbe {
  return probe(db, "SELECT COUNT(*) AS n FROM pr_files_state");
}

export function probeCorrelatesWith(db: Database): SubstrateProbe {
  return probe(db, "SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'correlates_with'");
}

export function probeReviewed(db: Database): SubstrateProbe {
  return probe(db, "SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'reviewed'");
}

/**
 * PRs with no indexed changed-file path matching `pathGlob`.
 *
 * Fail-closed by TWO independent mechanisms, and both must stay: the INNER JOIN to
 * `pr_files_state` (an uncovered PR has no row to join), and `s.truncated = 0` (on an uncovered
 * PR that column is NULL, and `NULL = 0` is NULL, which WHERE treats as not-true). Either alone
 * excludes an unfetched PR, so swapping the JOIN for a LEFT JOIN does NOT by itself reintroduce
 * the bug — it takes losing both, e.g. a LEFT JOIN plus `COALESCE(s.truncated, 0) = 0`.
 *
 * GLOB, never LIKE: LIKE is case-insensitive and treats `_` as a wildcard, both measured, both
 * wrong for paths.
 */
export function buildNotTouchingSql(pathGlob: string): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT i.id AS id
            FROM item i
            JOIN pr_files_state s ON s.item_id = i.id
           WHERE i.type = 'pr'
             AND s.truncated = 0
             AND NOT EXISTS (
                   SELECT 1 FROM pr_changed_file f
                    WHERE f.item_id = i.id AND f.path GLOB ?1
                 )
           ORDER BY i.id`,
    vals: [pathGlob],
  };
}

/**
 * Deployments with no outgoing `correlates_with` edge.
 *
 * The bridge is required: `syncTimelineEventGraph` (`graph/graph-populator.ts:854`) upserts the
 * deployment's graph entity as `{ type: "deployment", externalId: row.id }`, so the item's id is
 * the entity's EXTERNAL id, never its primary key. Joining `graph_relation.from_id = item.id`
 * would match nothing and silently return every deployment as "clean" — the exact false positive
 * this feature exists to prevent.
 *
 * No time filter, deliberately: `CORRELATION_WINDOW_MS` is applied at WRITE time by the populator
 * and `graph_relation.created_at` is the write timestamp, not the event time. See spec § 4.2.
 */
export function buildNoDownstreamIncidentSql(): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT i.id AS id
            FROM item i
            JOIN graph_entity e ON e.external_id = i.id AND e.type = 'deployment'
           WHERE i.type = 'deployment'
             AND NOT EXISTS (
                   SELECT 1 FROM graph_relation r
                    WHERE r.from_id = e.id AND r.type = 'correlates_with'
                 )
           ORDER BY i.id`,
    vals: [],
  };
}

/**
 * People with no outgoing `reviewed` edge newer than `sinceMs`.
 *
 * Same bridge: `graph-populator.ts:341-349` upserts the person entity as
 * `{ type: "person", externalId: row.authorId }` and emits `reviewed` FROM it, and `row.authorId`
 * is the `person.id`. Unlike the deployment predicate this one DOES filter on `created_at`,
 * because `--since` is meant to bound the review window and that is the timestamp available.
 *
 * BOUND (verified, not assumed): `graph_relation.created_at` is a WRITE timestamp, not an event
 * timestamp. `upsertGraphRelation`'s `ON CONFLICT (from_id, to_id, type) DO UPDATE SET
 * created_at = excluded.created_at` (`graph/relationship-graph.ts`) means a `reviewed` edge's
 * `created_at` moves forward on every re-emit. `regraphAllItems` (`graph/regraph.ts`) never
 * clears existing `reviewed` edges but DOES re-run `syncGraphFromIndexedItem` over every `review`
 * item with `now = Date.now()` at regraph time — so a full regraph rewrites `created_at` for
 * every already-known review to "now", not the original review time. `--since` on this predicate
 * therefore means "no reviewed edge WRITTEN in the window", which can drift arbitrarily far from
 * "no review performed in the window" after any regraph pass.
 */
export function buildNotReviewedSql(sinceMs: number): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT p.id AS id
            FROM person p
            JOIN graph_entity e ON e.external_id = p.id AND e.type = 'person'
           WHERE NOT EXISTS (
                   SELECT 1 FROM graph_relation r
                    WHERE r.from_id = e.id
                      AND r.type = 'reviewed'
                      AND r.created_at >= ?1
                 )
           ORDER BY p.id`,
    vals: [sinceMs],
  };
}

/**
 * The two `buildNotTouchingSql` exclusion counts, reported SEPARATELY: a PR the index never
 * fetched a file list for, and a PR whose file list is known-incomplete. They mean different
 * things to a reader — the first is "we never checked", the second is "we checked partially" —
 * and summing them would erase that distinction.
 */
export function countNotTouchingExclusions(db: Database): NegationGaps {
  const noCoverage = db
    .query(
      `SELECT COUNT(*) AS n
         FROM item i
         LEFT JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr' AND s.item_id IS NULL`,
    )
    .get() as { n: number };
  const truncated = db
    .query(
      `SELECT COUNT(*) AS n
         FROM item i
         JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr' AND s.truncated = 1`,
    )
    .get() as { n: number };
  return { excludedNoCoverage: noCoverage.n, excludedTruncated: truncated.n };
}
