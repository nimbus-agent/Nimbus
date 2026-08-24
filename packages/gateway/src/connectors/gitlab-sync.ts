import { itemPrimaryKey } from "../index/item-store.ts";
import { PR_FILES_PAGE_SIZE, runPrFilePass } from "../prfiles/pr-file-fetch.ts";
import { mapGitlabMrFiles } from "../prfiles/pr-file-mapping.ts";
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
import { decodeGitlabCursor, encodeGitlabCursor } from "./_lib/gitlab/cursor.ts";
import {
  gitlabMrExternalId,
  normalisedApiBase,
  syncGitlabEventsPages,
  upsertFromMergeRequestEvent,
  webOriginFromApiBase,
} from "./_lib/gitlab/events.ts";
import { syncGitlabPipelinesForIndexedProjects } from "./_lib/gitlab/pipelines.ts";
import { fetchOneMissForResponse } from "./fetch-miss-reason.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "gitlab";

/**
 * `https://<host>/<namespace/path>/-/merge_requests/<iid>` — the only shape targeted fetch
 * supports. The namespace can nest, so the path capture allows `/`; the `/-/` separator makes the
 * split unambiguous.
 *
 * Anchored at both ends and every quantifier bounded: the caller-supplied URL reaches an API
 * path, so a permissive pattern here is a request-forgery surface, not a convenience.
 */
export const GITLAB_MR_URL_RE =
  /^https?:\/\/[^/]+\/([\w./-]{1,200})\/-\/merge_requests\/(\d{1,10})$/;

/**
 * A capture that is entirely dots (`.`, `..`, `...`) is a path-traversal segment, not a
 * namespace path. This is the ONLY dot-traversal risk here: the whole captured path is
 * `encodeURIComponent`-ed as a single `/projects/:id` path parameter, so an internal `/../`
 * segment never reaches the wire as a literal `/../` (the surrounding `/` characters are
 * themselves encoded to `%2F`, so the URL parser never sees a bare `..` segment). The one case
 * that DOES reach the wire unescaped is when the ENTIRE capture is dots — `encodeURIComponent`
 * leaves `.` unescaped (it's an unreserved character), so `encodeURIComponent("..") === ".."`
 * and a bare `/projects/../merge_requests/7` results, which the URL parser normalizes away,
 * popping `/projects` out of the path.
 */
const ALL_DOTS_RE = /^\.+$/;

type ParsedGitlabMrUrl = { readonly pathWithNamespace: string; readonly iid: string };

/**
 * Pure, synchronous, NETWORK-FREE parse of a GitLab MR URL. Single source of truth for "does this
 * URL match the shape `fetchOne` supports" — reused by `fetchOneMergeRequest` (below) AND by
 * `gitlabFetchOneUrlIsSupported` (the targeted-fetch orchestrator's pre-check,
 * `sync/targeted-fetch.ts`), so the two can never disagree about which URLs are supported.
 */
function parseGitlabMrUrl(url: string): ParsedGitlabMrUrl | null {
  const m = GITLAB_MR_URL_RE.exec(url);
  if (m === null) {
    return null;
  }
  const pathWithNamespace = m[1] as string;
  if (ALL_DOTS_RE.test(pathWithNamespace)) {
    return null;
  }
  return { pathWithNamespace, iid: m[2] as string };
}

/**
 * Whether `parseGitlabMrUrl` accepts `url` — i.e. whether `fetchOne` would make an outbound
 * request for it. `sync/targeted-fetch.ts` calls this BEFORE appending an egress row, so a URL
 * shape `fetchOne` would decline never ledgers an `authorized` row for a call that provably never
 * left the machine (I29 Critical 2).
 */
export function gitlabFetchOneUrlIsSupported(url: string): boolean {
  return parseGitlabMrUrl(url) !== null;
}

/**
 * Fetch and index ONE GitLab merge request by its web URL. See `Syncable.fetchOne` for the
 * contract: no rate-limiter call, no egress append, no host-boundary check — those belong to the
 * orchestrator that calls this. This function's job is parse → call → map → upsert → return.
 *
 * Deliberately does NOT use `webOriginFromApiBase` — it returns the literal `"https://gitlab.com"`
 * for any input not ending in `/api/v4`, which would be wrong for a credentialed self-hosted
 * request. The web origin used to build the item's URL/canonical-URL instead comes straight off
 * the caller-supplied URL's own origin (it IS the real web origin, by construction).
 */
async function fetchOneMergeRequest(ctx: SyncContext, url: string): Promise<FetchOneResult> {
  const parsedUrl = parseGitlabMrUrl(url);
  if (parsedUrl === null) {
    return { status: "unsupported_url" };
  }
  const { pathWithNamespace, iid: requestedIid } = parsedUrl;
  const pat = await ctx.getSecret("pat");
  if (pat === null || pat === "") {
    return { status: "not_found", reason: "no_credential" };
  }
  const apiBase = normalisedApiBase(await ctx.getSecret("api_base"));
  const detailUrl = `${apiBase}/projects/${encodeURIComponent(pathWithNamespace)}/merge_requests/${requestedIid}`;
  let res: Response;
  try {
    // Bounds this single-item fetch so `POST /v1/items/fetch` can never hang on a stalled upstream
    // response (see `FETCH_ONE_TIMEOUT_MS`'s doc comment in `sync/types.ts`). Covers the body read
    // below too — an abort mid-stream rejects `res.text()`, caught by the same handler. This call
    // is NOT shared with the periodic sync — `_lib/gitlab/events.ts` and `_lib/gitlab/pipelines.ts`
    // each make their own separate `fetch` calls — so the periodic sync is unaffected.
    res = await fetch(detailUrl, {
      headers: { "PRIVATE-TOKEN": pat },
      signal: AbortSignal.timeout(FETCH_ONE_TIMEOUT_MS),
    });
  } catch {
    // A DNS/TLS/connect failure can carry the request URL — which embeds the Vault-stored
    // `api_base` — in its message. Swallow it entirely rather than let it propagate.
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
  const mr = asRecord(parsed);
  if (mr === undefined) {
    return { status: "not_found", reason: "upstream_error" };
  }
  // The returned itemId MUST reflect the row `upsertFromMergeRequestEvent` actually wrote, which
  // keys off the API response's own `iid` field — never the raw regex capture from the caller's
  // URL, which can differ from it (leading zeros, etc.).
  const iid = numberField(mr, "iid");
  if (iid === undefined) {
    return { status: "not_found", reason: "upstream_error" };
  }
  const webOrigin = new URL(url).origin;
  const author = asRecord(mr["author"]);
  const authorUsername = author === undefined ? undefined : stringField(author, "username");
  const authorName = author === undefined ? undefined : stringField(author, "name");
  const title = stringField(mr, "title") ?? `Merge request !${String(iid)}`;
  const modifiedIso =
    stringField(mr, "updated_at") ?? stringField(mr, "created_at") ?? new Date().toISOString();
  const actionName = stringField(mr, "state") ?? "unknown";
  // The CALLER's URL — never anything read off the response — is what becomes the canonical
  // URL/`resolve_key`. `upsertGitlabEventItem` otherwise `encodeURIComponent`s the whole
  // namespaced path into `canonicalUrl` (correctly, for the periodic-sync codepath which never
  // sets `webUrl`), which makes `resolve_key` byte-different from the plain caller URL and
  // therefore UNRESOLVABLE — that's the bug `webUrl` exists to fix. But the response's own
  // `web_url` is a REMOTE-SUPPLIED string: it can be empty (`stringField` returns `""`
  // verbatim, which is non-nullish and would win a `??`), it can legitimately differ from the
  // caller's URL after a GitLab redirect (a renamed project's old path 200s with the project's
  // CURRENT `web_url`), and a compromised/misconfigured GitLab could mint a row at an arbitrary
  // `resolve_key` — becoming the answer for an unrelated URL, or colliding with a legitimate one
  // to make `resolve` report `ambiguous`. The caller's `url` has none of those problems: it is
  // already anchored-regex-validated (so never empty, never `javascript:`-schemed) and IS the
  // browser URL being resolved.
  const webUrl = url;
  upsertFromMergeRequestEvent({
    ctx,
    pathWithNamespace,
    iid,
    title,
    actionName,
    createdAt: modifiedIso,
    now: Date.now(),
    webOrigin,
    authorUsername,
    authorName,
    webUrl,
  });
  return {
    status: "indexed",
    itemId: itemPrimaryKey(SERVICE_ID, gitlabMrExternalId(pathWithNamespace, iid)),
  };
}

/**
 * `/projects/:id/merge_requests/:iid/diffs` — GitLab's MR file-diff endpoint. Built from the
 * caller-supplied `apiBase` (never a hardcoded `gitlab.com` host), mirroring `fetchOneMergeRequest`'s
 * `detailUrl` above — GitLab is self-hostable, so the host cannot be assumed.
 */
export function mrDiffsUrl(
  apiBase: string,
  pathWithNamespace: string,
  iid: number,
  page: number,
): string {
  return `${apiBase}/projects/${encodeURIComponent(pathWithNamespace)}/merge_requests/${String(
    iid,
  )}/diffs?page=${String(page)}&per_page=${String(PR_FILES_PAGE_SIZE)}`;
}

/**
 * Mirrors `github-sync.ts`'s `runPrFilePassBestEffort` — same try/catch, same rethrow of
 * `RateLimitError`, same warn. GitLab MRs key as `<pathWithNamespace>!<iid>`, and a group path may
 * itself contain slashes, so the iid is parsed from AFTER the LAST `!`, not the first.
 *
 * It does NOT carry GitHub's `UnauthenticatedError` rethrow, and deliberately: no GitLab codepath
 * raises that error at all — this connector maps no status to a credential failure, so the closure
 * below returns `null` for a 401 like any other non-ok response. Adding the rethrow here would be
 * an unreachable branch, not a defence. Surfacing a GitLab 401 is a separate change: it would make
 * this best-effort side pass the connector's ONLY health signal for a revoked PAT, which is a
 * connector-health decision, not a changed-file one.
 */
async function runGitlabPrFilePassBestEffort(
  ctx: SyncContext,
  pat: string,
  apiBase: string,
  now: number,
): Promise<void> {
  try {
    await runPrFilePass(ctx, {
      service: SERVICE_ID,
      nowMs: now,
      fetchPage: async (c, page) => {
        const cut = c.externalId.lastIndexOf("!");
        if (cut < 0) return null;
        const iid = Number(c.externalId.slice(cut + 1));
        if (!Number.isFinite(iid)) return null;
        let res: Response;
        try {
          res = await fetch(mrDiffsUrl(apiBase, c.repoFull, iid, page), {
            headers: { "PRIVATE-TOKEN": pat },
          });
        } catch {
          // Same rule `fetchOneMergeRequest` states about itself at lines 116-120 of this file: a
          // DNS/TLS/connect rejection can carry the request URL — which embeds the Vault-stored
          // `api_base` — in its message, and `runPrFilePass`'s per-candidate catch logs
          // `err: String(err)`. Swallow it entirely rather than let it propagate.
          //
          // `null`, not a rethrow: it is the driver's existing "this page could not be read"
          // signal, so the MR is left with NO coverage row and `selectPrFileCandidates` re-queues
          // it next tick. The driver logs its own URL-free warn on this path.
          return null;
        }
        if (res.status === 429) {
          const retryAt = retryAfterDateFromHeader(res.headers.get("retry-after"), 60);
          ctx.rateLimiter.penalise("gitlab", Math.max(1000, retryAt.getTime() - Date.now()));
          throw new RateLimitError(retryAt, "GitLab MR diffs: rate limited (429)");
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
        const rows = mapGitlabMrFiles(parsed);
        // A full page means there may be another; a short page is the last one.
        return { rows, hasMore: Array.isArray(parsed) && parsed.length === PR_FILES_PAGE_SIZE };
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

export type GitlabSyncableOptions = {
  ensureGitlabMcpRunning: () => Promise<void>;
};

export function createGitlabSyncable(options: GitlabSyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 60 * 1000,
    initialSyncDepthDays,
    fetchOne: fetchOneMergeRequest,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGitlabMcpRunning();
      const pat = await ctx.getSecret("pat");
      if (pat === null || pat === "") {
        return syncNoopResult(cursor, t0);
      }

      const apiBase = normalisedApiBase(await ctx.getSecret("api_base"));
      const webOrigin = webOriginFromApiBase(apiBase);

      const prev = decodeGitlabCursor(cursor);
      const nowMs = Date.now();
      const initialAfter =
        prev === null
          ? new Date(nowMs - initialSyncDepthDays * 86_400_000).toISOString()
          : prev.after;
      const page = prev === null ? 1 : prev.page;
      const floorAfter = prev === null ? initialAfter : prev.after;
      const pipelinesIn = prev === null ? {} : prev.pipelines;
      const floorMs = nowMs - initialSyncDepthDays * 86_400_000;

      const ev = await syncGitlabEventsPages(ctx, pat, apiBase, webOrigin, floorAfter, page, t0);
      const pipe = await syncGitlabPipelinesForIndexedProjects(
        ctx,
        pat,
        apiBase,
        webOrigin,
        pipelinesIn,
        floorMs,
      );

      await runGitlabPrFilePassBestEffort(ctx, pat, apiBase, Date.now());

      const durationMs = Math.round(performance.now() - t0);
      return {
        cursor: encodeGitlabCursor({
          v: 2,
          after: ev.cursorAfter,
          page: ev.cursorPage,
          pipelines: pipe.pipelines,
        }),
        itemsUpserted: ev.itemsUpserted + pipe.upserted,
        itemsDeleted: 0,
        hasMore: ev.hasMore,
        durationMs,
        bytesTransferred: ev.bytesTransferred + pipe.bytes,
      };
    },
  };
}
