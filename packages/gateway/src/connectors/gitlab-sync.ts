import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import { stripTrailingSlashes } from "../string/strip-trailing-slashes.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "gitlab";
const CURSOR_PREFIX = "nimbus-glab1:";
const DEFAULT_API_BASE = "https://gitlab.com/api/v4";
const MAX_PAGES_PER_SYNC = 8;
const MAX_PIPELINE_PROJECTS_PER_SYNC = 15;

type GitlabSyncCursorV2 = {
  v: 2;
  after: string;
  page: number;
  pipelines: Record<string, number>;
};

function parsePipelineCursorMap(raw: unknown): Record<string, number> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = Math.floor(v);
    }
  }
  return out;
}

function encodeCursor(c: GitlabSyncCursorV2): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): GitlabSyncCursorV2 | null {
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
  const after = rec["after"];
  const page = rec["page"];
  if (typeof after !== "string" || after === "") {
    return null;
  }
  const p = typeof page === "number" && Number.isInteger(page) && page >= 1 ? page : 1;
  if (rec["v"] === 2) {
    return { v: 2, after, page: p, pipelines: parsePipelineCursorMap(rec["pipelines"]) };
  }
  return { v: 2, after, page: p, pipelines: {} };
}

function webOriginFromApiBase(apiBase: string): string {
  const u = stripTrailingSlashes(apiBase);
  if (u.endsWith("/api/v4")) {
    return u.slice(0, -"/api/v4".length);
  }
  return "https://gitlab.com";
}

type GitlabEventUpsertFields = {
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
};

function upsertFromMergeRequestEvent(f: GitlabEventUpsertFields): void {
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
  } = f;
  const externalId = `${pathWithNamespace}!${String(iid)}`;
  const encPath = encodeURIComponent(pathWithNamespace);
  const url = `${webOrigin}/${pathWithNamespace}/-/merge_requests/${String(iid)}`;
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
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "pr",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: "",
    url,
    canonicalUrl: `${webOrigin}/${encPath}/-/merge_requests/${String(iid)}`,
    modifiedAt: Number.isFinite(modified) ? modified : now,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
}

function upsertFromIssueEvent(f: GitlabEventUpsertFields): void {
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
  } = f;
  const externalId = `${pathWithNamespace}#${String(iid)}`;
  const encPath = encodeURIComponent(pathWithNamespace);
  const url = `${webOrigin}/${pathWithNamespace}/-/issues/${String(iid)}`;
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
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "issue",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: "",
    url,
    canonicalUrl: `${webOrigin}/${encPath}/-/issues/${String(iid)}`,
    modifiedAt: Number.isFinite(modified) ? modified : now,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
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

function normalisedApiBase(raw: string | null): string {
  if (raw === null || raw.trim() === "") {
    return DEFAULT_API_BASE;
  }
  return stripTrailingSlashes(raw);
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

type GitlabEventsPagesResult = {
  itemsUpserted: number;
  bytesTransferred: number;
  hasMore: boolean;
  cursorAfter: string;
  cursorPage: number;
  durationMs: number;
};

async function gitlabSyncEventsPages(
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

function listGitlabProjectsFromIndex(db: import("bun:sqlite").Database): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT json_extract(metadata, '$.project') AS p
       FROM item
       WHERE service = ?
         AND json_extract(metadata, '$.project') IS NOT NULL
         AND length(trim(json_extract(metadata, '$.project'))) > 0`,
    )
    .all(SERVICE_ID) as { p: string | null }[];
  const out: string[] = [];
  for (const r of rows) {
    const p = typeof r.p === "string" ? r.p.trim() : "";
    if (p !== "" && !out.includes(p)) {
      out.push(p);
    }
  }
  return out;
}

type GitlabPipelineItemUpsertResult =
  | { kind: "skip" }
  | { kind: "break" }
  | { kind: "upserted"; id: number };

function tryUpsertGitlabPipelineItem(
  ctx: SyncContext,
  item: unknown,
  path: string,
  lastSeen: number,
  floorMs: number,
  now: number,
  webOrigin: string,
): GitlabPipelineItemUpsertResult {
  const row = asRecord(item);
  if (row === undefined) {
    return { kind: "skip" };
  }
  const id = numberField(row, "id");
  if (id === undefined) {
    return { kind: "skip" };
  }
  if (id <= lastSeen) {
    return { kind: "break" };
  }
  const createdRaw = stringField(row, "created_at");
  const createdMs = createdRaw === undefined ? Number.NaN : Date.parse(createdRaw);
  if (Number.isFinite(createdMs) && createdMs < floorMs) {
    return { kind: "skip" };
  }
  const status = stringField(row, "status");
  const ref = stringField(row, "ref");
  const webUrl = stringField(row, "web_url");
  const duration = numberField(row, "duration");
  const sha = stringField(row, "sha");
  const titleBase =
    ref !== undefined && ref !== "" ? `Pipeline on ${ref}` : `Pipeline #${String(id)}`;
  const title = status !== undefined && status !== "" ? `${titleBase} — ${status}` : titleBase;
  const externalId = `${path}#pipeline-${String(id)}`;
  const modifiedAt = Number.isFinite(createdMs) ? createdMs : now;
  const linkUrl = webUrl ?? `${webOrigin}/${path}/-/pipelines/${String(id)}`;
  const meta: Record<string, unknown> = {
    project: path,
    pipelineId: id,
    status: status ?? null,
    ref: ref ?? null,
    duration: duration ?? null,
    sha: sha ?? null,
  };
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "ci_run",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: "",
    url: webUrl ?? null,
    canonicalUrl: linkUrl,
    modifiedAt,
    authorId: null,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
  return { kind: "upserted", id };
}

function applyGitlabPipelineArray(
  ctx: SyncContext,
  parsedRoot: unknown[],
  path: string,
  lastSeen: number,
  floorMs: number,
  now: number,
  webOrigin: string,
): { upserted: number; maxId: number } {
  let maxId = lastSeen;
  let upserted = 0;
  for (const item of parsedRoot) {
    const r = tryUpsertGitlabPipelineItem(ctx, item, path, lastSeen, floorMs, now, webOrigin);
    if (r.kind === "break") {
      break;
    }
    if (r.kind === "upserted") {
      upserted += 1;
      if (r.id > maxId) {
        maxId = r.id;
      }
    }
  }
  return { upserted, maxId };
}

type GitlabOneProjectPipelineSyncArgs = {
  ctx: SyncContext;
  pat: string;
  apiBase: string;
  webOrigin: string;
  path: string;
  lastSeen: number;
  floorMs: number;
  now: number;
};

async function syncGitlabPipelinesForOneProject(
  args: GitlabOneProjectPipelineSyncArgs,
): Promise<{ upserted: number; bytes: number; maxId: number }> {
  const { ctx, pat, apiBase, webOrigin, path, lastSeen, floorMs, now } = args;
  await ctx.rateLimiter.acquire("gitlab");
  const enc = encodeURIComponent(path);
  const u = new URL(`${apiBase}/projects/${enc}/pipelines`);
  u.searchParams.set("per_page", "25");
  u.searchParams.set("order_by", "id");
  u.searchParams.set("sort", "desc");
  const res = await fetch(u.toString(), {
    headers: { "PRIVATE-TOKEN": pat },
  });
  const text = await res.text();
  const bytes = text.length;
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    const sec = ra === null ? 60 : Number.parseInt(ra, 10);
    const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000;
    ctx.rateLimiter.penalise("gitlab", ms);
    ctx.logger.warn({ serviceId: SERVICE_ID, project: path }, "gitlab pipeline sync: rate limited");
    return { upserted: 0, bytes, maxId: lastSeen };
  }
  if (!res.ok) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, project: path, status: res.status },
      "gitlab pipeline sync: list failed",
    );
    return { upserted: 0, bytes, maxId: lastSeen };
  }
  let parsedRoot: unknown;
  try {
    parsedRoot = JSON.parse(text) as unknown;
  } catch {
    return { upserted: 0, bytes, maxId: lastSeen };
  }
  if (!Array.isArray(parsedRoot)) {
    return { upserted: 0, bytes, maxId: lastSeen };
  }
  const r = applyGitlabPipelineArray(ctx, parsedRoot, path, lastSeen, floorMs, now, webOrigin);
  return { upserted: r.upserted, bytes, maxId: r.maxId };
}

async function syncGitlabPipelinesForIndexedProjects(
  ctx: SyncContext,
  pat: string,
  apiBase: string,
  webOrigin: string,
  pipelineCursor: Record<string, number>,
  floorMs: number,
): Promise<{ upserted: number; bytes: number; pipelines: Record<string, number> }> {
  const projects = listGitlabProjectsFromIndex(ctx.db);
  const next: Record<string, number> = { ...pipelineCursor };
  let upserted = 0;
  let bytes = 0;
  const now = Date.now();
  let scanned = 0;
  for (const path of projects) {
    if (scanned >= MAX_PIPELINE_PROJECTS_PER_SYNC) {
      break;
    }
    scanned += 1;
    const lastSeen = next[path] ?? 0;
    const r = await syncGitlabPipelinesForOneProject({
      ctx,
      pat,
      apiBase,
      webOrigin,
      path,
      lastSeen,
      floorMs,
      now,
    });
    bytes += r.bytes;
    upserted += r.upserted;
    next[path] = r.maxId;
  }
  return { upserted, bytes, pipelines: next };
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
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGitlabMcpRunning();
      const pat = await readConnectorSecret(ctx.vault, "gitlab", "pat");
      if (pat === null || pat === "") {
        return syncNoopResult(cursor, t0);
      }

      const apiBase = normalisedApiBase(await readConnectorSecret(ctx.vault, "gitlab", "api_base"));
      const webOrigin = webOriginFromApiBase(apiBase);

      const prev = decodeCursor(cursor);
      const nowMs = Date.now();
      const initialAfter =
        prev === null
          ? new Date(nowMs - initialSyncDepthDays * 86_400_000).toISOString()
          : prev.after;
      const page = prev === null ? 1 : prev.page;
      const floorAfter = prev === null ? initialAfter : prev.after;
      const pipelinesIn = prev === null ? {} : prev.pipelines;
      const floorMs = nowMs - initialSyncDepthDays * 86_400_000;

      const ev = await gitlabSyncEventsPages(ctx, pat, apiBase, webOrigin, floorAfter, page, t0);
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
        cursor: encodeCursor({
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
