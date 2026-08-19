import type { Database } from "bun:sqlite";

import type { Provider } from "../sync/rate-limiter.ts";
import { RateLimitError, type SyncContext } from "../sync/types.ts";
import type { ChangedFileRow } from "./pr-changed-file-store.ts";
import { recordPrChangedFiles } from "./pr-changed-file-store.ts";

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

/** `MAX_FILES_PER_PR / PR_FILES_PAGE_SIZE` — three requests reach the largest set we store. */
export const MAX_PAGES_PER_PR = 3;

/**
 * Fetch ONE page for a candidate. Returns `null` when the page could not be read at all — the
 * driver treats that as a failure for this PR, not as "no files".
 */
export type FetchPage = (
  candidate: PrFileCandidate,
  page: number,
) => Promise<{ readonly rows: readonly ChangedFileRow[]; readonly hasMore: boolean } | null>;

/**
 * Drain up to `MAX_PRS_PER_TICK` candidates for one service. Returns how many were recorded.
 *
 * Each candidate is fetched and written INDEPENDENTLY, and this loop deliberately holds no
 * transaction of its own: `recordPrChangedFiles` scopes one per PR, so a candidate that throws
 * mid-tick cannot roll back the PRs already written. A rate-limit error still propagates, because
 * continuing to hammer a limited API is worse than ending the tick early.
 *
 * A failed candidate is left with NO coverage row rather than an empty one. An empty coverage row
 * would assert "we checked this PR and it touched nothing" — a confident wrong negative, which is
 * exactly what the coverage table exists to prevent. Leaving it uncovered means the selector
 * re-queues it next tick.
 *
 * Pages are mapped and concatenated as they arrive rather than being buffered as raw JSON, so a
 * large PR never holds more than one page of payload in memory.
 */
export async function runPrFilePass(
  ctx: SyncContext,
  args: {
    readonly service: string;
    readonly fetchPage: FetchPage;
    readonly nowMs: number;
  },
): Promise<number> {
  const candidates = selectPrFileCandidates(ctx.db, args.service, MAX_PRS_PER_TICK);
  let recorded = 0;
  for (const c of candidates) {
    const collected: ChangedFileRow[] = [];
    let pagesExhausted = false;
    let failed = false;
    try {
      for (let page = 1; page <= MAX_PAGES_PER_PR; page++) {
        // `args.service` is caller-supplied per-forge ("github"/"gitlab"/"bitbucket"), always a
        // real `Provider` id; the driver itself is forge-agnostic so its own signature keeps
        // `service` as `string` rather than importing every forge's literal into this type.
        await ctx.rateLimiter.acquire(args.service as Provider);
        const res = await args.fetchPage(c, page);
        if (res === null) {
          failed = true;
          break;
        }
        collected.push(...res.rows);
        if (!res.hasMore) {
          pagesExhausted = true;
          break;
        }
      }
    } catch (err) {
      // A rate-limit error ends the whole tick; anything else costs only this PR.
      if (err instanceof RateLimitError) {
        throw err;
      }
      ctx.logger.warn(
        { service: args.service, itemId: c.itemId, err: String(err) },
        "PR changed-file fetch failed for one PR (non-fatal, will retry next tick)",
      );
      failed = true;
    }
    if (failed) {
      continue;
    }
    const { kept, truncated } = applyFileCap(collected);
    recordPrChangedFiles(ctx.db, {
      itemId: c.itemId,
      repoFull: c.repoFull,
      files: kept,
      apiFileCount: collected.length,
      // Truncated when the cap trimmed rows OR when we ran out of page budget with
      // more pages still on offer — both mean we do not hold the full path set.
      truncated: truncated || !pagesExhausted,
      nowMs: args.nowMs,
    });
    recorded += 1;
  }
  return recorded;
}
