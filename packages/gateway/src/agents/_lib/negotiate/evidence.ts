import type { Database } from "bun:sqlite";

import type { NegotiateEvidenceRef } from "../negotiate-types.ts";

/**
 * The agent-caused exclusion clause: `<column>` is not one of the ids bound as ONE JSON-array
 * parameter (`json_each`), so the id list never becomes SQL text and an empty list is a no-op.
 * `column` is always a fixed identifier from this file, never caller data.
 */
export function notExcluded(column: "id" | "i.id"): string {
  return `${column} NOT IN (SELECT value FROM json_each(?))`;
}

/**
 * How many evidence refs a single lane may carry (spec § 5.B, citation half).
 *
 * A 365-day window over an active repo holds hundreds of PRs; an unbounded list stops being
 * a brief and becomes a data dump nobody reads, which defeats the purpose as thoroughly as
 * having no citations at all. Truncation is safe here ONLY because it self-discloses:
 * `NegotiateEvidence.total` carries the full population, so the renderer can say "and N
 * more" instead of letting a capped list read as exhaustive. Exported so tests can seed
 * exactly-at / one-past the boundary without duplicating the magic number.
 */
export const NEGOTIATE_EVIDENCE_LIMIT = 5;

/**
 * `title` + best-available url for the `item` rows a lane counted, newest first.
 *
 * Ordered `modified_at DESC, id ASC` — the `id` tiebreak is not decoration: without it two
 * items sharing a timestamp (routine, since a sync stamps a batch) come back in whatever
 * order SQLite chooses, so the same index could cite different PRs on two consecutive runs
 * of an unchanged brief. `COALESCE(canonical_url, url)` because not every connector records
 * a canonical url, and a null stays null rather than being invented.
 */
export function evidenceRefsFor(
  db: Database,
  sql: string,
  params: readonly (string | number)[],
): NegotiateEvidenceRef[] {
  const rows = db.query(sql).all(...params) as Array<{ title: string; url: string | null }>;
  return rows.map((r) => ({ title: r.title, url: r.url }));
}
