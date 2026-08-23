import type { Database } from "bun:sqlite";

import type { Provider } from "../sync/rate-limiter.ts";
import { RateLimitError, type SyncContext, UnauthenticatedError } from "../sync/types.ts";
import type { ChangedFileRow } from "./pr-changed-file-store.ts";
import { recordPrChangedFiles } from "./pr-changed-file-store.ts";

/** Matches `MAX_ENRICH_PER_TICK` in `connectors/github-sync.ts`, which drains the same way. */
export const MAX_PRS_PER_TICK = 10;

/**
 * How many candidates a tick may ATTEMPT, against `MAX_PRS_PER_TICK` it may RECORD.
 *
 * Without a gap between the two, a persistently failing head pins coverage at zero forever. A
 * failed candidate deliberately gets NO coverage row — a row asserts "we know this PR's files", so
 * writing one on failure would break the fail-closed property the whole table exists for — and
 * `selectPrFileCandidates` is strictly `modified_at DESC`. So ten newest PRs in repos that were
 * deleted or made private 404 forever, fill the entire budget every tick, and no older healthy PR
 * is ever reached: `PR file coverage: 0 / N` never moves on any account quiet enough that ten
 * newer PRs do not arrive.
 *
 * The trade this makes: a tick can spend up to
 * `MAX_PRS_PER_TICK * (PR_ATTEMPT_BUDGET_MULTIPLIER - 1)` candidate attempts that record nothing,
 * every tick, for as long as the head stays broken (each attempt costs one request, or up to
 * `MAX_PAGES_PER_PR` if it fails partway through pagination). That is a bounded per-tick cost, and
 * it buys coverage that GROWS instead of stalling at zero.
 *
 * The alternative — persisting a failure marker so a known-bad PR is skipped — was rejected: it is
 * a schema change, and any row in `pr_files_state` asserts coverage, so the marker would have to
 * live somewhere new rather than reuse that table.
 */
export const PR_ATTEMPT_BUDGET_MULTIPLIER = 3;

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
 * Collapse to one row per path, keeping the FIRST occurrence.
 *
 * A rename chain in a single PR legitimately produces a repeated path: `a.ts -> b.ts` plus
 * `c.ts -> a.ts` maps to `["b.ts","a.ts","a.ts","c.ts"]` (`a.ts` once as the new name of the first
 * rename, once as the old name of the second). `pr_changed_file`'s primary key is `(item_id,
 * path)`, so writing that raw would throw. First-wins is arbitrary but deterministic — a predicate
 * only reads PATH MEMBERSHIP ("did this PR touch X"), never `status`, so which occurrence's status
 * survives does not change any query result.
 */
function dedupeFileRowsByPath(rows: readonly ChangedFileRow[]): ChangedFileRow[] {
  const seen = new Set<string>();
  const out: ChangedFileRow[] = [];
  for (const r of rows) {
    if (seen.has(r.path)) {
      continue;
    }
    seen.add(r.path);
    out.push(r);
  }
  return out;
}

/**
 * Drain candidates for one service until `MAX_PRS_PER_TICK` are RECORDED or the attempt budget
 * (`MAX_PRS_PER_TICK * PR_ATTEMPT_BUDGET_MULTIPLIER` selected candidates) runs out. Returns how
 * many were recorded.
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
interface PrFilePages {
  readonly rows: ChangedFileRow[];
  /** True only when a page reported `hasMore === false` — i.e. we hold the FULL path set. */
  readonly pagesExhausted: boolean;
  readonly failed: boolean;
  readonly rateLimited: boolean;
}

/**
 * Walk one PR's changed-file pages. Split out of `runPrFilePass` for cognitive complexity
 * (S3776) — the page walk and the per-candidate bookkeeping are separate concerns, and the
 * three mutable flags the caller used to thread through the loop are now this function's
 * return value.
 */
async function collectPrFilePages(
  ctx: SyncContext,
  args: { readonly service: Provider; readonly fetchPage: FetchPage },
  c: PrFileCandidate,
): Promise<PrFilePages> {
  const rows: ChangedFileRow[] = [];
  for (let page = 1; page <= MAX_PAGES_PER_PR; page++) {
    // `tryAcquire`, never `acquire`: at least one existing 429 handler in this codebase
    // (`_lib/gitlab/pipelines.ts`) calls `rateLimiter.penalise()` WITHOUT throwing, by
    // design — its own caller keeps going rather than aborting the sync. `acquire` would
    // then SLEEP OUT that whole penalty window right here, blocking one of only
    // `maxConcurrentSyncs` scheduler slots for the full `Retry-After`. `tryAcquire` never
    // sleeps (see its doc comment in `sync/rate-limiter.ts`) — it takes a token if one is
    // free and returns `false` instantly otherwise — so a penalised or exhausted provider
    // is detected without blocking, and the pass simply stops for THIS tick.
    const ok = await ctx.rateLimiter.tryAcquire(args.service);
    if (!ok) {
      return { rows, pagesExhausted: false, failed: false, rateLimited: true };
    }
    const res = await args.fetchPage(c, page);
    if (res === null) {
      // Warn on the SILENT failure path too, not just on the throw path below. `null` is what
      // every forge closure returns for a non-ok response (a 404 on a deleted or now-private
      // repo, most of all) and for an unparseable body — precisely the failures that repeat
      // forever on the same PRs. Unlogged, the head-of-line stall that
      // `PR_ATTEMPT_BUDGET_MULTIPLIER` bounds would be invisible: coverage would sit still
      // with nothing in the log to say why.
      ctx.logger.warn(
        { service: args.service, itemId: c.itemId, page },
        "PR changed-file page unavailable (non-fatal, PR left uncovered, will retry next tick)",
      );
      return { rows, pagesExhausted: false, failed: true, rateLimited: false };
    }
    rows.push(...res.rows);
    if (!res.hasMore) {
      return { rows, pagesExhausted: true, failed: false, rateLimited: false };
    }
  }
  // Ran out of page budget with more still on offer — not exhausted, so the caller marks the
  // record truncated.
  return { rows, pagesExhausted: false, failed: false, rateLimited: false };
}

export async function runPrFilePass(
  ctx: SyncContext,
  args: {
    readonly service: Provider;
    readonly fetchPage: FetchPage;
    readonly nowMs: number;
  },
): Promise<number> {
  const candidates = selectPrFileCandidates(
    ctx.db,
    args.service,
    MAX_PRS_PER_TICK * PR_ATTEMPT_BUDGET_MULTIPLIER,
  );
  let recorded = 0;
  for (const c of candidates) {
    // The record budget, not the attempt budget: the extra candidates exist only so a failing
    // head cannot consume the whole tick (see `PR_ATTEMPT_BUDGET_MULTIPLIER`). A tick whose
    // candidates all succeed still writes exactly `MAX_PRS_PER_TICK` rows and stops here.
    if (recorded >= MAX_PRS_PER_TICK) {
      break;
    }
    try {
      const {
        rows: collected,
        pagesExhausted,
        failed,
        rateLimited,
      } = await collectPrFilePages(ctx, args, c);
      if (rateLimited) {
        // No coverage row for this candidate — same handling as a failed fetch, and the
        // selector re-queues it next tick. Stop the WHOLE pass, not just this candidate: every
        // remaining candidate shares the same per-provider penalty/token bucket, so continuing
        // to loop would just call `tryAcquire` repeatedly for a `false` we already know.
        break;
      }
      if (!failed) {
        // The write happens INSIDE this try: a failure here (e.g. a genuine duplicate that
        // slipped past `dedupeFileRowsByPath`) must cost only this candidate, same as a fetch
        // failure — never escape `runPrFilePass` and strand every later candidate this tick.
        const { kept, truncated } = applyFileCap(dedupeFileRowsByPath(collected));
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
    } catch (err) {
      // A rate-limit error ends the whole tick; anything else costs only this PR.
      if (err instanceof RateLimitError) {
        throw err;
      }
      // So does a credential failure, and for a stronger reason. Swallowing it here would cost
      // twice: `sync/scheduler.ts`'s `runJob` catch — the ONLY place that calls
      // `transitionHealth(..., { type: "unauthenticated" })` and notifies the user to re-run
      // `nimbus connector auth` — never sees it, so the connector keeps reporting healthy while
      // it cannot authenticate; and the enclosing candidate loop carries on issuing one doomed
      // request per remaining candidate (`MAX_PRS_PER_TICK * PR_ATTEMPT_BUDGET_MULTIPLIER` of them),
      // every tick, forever. A revoked token is not a per-PR problem, so it cannot have a
      // per-PR cost. The candidate is left uncovered exactly as a failed fetch would leave it.
      if (err instanceof UnauthenticatedError) {
        throw err;
      }
      ctx.logger.warn(
        { service: args.service, itemId: c.itemId, err: String(err) },
        "PR changed-file fetch failed for one PR (non-fatal, will retry next tick)",
      );
    }
  }
  return recorded;
}
