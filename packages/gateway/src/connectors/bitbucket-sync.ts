import { itemPrimaryKey, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import { PR_FILES_PAGE_SIZE, runPrFilePass } from "../prfiles/pr-file-fetch.ts";
import { mapBitbucketPrFiles } from "../prfiles/pr-file-mapping.ts";
import { plainTextFromHtml } from "../string/html-plain-text.ts";
import {
  FETCH_ONE_TIMEOUT_MS,
  type FetchOneResult,
  RateLimitError,
  retryAfterDateFromHeader,
  type Syncable,
  type SyncContext,
  type SyncResult,
  syncNoopResult,
} from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { fetchOneMissForResponse } from "./fetch-miss-reason.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "bitbucket";
const CURSOR_PREFIX = "nimbus-bbkt1:";
const API_ROOT = "https://api.bitbucket.org/2.0";

const MAX_REPOS_PER_SYNC = 3;
const MAX_PR_PAGES_PER_REPO = 6;
const MAX_REPO_LIST_PAGES_PER_SYNC = 1;

type BitbucketCursorV1 = {
  since: string;
  pendingRepos: string[];
  reposNext: string | null;
  activeRepo: string | null;
  prNext: string | null;
  repositoryPagesExhausted: boolean;
};

function encodeCursor(c: BitbucketCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): BitbucketCursorV1 | null {
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
  const since = rec["since"];
  if (typeof since !== "string" || since === "") {
    return null;
  }
  const pendingRepos = rec["pendingRepos"];
  const pending: string[] = [];
  if (Array.isArray(pendingRepos)) {
    for (const x of pendingRepos) {
      if (typeof x === "string" && x.includes("/")) {
        pending.push(x);
      }
    }
  }
  const reposNext = rec["reposNext"];
  const activeRepo = rec["activeRepo"];
  const prNext = rec["prNext"];
  const repositoryPagesExhausted = rec["repositoryPagesExhausted"] === true;
  return {
    since,
    pendingRepos: pending,
    reposNext: typeof reposNext === "string" ? reposNext : null,
    activeRepo: typeof activeRepo === "string" ? activeRepo : null,
    prNext: typeof prNext === "string" ? prNext : null,
    repositoryPagesExhausted,
  };
}

function basicAuthHeader(user: string, pass: string): string {
  const b = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${b}`;
}

function htmlHref(rec: Record<string, unknown>): string | null {
  const links = asRecord(rec["links"]);
  if (links === undefined) {
    return null;
  }
  const html = asRecord(links["html"]);
  if (html === undefined) {
    return null;
  }
  return stringField(html, "href") ?? null;
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

function normalizeBitbucketUserUuid(raw: string): string {
  return raw
    .replaceAll(/^\{|\}$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * The `<repoFull>#<id>` external-id shape shared by `upsertFromPullRequest` and `fetchOne`. Both
 * MUST derive this from the same source — the API response's own `id` field — so the id
 * `fetchOne` returns can never diverge from the id the row was actually written under (e.g. a
 * caller URL's `/pull-requests/007` vs. the API's normalized `id: 7`).
 */
function bitbucketPrExternalId(repoFull: string, id: number): string {
  return `${repoFull}#${String(id)}`;
}

function upsertFromPullRequest(
  ctx: SyncContext,
  repoFull: string,
  pr: Record<string, unknown>,
  now: number,
  /**
   * The exact, unencoded browser URL a caller is fetching-one-by, when there is one. Used
   * VERBATIM for both `url` and `canonicalUrl` in place of the API's own `links.html.href` —
   * mirrors `_lib/gitlab/events.ts`'s `GitlabEventUpsertFields.webUrl` exactly.
   *
   * MUST be sourced from the CALLER's own URL, never from anything the API response says: the
   * response's `links.html.href` can legitimately differ from the caller's URL after a repo
   * rename, or be absent entirely, either of which would otherwise leave `resolve_key` wrong or
   * NULL. The periodic sync has no caller URL, so `webUrl` stays undefined there and its rows
   * are byte-identical to before this fix.
   */
  webUrl?: string,
): boolean {
  const id = numberField(pr, "id");
  if (id === undefined) {
    return false;
  }
  const title = stringField(pr, "title") ?? `PR #${String(id)}`;
  const desc = stringField(pr, "description") ?? "";
  const updatedOn = stringField(pr, "updated_on");
  const modified = updatedOn === undefined ? now : Date.parse(updatedOn);
  const state = stringField(pr, "state");
  const url = webUrl ?? htmlHref(pr);
  const author = asRecord(pr["author"]);
  const displayName = author === undefined ? undefined : stringField(author, "display_name");
  const uuidRaw = author === undefined ? undefined : stringField(author, "uuid");
  const bbUuid =
    uuidRaw !== undefined && uuidRaw !== "" ? normalizeBitbucketUserUuid(uuidRaw) : undefined;
  const authorId =
    bbUuid !== undefined && bbUuid !== ""
      ? resolvePersonForSync(ctx.db, {
          bitbucketUuid: bbUuid,
          displayName: displayName ?? bbUuid,
        })
      : null;
  const meta: Record<string, unknown> = {
    id,
    repo: repoFull,
    state,
    author: displayName,
  };
  const externalId = bitbucketPrExternalId(repoFull, id);
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "pr",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    body: plainTextFromHtml(desc),
    url,
    canonicalUrl: url,
    modifiedAt: Number.isFinite(modified) ? modified : now,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
  return true;
}

function parseRepositoryFullNames(body: unknown): string[] {
  const rec = asRecord(body);
  if (rec === undefined) {
    return [];
  }
  const values = rec["values"];
  if (!Array.isArray(values)) {
    return [];
  }
  const out: string[] = [];
  for (const v of values) {
    const r = asRecord(v);
    const fn = r === undefined ? undefined : stringField(r, "full_name");
    if (fn?.includes("/")) {
      out.push(fn);
    }
  }
  return out;
}

function stringFieldFromBody(body: unknown, key: string): string | undefined {
  const r = asRecord(body);
  return r === undefined ? undefined : stringField(r, key);
}

type BitbucketPrPageIngest = {
  maxUpdated: string;
  upsertedDelta: number;
  nextPrUrl: string | null;
};

function ingestBitbucketPullRequestPage(
  ctx: SyncContext,
  repoFull: string,
  json: unknown,
  now: number,
  priorMaxUpdated: string,
): BitbucketPrPageIngest {
  const rec = asRecord(json);
  const values = rec !== undefined && Array.isArray(rec["values"]) ? rec["values"] : [];
  let maxUpdated = priorMaxUpdated;
  let upsertedDelta = 0;
  for (const v of values) {
    const pr = asRecord(v);
    if (pr === undefined) {
      continue;
    }
    const uo = stringField(pr, "updated_on");
    if (uo !== undefined) {
      maxUpdated = maxIso(maxUpdated, uo);
    }
    if (upsertFromPullRequest(ctx, repoFull, pr, now)) {
      upsertedDelta += 1;
    }
  }
  const next = stringFieldFromBody(json, "next");
  const nextPrUrl = next !== undefined && next !== "" ? next : null;
  return { maxUpdated, upsertedDelta, nextPrUrl };
}

/**
 * `https://<host>/<workspace>/<repo>/pull-requests/<n>` — the only shape targeted fetch supports.
 *
 * Anchored at both ends and every quantifier bounded: the caller-supplied URL reaches an API
 * path, so a permissive pattern here is a request-forgery surface, not a convenience.
 */
const BITBUCKET_PR_URL_RE =
  /^https?:\/\/[^/]+\/([\w.-]{1,100})\/([\w.-]{1,100})\/pull-requests\/(\d{1,10})$/;

/** A capture that is entirely dots (`.`, `..`, `...`) is a path-traversal segment, not a name. */
const ALL_DOTS_RE = /^\.+$/;

type ParsedBitbucketPrUrl = {
  readonly workspace: string;
  readonly repoSlug: string;
  readonly num: string;
};

/**
 * Pure, synchronous, NETWORK-FREE parse of a Bitbucket PR URL. Single source of truth for "does
 * this URL match the shape `fetchOne` supports" — reused by `fetchOnePullRequest` (below) AND by
 * `bitbucketFetchOneUrlIsSupported` (the targeted-fetch orchestrator's pre-check,
 * `sync/targeted-fetch.ts`), so the two can never disagree about which URLs are supported.
 */
function parseBitbucketPrUrl(url: string): ParsedBitbucketPrUrl | null {
  const m = BITBUCKET_PR_URL_RE.exec(url);
  if (m === null) {
    return null;
  }
  const workspace = m[1] as string;
  const repoSlug = m[2] as string;
  // `[\w.-]` legally captures `.`/`..`; `encodeURIComponent` does NOT save us here — dot is
  // unreserved, so `encodeURIComponent("..") === ".."` and the traversal survives encoding
  // unchanged. Reject outright rather than sanitize: neither is a real workspace or repo slug.
  if (ALL_DOTS_RE.test(workspace) || ALL_DOTS_RE.test(repoSlug)) {
    return null;
  }
  return { workspace, repoSlug, num: m[3] as string };
}

/**
 * Whether `parseBitbucketPrUrl` accepts `url` — i.e. whether `fetchOne` would make an outbound
 * request for it. `sync/targeted-fetch.ts` calls this BEFORE appending an egress row, so a URL
 * shape `fetchOne` would decline never ledgers an `authorized` row for a call that provably never
 * left the machine (I29 Critical 2).
 */
export function bitbucketFetchOneUrlIsSupported(url: string): boolean {
  return parseBitbucketPrUrl(url) !== null;
}

/**
 * Fetch and index ONE Bitbucket PR by its web URL. See `Syncable.fetchOne` for the contract: no
 * rate-limiter call, no egress append, no host-boundary check — those belong to the orchestrator
 * that calls this. This function's job is parse → call → map → upsert → return.
 */
async function fetchOnePullRequest(ctx: SyncContext, url: string): Promise<FetchOneResult> {
  const parsedUrl = parseBitbucketPrUrl(url);
  if (parsedUrl === null) {
    return { status: "unsupported_url" };
  }
  const { workspace, repoSlug, num: requestedNum } = parsedUrl;
  const user = await readConnectorSecret(ctx.vault, "bitbucket", "username");
  const pass = await readConnectorSecret(ctx.vault, "bitbucket", "app_password");
  if (user === null || user === "" || pass === null || pass === "") {
    return { status: "not_found", reason: "no_credential" };
  }
  const repoFull = `${workspace}/${repoSlug}`;
  const detailUrl = `${API_ROOT}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${requestedNum}`;
  let res: Response;
  try {
    res = await fetch(detailUrl, {
      headers: { Authorization: basicAuthHeader(user, pass), Accept: "application/json" },
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
  // The returned itemId MUST reflect the row `upsertFromPullRequest` actually wrote, which keys
  // off the API response's own `id` field (normalized, e.g. `007` -> `7`) — never the raw regex
  // capture from the caller's URL, which can differ from it (leading zeros, etc.).
  const id = numberField(pr, "id");
  if (id === undefined) {
    return { status: "not_found", reason: "upstream_error" };
  }
  upsertFromPullRequest(ctx, repoFull, pr, Date.now(), url);
  return {
    status: "indexed",
    itemId: itemPrimaryKey(SERVICE_ID, bitbucketPrExternalId(repoFull, id)),
  };
}

/**
 * `/repositories/:workspace/:repo_slug/pullrequests/:id/diffstat` — Bitbucket's PR file-diff
 * endpoint. `pagelen` is Bitbucket's own page-size parameter (GitHub/GitLab both call theirs
 * `per_page`).
 */
export function prDiffstatUrl(repoFull: string, id: number, page: number): string {
  const segments = repoFull.split("/");
  const workspace = segments[0] ?? "";
  const repoSlug = segments.slice(1).join("/");
  return `${API_ROOT}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
    repoSlug,
  )}/pullrequests/${String(id)}/diffstat?pagelen=${String(PR_FILES_PAGE_SIZE)}&page=${String(page)}`;
}

/**
 * Bitbucket paginates via a `next` URL in the envelope rather than a full-length page — a short
 * final page can still carry `pagelen` items when the total is an exact multiple, so a length
 * check would be wrong in both directions. Extracted so the pagination signal is testable in
 * isolation from the network.
 */
export function bitbucketDiffstatHasMore(payload: unknown): boolean {
  const rec = asRecord(payload);
  return typeof rec?.["next"] === "string";
}

/**
 * Mirrors `github-sync.ts`'s `runPrFilePassBestEffort` exactly — same try/catch, same rethrow of
 * `RateLimitError`, same warn. Bitbucket PRs key as `<repoFull>#<id>`, so the id is parsed from
 * after the LAST `#`.
 */
async function runBitbucketPrFilePassBestEffort(
  ctx: SyncContext,
  auth: string,
  now: number,
): Promise<void> {
  try {
    await runPrFilePass(ctx, {
      service: SERVICE_ID,
      nowMs: now,
      fetchPage: async (c, page) => {
        const cut = c.externalId.lastIndexOf("#");
        if (cut < 0) return null;
        const id = Number(c.externalId.slice(cut + 1));
        if (!Number.isFinite(id)) return null;
        const res = await fetch(prDiffstatUrl(c.repoFull, id, page), {
          headers: { Authorization: auth, Accept: "application/json" },
        });
        if (res.status === 429) {
          const retryAt = retryAfterDateFromHeader(res.headers.get("retry-after"), 60);
          ctx.rateLimiter.penalise("bitbucket", Math.max(1000, retryAt.getTime() - Date.now()));
          throw new RateLimitError(retryAt, "Bitbucket PR diffstat: rate limited (429)");
        }
        if (!res.ok) {
          return null;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await res.text()) as unknown;
        } catch {
          return null;
        }
        const rows = mapBitbucketPrFiles(parsed);
        return { rows, hasMore: bitbucketDiffstatHasMore(parsed) };
      },
    });
  } catch (err) {
    if (err instanceof RateLimitError) throw err; // honor backoff
    ctx.logger.warn(
      { service: SERVICE_ID, err: String(err) },
      "PR changed-file pass failed (non-fatal)",
    );
  }
}

export type BitbucketSyncableOptions = {
  ensureBitbucketMcpRunning: () => Promise<void>;
};

export function createBitbucketSyncable(options: BitbucketSyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 60 * 1000,
    initialSyncDepthDays,
    fetchOne: fetchOnePullRequest,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureBitbucketMcpRunning();
      const user = await readConnectorSecret(ctx.vault, "bitbucket", "username");
      const pass = await readConnectorSecret(ctx.vault, "bitbucket", "app_password");
      if (user === null || user === "" || pass === null || pass === "") {
        return syncNoopResult(cursor, t0);
      }
      const auth = basicAuthHeader(user, pass);

      const syncStartedIso = new Date().toISOString();
      const prev = decodeCursor(cursor);
      const nowMs = Date.now();
      const defaultSince = new Date(nowMs - initialSyncDepthDays * 86_400_000).toISOString();

      let state: BitbucketCursorV1 =
        prev === null
          ? {
              since: defaultSince,
              pendingRepos: [],
              reposNext: null,
              activeRepo: null,
              prNext: null,
              repositoryPagesExhausted: false,
            }
          : {
              ...prev,
              repositoryPagesExhausted: prev.repositoryPagesExhausted === true,
            };

      let upserted = 0;
      let bytesTransferred = 0;
      let maxUpdated = state.since;
      let reposScannedThisSync = 0;

      // Returned by every exit below (all four `return syncResult(...)` sites), whose promise
      // `sync` adopts, so the changed-file pass runs on every tick regardless of which
      // pagination branch is hit — the same "run it on every exit" shape as `github-sync.ts`'s
      // two call sites (changed AND unchanged/304 paths).
      const syncResult = async (
        nextState: BitbucketCursorV1,
        hasMore: boolean,
      ): Promise<SyncResult> => {
        await runBitbucketPrFilePassBestEffort(ctx, auth, Date.now());
        return {
          cursor: encodeCursor(nextState),
          itemsUpserted: upserted,
          itemsDeleted: 0,
          hasMore,
          durationMs: Math.round(performance.now() - t0),
          bytesTransferred,
        };
      };

      const drainPenalty = (res: Response, text: string): void => {
        if (res.status === 429) {
          const ra = res.headers.get("retry-after");
          let sec: number;
          if (ra === null) {
            sec = 60;
          } else {
            sec = Number.parseInt(ra, 10);
          }
          const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000;
          ctx.rateLimiter.penalise("bitbucket", ms);
          throw new Error(`Bitbucket 429: ${text.slice(0, 200)}`);
        }
      };

      async function fetchJson(
        url: string,
      ): Promise<{ res: Response; text: string; json: unknown }> {
        await ctx.rateLimiter.acquire("bitbucket");
        const res = await fetch(url, {
          headers: { Authorization: auth, Accept: "application/json" },
        });
        const text = await res.text();
        bytesTransferred += text.length;
        drainPenalty(res, text);
        if (!res.ok) {
          throw new Error(`Bitbucket ${String(res.status)}: ${text.slice(0, 200)}`);
        }
        let json: unknown;
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          throw new Error("Bitbucket: invalid JSON");
        }
        return { res, text, json };
      }

      async function resumeActiveRepoPagination(): Promise<SyncResult | null> {
        if (state.activeRepo === null || state.prNext === null) {
          return null;
        }
        let prUrl: string | null = state.prNext;
        let prPages = 0;
        const active = state.activeRepo;
        while (prUrl !== null && prPages < MAX_PR_PAGES_PER_REPO) {
          const { json } = await fetchJson(prUrl);
          prPages += 1;
          const now = Date.now();
          const page = ingestBitbucketPullRequestPage(ctx, active, json, now, maxUpdated);
          maxUpdated = page.maxUpdated;
          upserted += page.upsertedDelta;
          prUrl = page.nextPrUrl;
        }
        state = {
          ...state,
          prNext: prUrl,
          activeRepo: prUrl === null ? null : active,
        };
        if (state.prNext !== null || state.activeRepo !== null) {
          return syncResult(state, true);
        }
        return null;
      }

      async function refillPendingReposFromWorkspace(): Promise<void> {
        let repoListPagesFetched = 0;
        while (
          state.pendingRepos.length === 0 &&
          repoListPagesFetched < MAX_REPO_LIST_PAGES_PER_SYNC
        ) {
          if (state.reposNext === null && state.repositoryPagesExhausted) {
            break;
          }
          const listUrl =
            state.reposNext ??
            `${API_ROOT}/repositories?${new URLSearchParams({ role: "member", pagelen: "30" })}`;
          const { json } = await fetchJson(listUrl);
          repoListPagesFetched += 1;
          const names = parseRepositoryFullNames(json);
          const nextLink = stringFieldFromBody(json, "next") ?? null;
          state = {
            ...state,
            pendingRepos: [...state.pendingRepos, ...names],
            reposNext: nextLink,
            repositoryPagesExhausted: nextLink === null,
          };
          if (nextLink === null) {
            break;
          }
        }
      }

      async function scanPullRequestsForPendingRepos(): Promise<SyncResult | null> {
        while (reposScannedThisSync < MAX_REPOS_PER_SYNC && state.pendingRepos.length > 0) {
          const repoFull = state.pendingRepos.shift();
          if (repoFull === undefined) {
            break;
          }
          reposScannedThisSync += 1;
          const segments = repoFull.split("/");
          const workspace = segments[0] ?? "";
          const repoSlug = segments.slice(1).join("/");
          if (workspace === "" || repoSlug === "") {
            continue;
          }
          const q = `updated_on>${state.since}`;
          const qs = new URLSearchParams();
          qs.set("pagelen", "50");
          qs.set("sort", "-updated_on");
          qs.set("q", q);
          const firstUrl = `${API_ROOT}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests?${qs.toString()}`;

          let prUrl: string | null = firstUrl;
          let prPages = 0;
          while (prUrl !== null && prPages < MAX_PR_PAGES_PER_REPO) {
            const { json } = await fetchJson(prUrl);
            prPages += 1;
            const now = Date.now();
            const page = ingestBitbucketPullRequestPage(ctx, repoFull, json, now, maxUpdated);
            maxUpdated = page.maxUpdated;
            upserted += page.upsertedDelta;
            prUrl = page.nextPrUrl;
            if (prUrl !== null && prPages >= MAX_PR_PAGES_PER_REPO) {
              state = {
                since: state.since,
                pendingRepos: state.pendingRepos,
                reposNext: state.reposNext,
                activeRepo: repoFull,
                prNext: prUrl,
                repositoryPagesExhausted: state.repositoryPagesExhausted,
              };
              return syncResult(state, true);
            }
          }
        }
        return null;
      }

      const resumed = await resumeActiveRepoPagination();
      if (resumed !== null) {
        return resumed;
      }

      await refillPendingReposFromWorkspace();

      const mid = await scanPullRequestsForPendingRepos();
      if (mid !== null) {
        return mid;
      }

      const cycleIncomplete =
        state.pendingRepos.length > 0 ||
        state.reposNext !== null ||
        !state.repositoryPagesExhausted;
      const advancedSince = maxIso(
        state.since,
        maxUpdated > state.since ? maxUpdated : syncStartedIso,
      );

      if (cycleIncomplete) {
        state = {
          since: state.since,
          pendingRepos: state.pendingRepos,
          reposNext: state.reposNext,
          activeRepo: null,
          prNext: null,
          repositoryPagesExhausted: state.repositoryPagesExhausted,
        };
        return syncResult(state, true);
      }

      state = {
        since: advancedSince,
        pendingRepos: [],
        reposNext: null,
        activeRepo: null,
        prNext: null,
        repositoryPagesExhausted: false,
      };

      return syncResult(state, false);
    },
  };
}
