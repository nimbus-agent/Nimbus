import type { SyncContext } from "../../../sync/types.ts";
import { asRecord, numberField, stringField } from "../../unknown-record.ts";

const SERVICE_ID = "gitlab";
const MAX_PIPELINE_PROJECTS_PER_SYNC = 15;

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
  ctx.upsertItem({
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

export async function syncGitlabPipelinesForIndexedProjects(
  ctx: SyncContext,
  pat: string,
  apiBase: string,
  webOrigin: string,
  pipelineCursor: Record<string, number>,
  floorMs: number,
): Promise<{ upserted: number; bytes: number; pipelines: Record<string, number> }> {
  const projects = ctx.listIndexedMetadataValues(SERVICE_ID, "project");
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
