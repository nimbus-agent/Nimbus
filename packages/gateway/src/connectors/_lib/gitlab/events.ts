import { itemPrimaryKey } from "../../../index/item-key.ts";
import { stripTrailingSlashes } from "../../../string/strip-trailing-slashes.ts";
import type { SyncContext } from "../../../sync/types.ts";
import {
  buildPrMetadata,
  canonicalEpochMs,
  gitlabEventTransition,
  normalizeGitlabMrState,
  type PrFields,
} from "../../pr-meta.ts";
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
  /**
   * The event's own `created_at`, VERBATIM — `undefined` when the event carried none. Never
   * substituted with the sync time: it becomes `opened_at_ms`/`merged_at`, where a guessed value
   * would be a false claim. Only the row's `modifiedAt` falls back to `now`.
   */
  createdAt: string | undefined;
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
  /**
   * The MR resource's own fields, present only on the `fetchOne` path (`gitlab-sync.ts`), where
   * the full merge request was fetched. The periodic events path has only the event.
   */
  mr?: {
    readonly state?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly mergedAt?: string | undefined;
  };
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

function storedPrFields(stored: Record<string, unknown> | null): PrFields {
  if (stored === null) {
    return {};
  }
  const st = stored["state"];
  const state =
    st === "open" || st === "merged" || st === "closed" || st === "unknown" ? st : undefined;
  const raw = stored["state_raw"];
  return {
    state,
    stateRaw: typeof raw === "string" ? raw : undefined,
    openedAtMs: canonicalEpochMs(stored["opened_at_ms"]),
    mergedAtMs: canonicalEpochMs(stored["merged_at"]),
  };
}

type MrAuthor = { readonly login: string; readonly name?: string | undefined };

function storedAuthor(stored: Record<string, unknown> | null): MrAuthor | undefined {
  if (stored === null) {
    return undefined;
  }
  const login = stored["author_login"];
  if (typeof login !== "string" || login === "") {
    return undefined;
  }
  const name = stored["author_name"];
  return { login, name: typeof name === "string" && name !== "" ? name : undefined };
}

function withAuthor(
  out: Record<string, unknown>,
  author: MrAuthor | undefined,
): Record<string, unknown> {
  if (author === undefined) {
    return out;
  }
  return {
    ...out,
    author_login: author.login,
    ...(author.name === undefined ? {} : { author_name: author.name }),
  };
}

/**
 * The full `pr` metadata for a GitLab MR row. `upsertIndexedItem` REPLACES metadata wholesale, so
 * every canonical key this event does not itself establish is carried from the stored row
 * (`stored`) — otherwise an `approved` event after a merge would erase the merge. An `opened`
 * event's own `created_at` IS the opening time and an `accepted`/`merged` event's IS the merge
 * time (events are fetched `sort=asc`, so a later transition always wins).
 */
export function gitlabMrMetadata(
  f: {
    readonly pathWithNamespace: string;
    readonly iid: number;
    readonly actionName: string;
    readonly eventCreatedAt: string | undefined;
    readonly mr?: GitlabEventUpsertFields["mr"];
    readonly author?: MrAuthor;
  },
  stored: Record<string, unknown> | null,
): Record<string, unknown> {
  const raw = { iid: f.iid, project: f.pathWithNamespace, action: f.actionName };
  const prior = storedPrFields(stored);
  const author = f.author ?? storedAuthor(stored);
  const finish = (out: Record<string, unknown>): Record<string, unknown> => withAuthor(out, author);
  if (f.mr !== undefined) {
    return finish(
      buildPrMetadata(raw, {
        state: normalizeGitlabMrState(f.mr.state) ?? prior.state,
        stateRaw: f.mr.state ?? prior.stateRaw,
        openedAtMs: canonicalEpochMs(f.mr.createdAt) ?? prior.openedAtMs,
        mergedAtMs: canonicalEpochMs(f.mr.mergedAt) ?? prior.mergedAtMs,
        repo: f.pathWithNamespace,
        number: f.iid,
      }),
    );
  }
  const transition = gitlabEventTransition(f.actionName);
  if (transition === null) {
    return finish(buildPrMetadata(raw, { ...prior, repo: f.pathWithNamespace, number: f.iid }));
  }
  const eventMs = canonicalEpochMs(f.eventCreatedAt);
  return finish(
    buildPrMetadata(raw, {
      state: transition,
      stateRaw: f.actionName,
      openedAtMs: f.actionName === "opened" ? (eventMs ?? prior.openedAtMs) : prior.openedAtMs,
      mergedAtMs: transition === "merged" ? (eventMs ?? prior.mergedAtMs) : undefined,
      repo: f.pathWithNamespace,
      number: f.iid,
    }),
  );
}

function readStoredMetadata(ctx: SyncContext, itemId: string): Record<string, unknown> | null {
  const json = ctx.itemMetadata(itemId);
  if (json === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return asRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

/**
 * The MR author is known only when THIS write describes the MR itself: the `opened` event (its
 * actor opened the MR) or `fetchOne` (the MR resource's own `author`). Every other event actor is
 * whoever approved, merged or commented — never credit them as the author.
 */
function knownMrAuthor(
  f: GitlabEventUpsertFields,
  shape: GitlabItemShape,
): { login: string; name: string | undefined } | undefined {
  if (shape.type !== "pr") return undefined;
  if (f.mr === undefined && f.actionName !== "opened") return undefined;
  if (f.authorUsername === undefined || f.authorUsername === "") return undefined;
  return { login: f.authorUsername, name: f.authorName === "" ? undefined : f.authorName };
}

/** A `pr` row is credited from its carried-forward metadata author; an issue from the event actor. */
function itemAuthor(
  shape: GitlabItemShape,
  meta: Record<string, unknown>,
  f: GitlabEventUpsertFields,
): { login: string | undefined; name: string | undefined } {
  if (shape.type !== "pr") return { login: f.authorUsername, name: f.authorName };
  const login = meta["author_login"];
  const name = meta["author_name"];
  return {
    login: typeof login === "string" ? login : undefined,
    name: typeof name === "string" ? name : undefined,
  };
}

function upsertGitlabEventItem(f: GitlabEventUpsertFields, shape: GitlabItemShape): void {
  const { ctx, pathWithNamespace, iid, title, actionName, createdAt, now, webOrigin, webUrl } = f;
  const externalId = shape.externalId(pathWithNamespace, iid);
  const encPath = encodeURIComponent(pathWithNamespace);
  const urlPath = `${shape.urlSegment}/${String(iid)}`;
  const modified = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  const knownAuthor = knownMrAuthor(f, shape);
  const meta: Record<string, unknown> =
    shape.type === "pr"
      ? gitlabMrMetadata(
          {
            pathWithNamespace,
            iid,
            actionName,
            eventCreatedAt: createdAt,
            ...(f.mr === undefined ? {} : { mr: f.mr }),
            ...(knownAuthor === undefined ? {} : { author: knownAuthor }),
          },
          readStoredMetadata(ctx, itemPrimaryKey(SERVICE_ID, externalId)),
        )
      : {
          iid,
          number: iid,
          project: pathWithNamespace,
          repo: pathWithNamespace,
          action: actionName,
        };
  const { login: authorLogin, name: authorDisplay } = itemAuthor(shape, meta, f);
  const authorId =
    authorLogin !== undefined && authorLogin !== ""
      ? ctx.resolvePerson({
          gitlabLogin: authorLogin,
          displayName: authorDisplay ?? authorLogin,
        })
      : null;
  const rawUrl = `${webOrigin}/${pathWithNamespace}/-/${urlPath}`;
  const canonicalFallback = `${webOrigin}/${encPath}/-/${urlPath}`;
  ctx.upsertItem({
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
  // No sync-time fallback here: `createdAt` feeds `opened_at_ms`/`merged_at`, and only the row's
  // `modifiedAt` (in `upsertGitlabEventItem`) may fall back to `now`.
  const createdAt = stringField(ev, "created_at");
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
