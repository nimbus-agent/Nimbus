import type { Database } from "bun:sqlite";

import type { NegotiateAuthoredPrs, NegotiateReviewedPrs } from "../negotiate-types.ts";
import { evidenceRefsFor, NEGOTIATE_EVIDENCE_LIMIT } from "./evidence.ts";

/**
 * A PR row's `item.metadata` as a plain object, or `undefined` when the JSON will not parse.
 *
 * `undefined` and `{}` are deliberately different answers: unparseable JSON drops the row
 * from every tally (the caller `continue`s), while JSON that parses to a non-object — a
 * number, an array, `null` — yields `{}`, so the row is still walked and simply contributes
 * nothing. That is the behaviour of the inline `try`/`catch` this replaces; it was extracted
 * only to bring the caller back under the cognitive-complexity gate (Sonar S3776).
 */
function parsePrMetadata(json: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * `person --authored--> pr` (graph_relation) joined back to `item` for the PR's metadata.
 * PR size stats (`additions`/`deletions`/`changed_files`) live in that metadata only where
 * the enrichment pass has run, hence `statsCoverage`: an aggregate over a partial subset
 * must disclose its own denominator rather than be printed as if it covered everything.
 */
/**
 * Fold one person's authored-PR metadata rows into the five counters
 * {@link laneAuthoredPrs} reports. Lifted out of that function to bring it back under the
 * cognitive-complexity gate (Sonar `S3776`) — the loop and its five guards were the whole
 * of its score.
 *
 * Unparseable metadata contributes to neither the merged count nor either coverage tally — but
 * it DOES stay in `count`/`statsCoverage.total`/`mergedCoverage.total` at the call site, because
 * the PR itself is real evidence and dropping it would understate the headline number; an
 * unparseable row therefore visibly widens both gaps. `mergedCoverage.covered` counts rows whose
 * `merged` is a boolean: a writer omits `merged` when the PR state is unknown (index lane
 * contract), and "unknown" must not read as "not merged".
 */
// lane-census: scope=pr
function accumulateAuthoredPrStats(rows: ReadonlyArray<{ metadata: string }>): {
  merged: number;
  mergedKnown: number;
  covered: number;
  additions: number;
  deletions: number;
  changedFiles: number;
} {
  let merged = 0;
  let mergedKnown = 0;
  let covered = 0;
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const row of rows) {
    const meta = parsePrMetadata(row.metadata);
    // Unparseable JSON drops the row from both tallies, per the note above.
    if (meta === undefined) continue;
    const m = meta["merged"];
    if (typeof m === "boolean") mergedKnown += 1;
    if (m === true) merged += 1;
    const a = meta["additions"];
    // `additions` is the coverage key: a row without it counts toward neither `covered` nor
    // any of the three sums, exactly as when the whole block was nested under `typeof a`.
    if (typeof a !== "number") continue;
    covered += 1;
    additions += a;
    const d = meta["deletions"];
    if (typeof d === "number") deletions += d;
    const c = meta["changed_files"];
    if (typeof c === "number") changedFiles += c;
  }
  return { merged, mergedKnown, covered, additions, deletions, changedFiles };
}

export function laneAuthoredPrs(
  db: Database,
  personId: string,
  sinceMs: number,
): NegotiateAuthoredPrs {
  const cutoff = Date.now() - sinceMs;
  const rows = db
    .query(
      `SELECT i.metadata AS metadata
         FROM graph_relation r
         JOIN graph_entity pe  ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity pre ON pre.id = r.to_id  AND pre.type = 'pr'
         JOIN item i           ON i.id = pre.external_id
        WHERE r.type = 'authored' AND pe.external_id = ? AND i.modified_at >= ?`,
    )
    .all(personId, cutoff) as Array<{ metadata: string }>;

  const { merged, mergedKnown, covered, additions, deletions, changedFiles } =
    accumulateAuthoredPrStats(rows);

  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM graph_relation r
       JOIN graph_entity pe  ON pe.id = r.from_id AND pe.type = 'person'
       JOIN graph_entity pre ON pre.id = r.to_id  AND pre.type = 'pr'
       JOIN item i           ON i.id = pre.external_id
      WHERE r.type = 'authored' AND pe.external_id = ? AND i.modified_at >= ?
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, NEGOTIATE_EVIDENCE_LIMIT],
  );
  return {
    count: rows.length,
    merged,
    mergedCoverage: { covered: mergedKnown, total: rows.length },
    evidence: { refs, total: rows.length },
    stats: covered === 0 ? null : { additions, deletions, changedFiles },
    statsCoverage: { covered, total: rows.length },
  };
}

/**
 * Queries `item` directly (not the graph): a `review` item's `metadata.state` is nullable
 * (GitHub can omit it), and every review must be counted somewhere — `otherOrUnknown` catches
 * `commented`, `dismissed`, and the null case, never silently dropping a row.
 *
 * The `json_valid` guard is required, not decorative: `json_extract` raises on unparseable
 * JSON, and one bad row kills the whole query rather than just itself (measured on bun
 * 1.3.14 / SQLite 3.53.0). It sits in the PROJECTION, inside a short-circuiting `CASE`, and
 * NOT in the WHERE clause. As a WHERE predicate it silently DROPPED every row whose metadata
 * is NULL or corrupt — removing them from `count` as well as from `otherOrUnknown`, which
 * contradicts the "every review is counted somewhere" rule above and disagreed with
 * `laneAuthoredPrs`, which deliberately keeps such rows in its headline count. Measured on a
 * 4-row fixture (valid / NULL / corrupt / no-state): the WHERE form returned 2 rows, the
 * `CASE` form returns all 4 with the two unreadable ones landing in `otherOrUnknown`.
 * Do not "simplify" this back into the WHERE clause.
 *
 * No `item(author_id)` index: `item` narrows hard first on `service`/`type` before this
 * unindexed filter runs, which is deliberate for a personal index — see spec § 4/Task 2 brief.
 */
export function laneReviewedPrs(
  db: Database,
  personId: string,
  sinceMs: number,
): NegotiateReviewedPrs {
  const cutoff = Date.now() - sinceMs;
  const rows = db
    .query(
      `SELECT CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.state') END AS state
         FROM item i
        WHERE i.service = 'github'
          AND i.type = 'review'
          AND i.author_id = ?
          AND i.modified_at >= ?`,
    )
    .all(personId, cutoff) as Array<{ state: string | null }>;

  let approved = 0;
  let changesRequested = 0;
  let otherOrUnknown = 0;
  for (const r of rows) {
    if (r.state === "approved") approved += 1;
    else if (r.state === "changes_requested") changesRequested += 1;
    else otherOrUnknown += 1;
  }
  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM item i
      WHERE i.service = 'github'
        AND i.type = 'review'
        AND i.author_id = ?
        AND i.modified_at >= ?
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, NEGOTIATE_EVIDENCE_LIMIT],
  );
  return {
    count: rows.length,
    approved,
    changesRequested,
    otherOrUnknown,
    evidence: { refs, total: rows.length },
  };
}
