import type { Database } from "bun:sqlite";

import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import type { PersonSyncHints } from "../people/person-types.ts";
import {
  RateLimitError,
  retryAfterDateFromHeader,
  type Syncable,
  type SyncContext,
  type SyncResult,
  syncNoopResult,
  UnauthenticatedError,
} from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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
  return `https://api.github.com/users/${encodeURIComponent(login)}/events?per_page=100`;
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

export function upsertPr(
  ctx: SyncContext,
  repoFull: string,
  pr: Record<string, unknown>,
  now: number,
): void {
  const num = numberField(pr, "number");
  if (num === undefined) {
    return;
  }
  const title = stringField(pr, "title") ?? `PR #${String(num)}`;
  const body = stringField(pr, "body");
  const htmlUrl = stringField(pr, "html_url");
  const modified = modifiedMsFromGithubTimestamps(pr, now);
  const user = asRecord(pr["user"]);
  const authorId = resolveGithubActorPersonId(ctx.db, user);
  const meta = extractPrMetadataForIndex(repoFull, pr, now);
  const externalId = `${repoFull}#${String(num)}`;
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "pr",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: (body ?? "").slice(0, 512),
    url: htmlUrl ?? null,
    canonicalUrl: htmlUrl ?? null,
    modifiedAt: modified,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
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
    bodyPreview: (body ?? "").slice(0, 512),
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

function processEvent(ctx: SyncContext, ev: Record<string, unknown>, now: number): boolean {
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

function throwGithubRateLimitErrorIfApplicable(
  ctx: SyncContext,
  res: Response,
  label: string,
): void {
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0" || remaining === null) {
      const retryAt = retryAfterDateFromHeader(res.headers.get("retry-after"), 60);
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

function selectFallbackPrCandidates(db: Database, limit: number): FallbackPrCandidate[] {
  const rows = db
    .query(
      `SELECT external_id, title FROM item
         WHERE service = 'github' AND type = 'pr' AND title LIKE 'PR #%'
         ORDER BY modified_at DESC LIMIT ?`,
    )
    .all(limit * 3) as { external_id: string; title: string }[]; // over-select; JS filter is exact
  const out: FallbackPrCandidate[] = [];
  for (const r of rows) {
    const hash = r.external_id.lastIndexOf("#");
    if (hash <= 0) continue;
    const repoFull = r.external_id.slice(0, hash);
    const num = Number.parseInt(r.external_id.slice(hash + 1), 10);
    if (!Number.isFinite(num)) continue;
    if (r.title !== `PR #${String(num)}`) continue; // exact fallback only
    out.push({ externalId: r.external_id, repoFull, num });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Re-fetches pull-request detail for any indexed `pr` row still carrying the
 * id-only `PR #<num>` fallback title (the GitHub events feed omits `title`
 * on `PullRequestEvent` payloads). Processes up to `MAX_ENRICH_PER_TICK`
 * rows, newest-first, sequentially through the shared rate limiter.
 */
export async function enrichFallbackPrTitles(
  ctx: SyncContext,
  pat: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const candidates = selectFallbackPrCandidates(ctx.db, MAX_ENRICH_PER_TICK);
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
  return enriched;
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

  // Best-effort title enrichment for fallback-titled PRs (existing rows + this tick's title-less events).
  try {
    await enrichFallbackPrTitles(ctx, pat, now);
  } catch (err) {
    if (err instanceof RateLimitError) throw err; // honor backoff
    ctx.logger.warn(
      { service: SERVICE_ID, err: String(err) },
      "PR title enrichment pass failed (non-fatal)",
    );
  }

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
  };
}
