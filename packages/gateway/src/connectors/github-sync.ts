import type { Database } from "bun:sqlite";

import { itemPrimaryKey, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import type { PersonSyncHints } from "../people/person-types.ts";
import {
  FETCH_ONE_TIMEOUT_MS,
  type FetchOneResult,
  RateLimitError,
  retryAfterDateFromHeader,
  type Syncable,
  type SyncContext,
  type SyncResult,
  syncNoopResult,
  UnauthenticatedError,
} from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { fetchOneMissForResponse } from "./fetch-miss-reason.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "github";
const CURSOR_PREFIX = "nimbus-ghub1:";
const USER_URL = "https://api.github.com/user";

export function pullDetailUrl(repoFull: string, num: number): string {
  return `https://api.github.com/repos/${repoFull}/pulls/${String(num)}`;
}

function extractLabelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    const r = asRecord(entry);
    if (r === undefined) {
      continue;
    }
    const name = stringField(r, "name");
    if (name !== undefined && name.length > 0) {
      out.push(name);
    }
  }
  return out;
}

const MERGEABLE_STATE_REFRESH_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const MERGEABLE_STATE_UPDATED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export type MergeableStateRefreshInput = {
  readonly mergeableState: string | null;
  readonly mergeableStateFetchedAtMs: number | null;
  readonly updatedAtMs: number;
  readonly nowMs: number;
};

export function shouldRefreshMergeableState(input: MergeableStateRefreshInput): boolean {
  const updatedAge = input.nowMs - input.updatedAtMs;
  if (updatedAge > MERGEABLE_STATE_UPDATED_WINDOW_MS) return false;
  if (input.mergeableState === null) return true;
  if (input.mergeableStateFetchedAtMs === null) return true;
  const refreshAge = input.nowMs - input.mergeableStateFetchedAtMs;
  return refreshAge > MERGEABLE_STATE_REFRESH_FRESHNESS_MS;
}

export function extractPrMetadataForIndex(
  repoFull: string,
  pr: Record<string, unknown>,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  const merged = pr["merged"] === true;
  const user = asRecord(pr["user"]);
  const login = user === undefined ? undefined : stringField(user, "login");
  const out: Record<string, unknown> = {
    number: numberField(pr, "number"),
    repo: repoFull,
    state: stringField(pr, "state"),
    draft: pr["draft"] === true,
    merged,
    user: login,
    labels: extractLabelNames(pr["labels"]),
  };
  const mergeable = pr["mergeable"];
  if (typeof mergeable === "boolean") {
    out["mergeable"] = mergeable;
  }
  const mergeableState = stringField(pr, "mergeable_state");
  if (mergeableState !== undefined && mergeableState.length > 0) {
    out["mergeable_state"] = mergeableState;
    out["mergeable_state_fetched_at_ms"] = nowMs;
  }
  for (const key of ["additions", "deletions", "changed_files", "commits"] as const) {
    const v = numberField(pr, key);
    if (v !== undefined) {
      out[key] = v;
    }
  }
  if (merged) {
    const mergedAtIso = stringField(pr, "merged_at");
    if (mergedAtIso !== undefined) {
      const ms = Date.parse(mergedAtIso);
      if (Number.isFinite(ms)) {
        out["merged_at"] = ms;
      }
    }
    const sha = stringField(pr, "merge_commit_sha");
    if (sha !== undefined && sha.length > 0) {
      out["merge_commit_sha"] = sha;
    }
  }
  return out;
}

function eventsUrlFor(login: string): string {
  return `https://api.github.com/users/${encodeURIComponent(login)}/events?per_page=${String(GITHUB_EVENTS_PAGE_SIZE)}`;
}

type GithubSyncCursorV1 = { etag: string | null; login: string | null };

function encodeCursor(c: GithubSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): GithubSyncCursorV1 | null {
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (parsed === undefined) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const etag = rec["etag"];
  const login = rec["login"];
  return {
    etag: typeof etag === "string" ? etag : null,
    login: typeof login === "string" && login !== "" ? login : null,
  };
}

function resolveGithubActorPersonId(
  db: Database,
  user: Record<string, unknown> | undefined,
): string | null {
  if (user === undefined) {
    return null;
  }
  const login = stringField(user, "login");
  if (login === undefined || login === "") {
    return null;
  }
  const emailRaw = stringField(user, "email");
  const email =
    emailRaw !== undefined && emailRaw !== "" ? emailRaw.trim().toLowerCase() : undefined;
  const hints: PersonSyncHints = {
    displayName: login,
    githubLogin: login,
  };
  if (email !== undefined) {
    return resolvePersonForSync(db, { ...hints, canonicalEmail: email });
  }
  return resolvePersonForSync(db, hints);
}

function modifiedMsFromGithubTimestamps(
  record: Record<string, unknown>,
  fallbackMs: number,
): number {
  const updatedRaw = stringField(record, "updated_at");
  if (updatedRaw !== undefined) {
    const t = Date.parse(updatedRaw);
    if (Number.isFinite(t)) {
      return t;
    }
  }
  const createdRaw = stringField(record, "created_at");
  if (createdRaw !== undefined) {
    const t = Date.parse(createdRaw);
    if (Number.isFinite(t)) {
      return t;
    }
  }
  return fallbackMs;
}

/**
 * The `<repoFull>#<num>` external-id shape shared by `upsertPr` and `fetchOne`. Both MUST derive
 * this from the same source — the API response's own `number` field — so the id `fetchOne`
 * returns can never diverge from the id the row was actually written under (e.g. a caller URL's
 * `/pull/007` vs. the API's normalized `number: 7`).
 */
function githubPrExternalId(repoFull: string, num: number): string {
  return `${repoFull}#${String(num)}`;
}

const PR_STAT_KEYS = ["additions", "deletions", "changed_files", "commits"] as const;

/**
 * I-2: `extractPrMetadataForIndex` only sets the four size-stat keys when the incoming payload
 * carries them — true only of the single-PR / pull-detail response, never of the events feed's
 * `PullRequestEvent`/`PullRequestReviewEvent` payloads. `upsertIndexedItem` writes metadata with
 * `metadata = excluded.metadata`, which REPLACES the row's metadata wholesale, so any later
 * events-path upsert for a PR that `enrichPrDetail` already filled in would otherwise silently
 * erase its stats — and `selectPrEnrichCandidates` would then re-queue that PR forever, since
 * `modified_at` also just advanced, pushing it to the front of the `modified_at DESC` candidate
 * list. Merge the four keys forward from the currently-indexed row whenever the incoming payload
 * omits them.
 *
 * Accepted tradeoff: once merged forward, stats can go stale (an event bumps `modified_at`
 * without new commit/diff counts) until the next detail fetch refreshes them. That is strictly
 * better than losing the stats outright and re-enriching the same PR on every tick.
 *
 * Scope, deliberately: this merges forward the four `PR_STAT_KEYS` only. `mergeable`,
 * `mergeable_state`, and `mergeable_state_fetched_at_ms` are subject to the same wholesale
 * `metadata = excluded.metadata` replacement and are NOT merged forward here — left as-is
 * because no re-queue loop results: `shouldRefreshMergeableState` currently has no production
 * caller, so nothing re-derives or re-fetches `mergeable_state` off the back of a cleared value.
 * Not an oversight; revisit together if `shouldRefreshMergeableState` ever gets wired up.
 *
 * Open question (unverified): `extractPrMetadataForIndex`'s own docstring and
 * `selectPrEnrichCandidates`'s docstring both assert the GitHub events feed omits `title` on
 * `PullRequestEvent` payloads. If that holds, an events-path `upsertPr` call for an
 * already-enriched PR falls back to the id-only `PR #<num>` title (see `upsertPr`), which is a
 * plain field on the `item` row, not something this function merges forward. `title LIKE
 * 'PR #%'` would then re-match, and `selectPrEnrichCandidates`'s exact-fallback arm re-queues
 * the row regardless of stats — so this stats merge-forward would close only one of the
 * selector's two arms, not both. This could not be confirmed from GitHub's published docs and
 * needs verification against the live API before anyone treats it as fixed either way.
 */
function mergeForwardPrStats(
  db: Database,
  meta: Record<string, unknown>,
  externalId: string,
): Record<string, unknown> {
  const missing = PR_STAT_KEYS.filter((k) => meta[k] === undefined);
  if (missing.length === 0) {
    return meta;
  }
  const id = itemPrimaryKey(SERVICE_ID, externalId);
  const row = db.query("SELECT metadata FROM item WHERE id = ?").get(id) as {
    metadata: string | null;
  } | null;
  if (row === null || row.metadata === null) {
    return meta;
  }
  let existing: unknown;
  try {
    existing = JSON.parse(row.metadata) as unknown;
  } catch {
    return meta;
  }
  const existingRec = asRecord(existing);
  if (existingRec === undefined) {
    return meta;
  }
  const merged = { ...meta };
  for (const k of missing) {
    const v = existingRec[k];
    if (v !== undefined) {
      merged[k] = v;
    }
  }
  return merged;
}

export function upsertPr(
  ctx: SyncContext,
  repoFull: string,
  pr: Record<string, unknown>,
  now: number,
  /**
   * The exact, unencoded browser URL a caller is fetching-one-by, when there is one. When
   * present, used VERBATIM for both `url` and `canonicalUrl` in place of the API's own
   * `html_url` — mirrors `_lib/gitlab/events.ts`'s `GitlabEventUpsertFields.webUrl` exactly.
   *
   * MUST be sourced from the CALLER's own URL, never from anything the API response says: GitHub
   * 301s a renamed repo and returns the NEW `html_url`, so trusting it would write a row whose
   * `resolve_key` no longer matches the caller's URL (a permanent miss), while the periodic
   * events sync — which has no caller URL to speak of — then indexes the SAME PR again under the
   * new path, leaving two rows sharing one `resolve_key` (`ambiguous` forever). `html_url` can
   * also be entirely absent from a response, which must not leave `resolve_key` NULL on an
   * `{"status":"indexed"}` reply. The periodic sync has no caller URL, so `webUrl` stays
   * undefined there and its rows are byte-identical to before this fix.
   */
  webUrl?: string,
): void {
  const num = numberField(pr, "number");
  if (num === undefined) {
    return;
  }
  const title = stringField(pr, "title") ?? `PR #${String(num)}`;
  const body = stringField(pr, "body");
  const htmlUrl = stringField(pr, "html_url");
  const url = webUrl ?? htmlUrl ?? null;
  const modified = modifiedMsFromGithubTimestamps(pr, now);
  const user = asRecord(pr["user"]);
  const authorId = resolveGithubActorPersonId(ctx.db, user);
  const externalId = githubPrExternalId(repoFull, num);
  const meta = mergeForwardPrStats(
    ctx.db,
    extractPrMetadataForIndex(repoFull, pr, now),
    externalId,
  );
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "pr",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    body: body ?? "",
    url,
    canonicalUrl: url,
    modifiedAt: modified,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
}

function githubReviewExternalId(repoFull: string, prNum: number, reviewId: number): string {
  return `${repoFull}#${String(prNum)}#review-${String(reviewId)}`;
}

/**
 * A review is indexed as its own item rather than as PR metadata: the item
 * upsert replaces `metadata` wholesale (`index/item-store.ts`), so a later
 * `PullRequestEvent` for the same PR would silently erase reviewer data stored
 * there. Separate rows cannot clobber one another.
 *
 * The events feed is the authenticated user's own activity, so `author_id` here
 * is always the local user — this indexes "PRs I reviewed", never "who reviewed
 * my PRs".
 */
function upsertReview(
  ctx: SyncContext,
  repoFull: string,
  review: Record<string, unknown>,
  prNum: number,
  now: number,
): boolean {
  const reviewId = numberField(review, "id");
  if (reviewId === undefined) {
    return false;
  }
  const user = asRecord(review["user"]);
  const authorId = resolveGithubActorPersonId(ctx.db, user);
  const state = stringField(review, "state");
  const body = stringField(review, "body");
  const submitted = stringField(review, "submitted_at");
  const modified = submitted === undefined ? now : Date.parse(submitted);
  const htmlUrl = stringField(review, "html_url");

  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "review",
    externalId: githubReviewExternalId(repoFull, prNum, reviewId),
    title: `Review on ${repoFull}#${String(prNum)}`,
    body: body ?? "",
    url: htmlUrl ?? null,
    canonicalUrl: htmlUrl ?? null,
    modifiedAt: Number.isFinite(modified) ? modified : now,
    authorId,
    metadata: {
      repo: repoFull,
      pr_number: prNum,
      review_id: reviewId,
      state: state ?? null,
    },
    pinned: false,
    syncedAt: now,
  });
  return true;
}

function upsertFromIssue(
  ctx: SyncContext,
  repoFull: string,
  issue: Record<string, unknown>,
  now: number,
): void {
  const num = numberField(issue, "number");
  if (num === undefined) {
    return;
  }
  const title = stringField(issue, "title") ?? `Issue #${String(num)}`;
  const body = stringField(issue, "body");
  const htmlUrl = stringField(issue, "html_url");
  const modified = modifiedMsFromGithubTimestamps(issue, now);
  const user = asRecord(issue["user"]);
  const login = user === undefined ? undefined : stringField(user, "login");
  const authorId = resolveGithubActorPersonId(ctx.db, user);
  const meta: Record<string, unknown> = {
    number: num,
    repo: repoFull,
    state: stringField(issue, "state"),
    user: login,
  };
  const externalId = `${repoFull}#issue-${String(num)}`;
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "issue",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    body: body ?? "",
    url: htmlUrl ?? null,
    canonicalUrl: htmlUrl ?? null,
    modifiedAt: modified,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
}

function processPullRequestPayload(
  ctx: SyncContext,
  fullName: string,
  payload: Record<string, unknown>,
  now: number,
): boolean {
  const pr = asRecord(payload["pull_request"]);
  if (pr === undefined) {
    return false;
  }
  upsertPr(ctx, fullName, pr, now);
  return true;
}

function processPullRequestReviewPayload(
  ctx: SyncContext,
  fullName: string,
  payload: Record<string, unknown>,
  now: number,
): boolean {
  const review = asRecord(payload["review"]);
  const pr = asRecord(payload["pull_request"]);
  if (review === undefined || pr === undefined) {
    return false;
  }
  const num = numberField(pr, "number");
  if (num === undefined) {
    return false;
  }
  // Index the PR too, so the `reviewed` edge targets a titled item rather than a
  // stub: 14 call sites inner-join `item` on `graph_entity.external_id`, and an
  // item-less entity is invisible to all of them.
  upsertPr(ctx, fullName, pr, now);
  return upsertReview(ctx, fullName, review, num, now);
}

function processIssuesPayload(
  ctx: SyncContext,
  fullName: string,
  payload: Record<string, unknown>,
  now: number,
): boolean {
  const issue = asRecord(payload["issue"]);
  if (issue === undefined) {
    return false;
  }
  if (issue["pull_request"] !== undefined) {
    return false;
  }
  upsertFromIssue(ctx, fullName, issue, now);
  return true;
}

export function processEvent(ctx: SyncContext, ev: Record<string, unknown>, now: number): boolean {
  const repo = asRecord(ev["repo"]);
  if (repo === undefined) {
    return false;
  }
  const fullName = stringField(repo, "full_name") ?? stringField(repo, "name");
  if (fullName === undefined || fullName === "") {
    return false;
  }
  const type = stringField(ev, "type");
  const payload = asRecord(ev["payload"]);
  if (payload === undefined) {
    return false;
  }
  if (type === "PullRequestEvent") {
    return processPullRequestPayload(ctx, fullName, payload, now);
  }
  if (type === "PullRequestReviewEvent") {
    return processPullRequestReviewPayload(ctx, fullName, payload, now);
  }
  if (type === "IssuesEvent") {
    return processIssuesPayload(ctx, fullName, payload, now);
  }
  return false;
}

function buildGithubEventHeaders(pat: string, etag: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${pat}`,
  };
  if (etag !== null && etag !== "") {
    headers["If-None-Match"] = etag;
  }
  return headers;
}

function parseGithubEventsPayload(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("GitHub events: invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("GitHub events: expected array");
  }
  return parsed;
}

export function throwGithubRateLimitErrorIfApplicable(
  ctx: SyncContext,
  res: Response,
  label: string,
): void {
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    // GitHub returns 403 OR 429 for secondary (abuse) limits, and documents
    // `retry-after` as an independent signal: a secondary limit can arrive with
    // primary quota still available. Keying only on `remaining === 0` misses
    // every one of those and retries straight into the limit.
    if (remaining === "0" || remaining === null || retryAfter !== null) {
      const retryAt = retryAfterDateFromHeader(retryAfter, 60);
      const ms = Math.max(1000, retryAt.getTime() - Date.now());
      ctx.rateLimiter.penalise("github", ms);
      throw new RateLimitError(retryAt, `GitHub ${label}: rate limited (403)`);
    }
    return;
  }
  if (res.status === 429) {
    const retryAt = retryAfterDateFromHeader(res.headers.get("retry-after"), 60);
    const ms = Math.max(1000, retryAt.getTime() - Date.now());
    ctx.rateLimiter.penalise("github", ms);
    throw new RateLimitError(retryAt, `GitHub ${label}: rate limited (429)`);
  }
}

interface FallbackPrCandidate {
  readonly externalId: string;
  readonly repoFull: string;
  readonly num: number;
}

const MAX_ENRICH_PER_TICK = 10;

/**
 * Single source of truth for the events feed's `per_page`, shared by `eventsUrlFor` (the request)
 * and `syncGithubUserEvents` (the full-page saturation check) so the two can never drift.
 */
const GITHUB_EVENTS_PAGE_SIZE = 100;

/**
 * True when `metadata` (a JSON blob) already carries a non-null `additions` field.
 * Unparseable JSON returns `false` — mirrors the SQL's `NOT json_valid(metadata)` arm:
 * a row that cannot be proven to have stats must remain a candidate, never be skipped.
 */
function metadataHasStats(metadata: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata) as unknown;
  } catch {
    return false;
  }
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return false;
  }
  const additions = rec["additions"];
  return additions !== undefined && additions !== null;
}

/**
 * Candidates for a pull-detail re-fetch. Two independent reasons:
 *   1. the title is still the id-only `PR #<n>` fallback (the events feed omits
 *      `title` on `PullRequestEvent` payloads), or
 *   2. size statistics are missing — `additions`/`deletions`/`changed_files`/
 *      `commits` exist only on the single-PR response, never on events or the
 *      list endpoint.
 *
 * The SQL `WHERE` deliberately over-selects: its `title LIKE 'PR #%'` arm also
 * matches a REAL title that merely starts with that text (e.g. `"PR #142 fix
 * bug"`), and `upsertPr` writes GitHub's real title back unchanged, so such a
 * row would otherwise re-qualify forever — permanently occupying a slot in the
 * `MAX_ENRICH_PER_TICK`-capped, `modified_at DESC`-ordered result and starving
 * rows that genuinely still need enrichment. The JS loop below narrows each
 * over-selected row to the exact two reasons: keep it only if the title is the
 * EXACT `PR #<num>` fallback, or its stats are still missing. Since the SQL
 * already guarantees every row matched one of the two arms, a row that is not
 * the exact fallback and already has stats can only have matched via the LIKE
 * over-select, so skipping it is safe and sufficient.
 *
 * `json_extract` is used (via `metadataHasStats`) rather than a LIKE over the
 * raw metadata blob so a PR body mentioning "additions" cannot mask a
 * genuinely missing field. `OR` does NOT short-circuit SQLite's evaluation
 * order in a way that is guaranteed by contract. Measured behaviour (bun 1.3.14 /
 * SQLite 3.53.0): the bare `OR` form DOES short-circuit per row in WHERE-clause
 * context and does not throw; the same expression in a SELECT-list value context
 * DOES throw. Rather than depend on that context distinction, the `json_extract`
 * arm is wrapped in a
 * `CASE WHEN json_valid(metadata) THEN … ELSE 1 END` guard, mirrored by
 * `metadataHasStats`'s parse-failure fallback: a row whose metadata cannot be
 * parsed must remain a CANDIDATE (the `ELSE 1`), because malformed JSON must
 * never be treated as "has stats" — that would incorrectly skip a row that
 * cannot be proven enriched.
 */
export function selectPrEnrichCandidates(db: Database, limit: number): FallbackPrCandidate[] {
  const rows = db
    .query(
      `SELECT external_id, title, metadata FROM item
         WHERE service = 'github' AND type = 'pr'
           AND (
             title LIKE 'PR #%'
             OR CASE
                  WHEN json_valid(metadata) THEN json_extract(metadata, '$.additions') IS NULL
                  ELSE 1
                END
           )
         ORDER BY modified_at DESC LIMIT ?`,
    )
    .all(limit * 3) as { external_id: string; title: string; metadata: string }[]; // over-select; JS narrows below
  const out: FallbackPrCandidate[] = [];
  for (const r of rows) {
    const hash = r.external_id.lastIndexOf("#");
    if (hash <= 0) continue;
    const repoFull = r.external_id.slice(0, hash);
    const num = Number.parseInt(r.external_id.slice(hash + 1), 10);
    if (!Number.isFinite(num)) continue;
    const isExactFallback = r.title === `PR #${String(num)}`;
    if (!isExactFallback && metadataHasStats(r.metadata)) continue; // only matched via the LIKE over-select
    out.push({ externalId: r.external_id, repoFull, num });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Re-fetches pull-request detail for any indexed `pr` row that either still
 * carries the id-only `PR #<num>` fallback title (the GitHub events feed omits
 * `title` on `PullRequestEvent` payloads) or is missing size statistics
 * (`additions`/`deletions`/`changed_files`/`commits`, which exist only on the
 * single-PR response). Processes up to `MAX_ENRICH_PER_TICK` rows, newest-first,
 * sequentially through the shared rate limiter.
 */
export async function enrichPrDetail(
  ctx: SyncContext,
  pat: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const candidates = selectPrEnrichCandidates(ctx.db, MAX_ENRICH_PER_TICK);
  let enriched = 0;
  for (const c of candidates) {
    await ctx.rateLimiter.acquire("github");
    const res = await fetchImpl(pullDetailUrl(c.repoFull, c.num), {
      headers: buildGithubEventHeaders(pat, null),
    });
    if (res.status === 401) {
      throw new UnauthenticatedError("GitHub pull detail: unauthorized (401)");
    }
    throwGithubRateLimitErrorIfApplicable(ctx, res, "pull detail"); // may throw RateLimitError
    if (!res.ok) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await res.text()) as unknown;
    } catch {
      continue;
    }
    const pr = asRecord(parsed);
    if (pr === undefined) {
      continue;
    }
    upsertPr(ctx, c.repoFull, pr, now);
    enriched += 1;
  }
  const remaining = selectPrEnrichCandidates(ctx.db, MAX_ENRICH_PER_TICK + 1).length;
  if (remaining > MAX_ENRICH_PER_TICK) {
    ctx.logger.info(
      { service: SERVICE_ID, enriched, remainingAtLeast: MAX_ENRICH_PER_TICK },
      "PR detail enrichment has more candidates queued for the next tick",
    );
  }
  return enriched;
}

/**
 * I-3: shared by both the changed-events path and the 304 (unchanged) path, so a quiet tick still
 * drains the enrichment backlog. `selectPrEnrichCandidates` is `modified_at DESC`-ordered and
 * `MAX_ENRICH_PER_TICK`-capped; before this helper existed, `syncGithubUserEvents` only reached
 * `enrichPrDetail` when the events feed itself changed, so on a low-activity account most ticks
 * returned 304 and the backlog drained at roughly zero.
 */
async function runPrDetailEnrichmentBestEffort(
  ctx: SyncContext,
  pat: string,
  now: number,
): Promise<void> {
  try {
    await enrichPrDetail(ctx, pat, now);
  } catch (err) {
    if (err instanceof RateLimitError) throw err; // honor backoff
    ctx.logger.warn(
      { service: SERVICE_ID, err: String(err) },
      "PR detail enrichment pass failed (non-fatal)",
    );
  }
}

async function fetchAuthenticatedLogin(ctx: SyncContext, pat: string): Promise<string> {
  await ctx.rateLimiter.acquire("github");
  const res = await fetch(USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${pat}`,
    },
  });
  if (res.status === 401) {
    throw new UnauthenticatedError("GitHub /user: unauthorized (401)");
  }
  throwGithubRateLimitErrorIfApplicable(ctx, res, "/user");
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub /user ${String(res.status)}: ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("GitHub /user: invalid JSON");
  }
  const rec = asRecord(parsed);
  const login = rec === undefined ? undefined : stringField(rec, "login");
  if (login === undefined || login === "") {
    throw new Error("GitHub /user: response missing login");
  }
  return login;
}

async function syncGithubUserEvents(
  ctx: SyncContext,
  cursor: string | null,
  pat: string,
  t0: number,
): Promise<SyncResult> {
  const prev = decodeCursor(cursor);
  let login = prev?.login ?? null;
  let etag = login === null ? null : (prev?.etag ?? null);
  let bytesTransferred = 0;

  if (login === null) {
    login = await fetchAuthenticatedLogin(ctx, pat);
    ctx.logger.info({ service: SERVICE_ID, login }, "Resolved GitHub authenticated user login");
    etag = null;
  }

  await ctx.rateLimiter.acquire("github");
  const headers = buildGithubEventHeaders(pat, etag);
  const res = await fetch(eventsUrlFor(login), { headers });
  const text = await res.text();
  bytesTransferred += text.length;

  if (res.status === 304) {
    // I-3: the events feed did not change, but the enrichment backlog is independent of it —
    // run it here too so a quiet account still drains. The cursor/return shape below is
    // otherwise byte-identical to before this fix.
    await runPrDetailEnrichmentBestEffort(ctx, pat, Date.now());
    return {
      ...syncNoopResult(cursor, t0),
      cursor: encodeCursor({ etag, login }),
      bytesTransferred,
    };
  }

  if (res.status === 401) {
    throw new UnauthenticatedError("GitHub events: unauthorized (401)");
  }

  throwGithubRateLimitErrorIfApplicable(ctx, res, "events");

  if (!res.ok) {
    throw new Error(`GitHub events ${String(res.status)}: ${text.slice(0, 200)}`);
  }

  const parsed = parseGithubEventsPayload(text);
  const now = Date.now();
  let upserted = 0;
  for (const item of parsed) {
    const ev = asRecord(item);
    if (ev === undefined) {
      continue;
    }
    if (processEvent(ctx, ev, now)) {
      upserted += 1;
    }
  }

  // One request per tick at per_page=100 (no pagination): a full page means the
  // window may have overflowed between syncs, and anything older is unreachable
  // from the events feed. Loss is silent by construction, so record it.
  if (parsed.length >= GITHUB_EVENTS_PAGE_SIZE) {
    ctx.logger.warn(
      { service: SERVICE_ID, events: parsed.length },
      "github events page was full; older events in this window may have been missed",
    );
  }

  // Best-effort detail enrichment for fallback-titled or stats-missing PRs (existing rows + this tick's events).
  await runPrDetailEnrichmentBestEffort(ctx, pat, now);

  const newEtag = res.headers.get("etag");
  const nextCursor = encodeCursor({ etag: newEtag, login });

  return {
    cursor: nextCursor,
    itemsUpserted: upserted,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
    bytesTransferred,
  };
}

/**
 * `https://<host>/<owner>/<repo>/pull/<n>` — the only shape targeted fetch supports.
 *
 * Anchored at both ends and every quantifier bounded: the caller-supplied URL reaches an API
 * path, so a permissive pattern here is a request-forgery surface, not a convenience.
 */
const GITHUB_PR_URL_RE = /^https?:\/\/[^/]+\/([\w.-]{1,100})\/([\w.-]{1,100})\/pull\/(\d{1,10})$/;

/** A capture that is entirely dots (`.`, `..`, `...`) is a path-traversal segment, not a name. */
const ALL_DOTS_RE = /^\.+$/;

type ParsedGithubPrUrl = { readonly owner: string; readonly repo: string; readonly num: string };

/**
 * Pure, synchronous, NETWORK-FREE parse of a GitHub PR URL. Single source of truth for "does this
 * URL match the shape `fetchOne` supports" — reused by `fetchOnePullRequest` (below) AND by
 * `githubFetchOneUrlIsSupported` (the targeted-fetch orchestrator's pre-check, `sync/targeted-fetch.ts`),
 * so the two can never disagree about which URLs are supported.
 */
function parseGithubPrUrl(url: string): ParsedGithubPrUrl | null {
  const m = GITHUB_PR_URL_RE.exec(url);
  if (m === null) {
    return null;
  }
  const owner = m[1] as string;
  const repo = m[2] as string;
  // `[\w.-]` legally captures `.`/`..`, which `pullDetailUrl`'s unencoded interpolation would let
  // traverse the API path (e.g. `repos/../secret/pulls/1` — the WHATWG URL parser normalizes away
  // the `repos/` prefix). Reject outright rather than sanitize: neither is a real owner or repo.
  if (ALL_DOTS_RE.test(owner) || ALL_DOTS_RE.test(repo)) {
    return null;
  }
  return { owner, repo, num: m[3] as string };
}

/**
 * Whether `parseGithubPrUrl` accepts `url` — i.e. whether `fetchOne` would make an outbound
 * request for it. `sync/targeted-fetch.ts` calls this BEFORE appending an egress row, so a URL
 * shape `fetchOne` would decline (e.g. a PR's "Files changed" tab, `/pull/7/files`) never
 * ledgers an `authorized` row for a call that provably never left the machine (I29 Critical 2).
 */
export function githubFetchOneUrlIsSupported(url: string): boolean {
  return parseGithubPrUrl(url) !== null;
}

/**
 * Fetch and index ONE GitHub PR by its web URL. See `Syncable.fetchOne` for the contract: no
 * rate-limiter call, no egress append, no host-boundary check — those belong to the orchestrator
 * that calls this. This function's job is parse → call → map → upsert → return.
 */
async function fetchOnePullRequest(ctx: SyncContext, url: string): Promise<FetchOneResult> {
  const parsedUrl = parseGithubPrUrl(url);
  if (parsedUrl === null) {
    return { status: "unsupported_url" };
  }
  const { owner, repo, num: requestedNum } = parsedUrl;
  const pat = await readConnectorSecret(ctx.vault, "github", "pat");
  if (pat === null || pat === "") {
    return { status: "not_found", reason: "no_credential" };
  }
  const repoFull = `${owner}/${repo}`;
  let res: Response;
  try {
    res = await fetch(pullDetailUrl(repoFull, Number.parseInt(requestedNum, 10)), {
      headers: buildGithubEventHeaders(pat, null),
      // Bounds this single-item fetch so `POST /v1/items/fetch` can never hang on a stalled
      // upstream response (see `FETCH_ONE_TIMEOUT_MS`'s doc comment in `sync/types.ts`). Covers
      // the body read below too — an abort mid-stream rejects `res.text()`, caught by the same
      // handler.
      signal: AbortSignal.timeout(FETCH_ONE_TIMEOUT_MS),
    });
  } catch {
    // A DNS/TLS/connect failure can carry the request URL in its message. Swallow it entirely
    // rather than let it propagate — mirrors gitlab-sync.ts/jenkins-sync.ts/jira-sync.ts, whose
    // fetchOne already reports not_found (never a 500) for the same offline condition.
    return { status: "not_found", reason: "unreachable" };
  }
  if (!res.ok) {
    return fetchOneMissForResponse(res.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text()) as unknown;
  } catch {
    return { status: "not_found", reason: "upstream_error" };
  }
  const pr = asRecord(parsed);
  if (pr === undefined) {
    return { status: "not_found", reason: "upstream_error" };
  }
  // The returned itemId MUST reflect the row `upsertPr` actually wrote, which keys off the API
  // response's own `number` field (normalized, e.g. `007` -> `7`) — never the raw regex capture
  // from the caller's URL, which can differ from it (leading zeros, etc.).
  const num = numberField(pr, "number");
  if (num === undefined) {
    return { status: "not_found", reason: "upstream_error" };
  }
  upsertPr(ctx, repoFull, pr, Date.now(), url);
  return {
    status: "indexed",
    itemId: itemPrimaryKey(SERVICE_ID, githubPrExternalId(repoFull, num)),
  };
}

export type GithubSyncableOptions = {
  ensureGithubMcpRunning: () => Promise<void>;
};

export function createGithubSyncable(options: GithubSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGithubMcpRunning();
      const pat = await readConnectorSecret(ctx.vault, "github", "pat");
      if (pat === null || pat === "") {
        return syncNoopResult(cursor, t0);
      }

      return syncGithubUserEvents(ctx, cursor, pat, t0);
    },
    fetchOne: fetchOnePullRequest,
  };
}
