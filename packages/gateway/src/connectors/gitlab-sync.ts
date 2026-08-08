import { itemPrimaryKey } from "../index/item-store.ts";
import {
  FETCH_ONE_TIMEOUT_MS,
  type FetchOneResult,
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
import { readConnectorSecret } from "./connector-vault.ts";
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
  const pat = await readConnectorSecret(ctx.vault, "gitlab", "pat");
  if (pat === null || pat === "") {
    return { status: "not_found" };
  }
  const apiBase = normalisedApiBase(await readConnectorSecret(ctx.vault, "gitlab", "api_base"));
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
    return { status: "not_found" };
  }
  if (!res.ok) {
    return { status: "not_found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text()) as unknown;
  } catch {
    return { status: "not_found" };
  }
  const mr = asRecord(parsed);
  if (mr === undefined) {
    return { status: "not_found" };
  }
  // The returned itemId MUST reflect the row `upsertFromMergeRequestEvent` actually wrote, which
  // keys off the API response's own `iid` field — never the raw regex capture from the caller's
  // URL, which can differ from it (leading zeros, etc.).
  const iid = numberField(mr, "iid");
  if (iid === undefined) {
    return { status: "not_found" };
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
      const pat = await readConnectorSecret(ctx.vault, "gitlab", "pat");
      if (pat === null || pat === "") {
        return syncNoopResult(cursor, t0);
      }

      const apiBase = normalisedApiBase(await readConnectorSecret(ctx.vault, "gitlab", "api_base"));
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
