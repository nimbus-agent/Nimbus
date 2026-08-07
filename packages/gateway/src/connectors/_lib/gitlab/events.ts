import { upsertIndexedItemForSync } from "../../../index/item-store.ts";
import { resolvePersonForSync } from "../../../people/linker.ts";
import { stripTrailingSlashes } from "../../../string/strip-trailing-slashes.ts";
import type { SyncContext } from "../../../sync/types.ts";
import { asRecord, numberField, stringField } from "../../unknown-record.ts";

const SERVICE_ID = "gitlab";
const MAX_PAGES_PER_SYNC = 8;

export function webOriginFromApiBase(apiBase: string): string {
  const u = stripTrailingSlashes(apiBase);
  if (u.endsWith("/api/v4")) {
    return u.slice(0, -"/api/v4".length);
  }
  return "https://gitlab.com";
}

export function normalisedApiBase(raw: string | null): string {
  const DEFAULT_API_BASE = "https://gitlab.com/api/v4";
  if (raw === null || raw.trim() === "") {
    return DEFAULT_API_BASE;
  }
  return stripTrailingSlashes(raw);
}

export type GitlabEventUpsertFields = {
  ctx: SyncContext;
  pathWithNamespace: string;
  iid: number;
  title: string;
  actionName: string;
  createdAt: string;
  now: number;
  webOrigin: string;
  authorUsername: string | undefined;
  authorName: string | undefined;
  /**
   * The exact, unencoded browser URL a caller is fetching-one-by, when there is one. When
   * present, used VERBATIM for both `url` and `canonicalUrl` — it is already the exact URL that
   * `GET /v1/items/resolve` canonicalizes an incoming URL to, whereas the constructed fallback
   * below `encodeURIComponent`s the whole namespaced path (correctly, to defend the
   * `/projects/:id` request path against injection — see `gitlab-sync.ts`'s `ALL_DOTS_RE`
   * docstring), which makes it byte-different from the plain URL and therefore UNRESOLVABLE.
   *
   * MUST be sourced from the CALLER's own URL, never from anything the API response says (e.g.
   * GitLab's `web_url` field) — a remote-supplied string can be empty, can legitimately differ
   * from the caller's URL after a redirect (a renamed project's old path still 200s, but with the
   * project's CURRENT `web_url`), or could be used by a compromised/misconfigured GitLab to mint
   * a row at an arbitrary `resolve_key`. The periodic events sync has no caller URL to speak of
   * (it discovers items, it doesn't fetch one by URL), so `webUrl` stays undefined there and
   * behavior is unchanged.
   */
  webUrl?: string;
};

/**
 * The `<pathWithNamespace>!<iid>` external-id shape shared by `upsertFromMergeRequestEvent` and
 * `fetchOne` (`gitlab-sync.ts`). Both MUST derive this from the same source so the id `fetchOne`
 * returns can never diverge from the id the row was actually written under.
 */
export function gitlabMrExternalId(pathWithNamespace: string, iid: number): string {
  return `${pathWithNamespace}!${String(iid)}`;
}

/** The `<pathWithNamespace>#<iid>` external-id shape for GitLab issue events. */
function gitlabIssueExternalId(pathWithNamespace: string, iid: number): string {
  return `${pathWithNamespace}#${String(iid)}`;
}

type GitlabItemShape = {
  type: "pr" | "issue";
  externalId: (pathWithNamespace: string, iid: number) => string;
  urlSegment: string;
};

function upsertGitlabEventItem(f: GitlabEventUpsertFields, shape: GitlabItemShape): void {
  const {
    ctx,
    pathWithNamespace,
    iid,
    title,
    actionName,
    createdAt,
    now,
    webOrigin,
    authorUsername,
    authorName,
    webUrl,
  } = f;
  const externalId = shape.externalId(pathWithNamespace, iid);
  const encPath = encodeURIComponent(pathWithNamespace);
  const urlPath = `${shape.urlSegment}/${String(iid)}`;
  const modified = Date.parse(createdAt);
  const meta: Record<string, unknown> = {
    iid,
    project: pathWithNamespace,
    action: actionName,
  };
  const authorId =
    authorUsername !== undefined && authorUsername !== ""
      ? resolvePersonForSync(ctx.db, {
          gitlabLogin: authorUsername,
          displayName: authorName ?? authorUsername,
        })
      : null;
  const rawUrl = `${webOrigin}/${pathWithNamespace}/-/${urlPath}`;
  const canonicalFallback = `${webOrigin}/${encPath}/-/${urlPath}`;
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: shape.type,
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: "",
    url: webUrl ?? rawUrl,
    canonicalUrl: webUrl ?? canonicalFallback,
    modifiedAt: Number.isFinite(modified) ? modified : now,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
}

/**
 * Exported so `gitlab-sync.ts`'s `fetchOne` can index a single merge request through the exact
 * same write path the periodic events sync uses — same title clamp, same author resolution, same
 * external-id derivation (`gitlabMrExternalId`).
 */
export function upsertFromMergeRequestEvent(f: GitlabEventUpsertFields): void {
  upsertGitlabEventItem(f, {
    type: "pr",
    externalId: gitlabMrExternalId,
    urlSegment: "merge_requests",
  });
}

function upsertFromIssueEvent(f: GitlabEventUpsertFields): void {
  upsertGitlabEventItem(f, {
    type: "issue",
    externalId: gitlabIssueExternalId,
    urlSegment: "issues",
  });
}

function processEvent(
  ctx: SyncContext,
  ev: Record<string, unknown>,
  now: number,
  webOrigin: string,
): boolean {
  const targetType = stringField(ev, "target_type");
  const targetIid = numberField(ev, "target_iid");
  const title = stringField(ev, "target_title") ?? "(no title)";
  const actionName = stringField(ev, "action_name") ?? "unknown";
  const createdAt = stringField(ev, "created_at") ?? new Date(now).toISOString();
  const authorUsername = stringField(ev, "author_username");
  const authorName = stringField(ev, "author_name");
  const project = asRecord(ev["project"]);
  const pathWithNamespace =
    project === undefined ? undefined : stringField(project, "path_with_namespace");
  if (pathWithNamespace !== undefined && pathWithNamespace !== "" && targetIid !== undefined) {
    if (targetType === "MergeRequest") {
      upsertFromMergeRequestEvent({
        ctx,
        pathWithNamespace,
        iid: targetIid,
        title,
        actionName,
        createdAt,
        now,
        webOrigin,
        authorUsername,
        authorName,
      });
      return true;
    }
    if (targetType === "Issue") {
      upsertFromIssueEvent({
        ctx,
        pathWithNamespace,
        iid: targetIid,
        title,
        actionName,
        createdAt,
        now,
        webOrigin,
        authorUsername,
        authorName,
      });
      return true;
    }
  }
  return false;
}

type GitlabFetchedEventsPage = {
  items: unknown[];
  textLength: number;
  res: Response;
};

async function gitlabFetchEventsPage(
  ctx: SyncContext,
  pat: string,
  apiBase: string,
  floorAfter: string,
  page: number,
): Promise<GitlabFetchedEventsPage> {
  await ctx.rateLimiter.acquire("gitlab");
  const u = new URL(`${apiBase}/events`);
  u.searchParams.set("after", floorAfter);
  u.searchParams.set("sort", "asc");
  u.searchParams.set("per_page", "100");
  u.searchParams.set("page", String(page));
  const res = await fetch(u.toString(), {
    headers: { "PRIVATE-TOKEN": pat },
  });
  const text = await res.text();
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    const sec = ra === null ? 60 : Number.parseInt(ra, 10);
    const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000;
    ctx.rateLimiter.penalise("gitlab", ms);
    throw new Error(`GitLab events 429: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`GitLab events ${String(res.status)}: ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("GitLab events: invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("GitLab events: expected array");
  }
  return { items: parsed, textLength: text.length, res };
}

function gitlabApplyEventsPage(
  ctx: SyncContext,
  items: unknown[],
  webOrigin: string,
  newestIso: string,
): { upsertedDelta: number; newestIso: string } {
  const now = Date.now();
  let nextNewest = newestIso;
  let upsertedDelta = 0;
  for (const item of items) {
    const ev = asRecord(item);
    if (ev === undefined) {
      continue;
    }
    const ca = stringField(ev, "created_at");
    if (ca !== undefined && ca > nextNewest) {
      nextNewest = ca;
    }
    if (processEvent(ctx, ev, now, webOrigin)) {
      upsertedDelta += 1;
    }
  }
  return { upsertedDelta, newestIso: nextNewest };
}

function gitlabShouldContinuePaging(
  res: Response,
  page: number,
  itemCount: number,
): { nextPage: number } | null {
  const nextPageRaw = res.headers.get("x-next-page");
  const hasNext =
    nextPageRaw !== null && nextPageRaw !== "" && itemCount > 0 && nextPageRaw !== String(page);
  if (!hasNext) {
    return null;
  }
  const np = Number.parseInt(nextPageRaw, 10);
  if (!Number.isFinite(np) || np <= 0) {
    return null;
  }
  return { nextPage: np };
}

export type GitlabEventsPagesResult = {
  itemsUpserted: number;
  bytesTransferred: number;
  hasMore: boolean;
  cursorAfter: string;
  cursorPage: number;
  durationMs: number;
};

export async function syncGitlabEventsPages(
  ctx: SyncContext,
  pat: string,
  apiBase: string,
  webOrigin: string,
  floorAfter: string,
  startPage: number,
  t0: number,
): Promise<GitlabEventsPagesResult> {
  let page = startPage;
  let upserted = 0;
  let bytesTransferred = 0;
  let newestIso = floorAfter;

  for (let pagesThisRun = 0; pagesThisRun < MAX_PAGES_PER_SYNC; pagesThisRun += 1) {
    const fetched = await gitlabFetchEventsPage(ctx, pat, apiBase, floorAfter, page);
    bytesTransferred += fetched.textLength;
    const applied = gitlabApplyEventsPage(ctx, fetched.items, webOrigin, newestIso);
    upserted += applied.upsertedDelta;
    newestIso = applied.newestIso;

    const cont = gitlabShouldContinuePaging(fetched.res, page, fetched.items.length);
    if (cont === null) {
      break;
    }
    page = cont.nextPage;
    if (pagesThisRun + 1 >= MAX_PAGES_PER_SYNC) {
      return {
        cursorAfter: floorAfter,
        cursorPage: page,
        itemsUpserted: upserted,
        bytesTransferred,
        hasMore: true,
        durationMs: Math.round(performance.now() - t0),
      };
    }
  }

  return {
    cursorAfter: newestIso,
    cursorPage: 1,
    itemsUpserted: upserted,
    bytesTransferred,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
  };
}
