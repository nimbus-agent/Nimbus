import type { Database } from "bun:sqlite";

import type { ChangedFileRow } from "./pr-changed-file-store.ts";

/** Matches `MAX_ENRICH_PER_TICK` in `connectors/github-sync.ts`, which drains the same way. */
export const MAX_PRS_PER_TICK = 10;

/**
 * Largest page each forge allows, so the cap is reached in the fewest requests. GitHub's files
 * endpoint defaults to 30, so the default would cost 3.3x the calls for any PR over 30 files.
 */
export const PR_FILES_PAGE_SIZE = 100;

/**
 * At `PR_FILES_PAGE_SIZE = 100` this is three requests for the largest PR we will store. A PR
 * beyond it is stored AND flagged `truncated`, which excludes it from negation entirely — holding
 * 300 of 4000 paths cannot verify "does not touch X".
 */
export const MAX_FILES_PER_PR = 300;

export type PrFileCandidate = {
  readonly itemId: string;
  readonly repoFull: string;
  readonly externalId: string;
};

/**
 * PRs of this service with no coverage row yet, newest first.
 *
 * `modified_at DESC` is what makes one selector serve both forward coverage and the bounded
 * backfill: recent PRs are covered first and the backlog shrinks every tick, so there is no
 * separate backfill mode to build or explain. `NOT EXISTS` rather than `NOT IN` — `NOT IN` with a
 * NULL anywhere in the subquery silently matches nothing.
 */
export function selectPrFileCandidates(
  db: Database,
  service: string,
  limit: number,
): PrFileCandidate[] {
  const rows = db
    .query(
      `SELECT i.id AS id, i.external_id AS external_id
         FROM item i
        WHERE i.type = 'pr'
          AND i.service = ?1
          AND NOT EXISTS (SELECT 1 FROM pr_files_state s WHERE s.item_id = i.id)
        ORDER BY i.modified_at DESC
        LIMIT ?2`,
    )
    .all(service, limit) as Array<{ id: string; external_id: string }>;
  const out: PrFileCandidate[] = [];
  for (const r of rows) {
    // Every forge keys a PR as `<repoFull><sep><num>`: `#` on GitHub and Bitbucket, `!` for
    // GitLab MRs. Split on the LAST separator — a repo path may itself contain neither, but
    // splitting on the first would break a group path like `grp/sub/proj!7`.
    const cut = Math.max(r.external_id.lastIndexOf("#"), r.external_id.lastIndexOf("!"));
    if (cut <= 0) {
      continue;
    }
    out.push({
      itemId: r.id,
      repoFull: r.external_id.slice(0, cut),
      externalId: r.external_id,
    });
  }
  return out;
}

/**
 * Apply `MAX_FILES_PER_PR`. Exactly-at-cap is NOT truncated: we hold every path, so a negation
 * over it is fully verified. Only a set we could not store completely is unverifiable.
 */
export function applyFileCap(files: readonly ChangedFileRow[]): {
  readonly kept: ChangedFileRow[];
  readonly truncated: boolean;
} {
  if (files.length <= MAX_FILES_PER_PR) {
    return { kept: [...files], truncated: false };
  }
  return { kept: files.slice(0, MAX_FILES_PER_PR), truncated: true };
}
