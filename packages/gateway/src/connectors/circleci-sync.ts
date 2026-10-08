import { clampSyncTitle, syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { buildCiRunMetadata, normalizeCircleciPipelineState } from "./ci-run-meta.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "circleci";
const CURSOR_PREFIX = "nimbus-cci1:";

type CircleciSyncCursorV1 = { projects: Record<string, number> };

function encodeCursor(c: CircleciSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): CircleciSyncCursorV1 | null {
  const rec = decodeNimbusJsonCursorObject(raw, CURSOR_PREFIX);
  if (rec === null) {
    return null;
  }
  const projectsRaw = rec["projects"];
  if (projectsRaw === null || typeof projectsRaw !== "object" || Array.isArray(projectsRaw)) {
    return { projects: {} };
  }
  const projects: Record<string, number> = {};
  for (const [k, v] of Object.entries(projectsRaw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      projects[k] = Math.floor(v);
    }
  }
  return { projects };
}

function githubRepoToCircleProjectSlug(full: string): string | null {
  const i = full.indexOf("/");
  if (i <= 0 || i >= full.length - 1) {
    return null;
  }
  const owner = full.slice(0, i);
  const repo = full.slice(i + 1);
  return `gh/${owner}/${repo}`;
}

function circleciProjectPath(slug: string): string {
  return slug
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function appPipelineUrl(projectSlug: string, pipelineNumber: number): string | null {
  const parts = projectSlug.split("/").filter((s) => s.trim() !== "");
  if (parts.length < 3 || parts[0] !== "gh") {
    return null;
  }
  const owner = parts[1] ?? "";
  const repo = parts[2] ?? "";
  if (owner === "" || repo === "") {
    return null;
  }
  return `https://app.circleci.com/pipelines/github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${String(pipelineNumber)}`;
}

function parseCircleciPipelineItems(text: string): unknown[] | null {
  let parsedRoot: unknown;
  try {
    parsedRoot = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = asRecord(parsedRoot);
  if (root === undefined) {
    return null;
  }
  const items = root["items"];
  return Array.isArray(items) ? items : null;
}

function circleciPipelineCreatedMs(createdRaw: string | undefined): number {
  if (createdRaw === undefined) {
    return Number.NaN;
  }
  return Date.parse(createdRaw);
}

/**
 * The full `ci_run` metadata for one CircleCI pipeline. The pipeline `state` is a CREATION state,
 * not pass/fail (see `CI_RUN_NO_SUCCESS_SIGNAL`), so `conclusion` is `failure` for `errored` and
 * `unknown` otherwise. A tag pipeline has no branch: `vcs.tag` is kept as raw `tag` for display and
 * canonical `branch` is omitted (before the contract the tag was written AS the branch).
 */
export function circleciPipelineMetadata(
  githubRepoFull: string,
  projectSlug: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const state = stringField(row, "state");
  const vcs = asRecord(row["vcs"]);
  const branch = vcs === undefined ? undefined : stringField(vcs, "branch");
  const tag = vcs === undefined ? undefined : stringField(vcs, "tag");
  const revision = vcs === undefined ? undefined : stringField(vcs, "revision");
  const raw: Record<string, unknown> = {
    projectSlug,
    pipelineNumber: numberField(row, "number") ?? null,
    pipelineId: stringField(row, "id") ?? null,
    state: state ?? null,
    revision: revision ?? null,
    githubRepo: githubRepoFull,
    ...(tag === undefined || tag === "" ? {} : { tag }),
  };
  return buildCiRunMetadata(raw, {
    conclusion: normalizeCircleciPipelineState(state),
    conclusionRaw: state,
    branch,
    repo: githubRepoFull,
    headSha: revision,
  });
}

function tryUpsertCircleciPipeline(
  ctx: SyncContext,
  full: string,
  slug: string,
  item: unknown,
  lastSeen: number,
  floorMs: number,
  now: number,
): { upserted: 0 | 1; pipelineNum: number } {
  const row = asRecord(item);
  if (row === undefined) {
    return { upserted: 0, pipelineNum: lastSeen };
  }
  const num = numberField(row, "number");
  if (num === undefined || num <= lastSeen) {
    return { upserted: 0, pipelineNum: lastSeen };
  }
  const createdMs = circleciPipelineCreatedMs(stringField(row, "created_at"));
  if (Number.isFinite(createdMs) && createdMs < floorMs) {
    return { upserted: 0, pipelineNum: lastSeen };
  }
  const state = stringField(row, "state");
  const titleBase = `Pipeline #${String(num)}`;
  const title = state !== undefined && state !== "" ? `${titleBase} — ${state}` : titleBase;
  const externalId = `${slug}#p${String(num)}`;
  const modifiedAt = Number.isFinite(createdMs) ? createdMs : now;
  const htmlUrl = appPipelineUrl(slug, num);
  ctx.upsertItem({
    service: SERVICE_ID,
    type: "ci_run",
    externalId,
    title: clampSyncTitle(title),
    bodyPreview: "",
    url: htmlUrl,
    canonicalUrl: htmlUrl,
    modifiedAt,
    authorId: null,
    metadata: circleciPipelineMetadata(full, slug, row),
    pinned: false,
    syncedAt: now,
  });
  return { upserted: 1, pipelineNum: num };
}

/** What every project in one sync pass shares: the context, the API token and the time window. */
interface CircleciPass {
  readonly ctx: SyncContext;
  readonly token: string;
  readonly floorMs: number;
  readonly now: number;
}

async function syncCircleciProjectPipelines(
  pass: CircleciPass,
  full: string,
  slug: string,
  lastSeen: number,
): Promise<{ upserted: number; bytes: number; maxNum: number }> {
  const { ctx, token, floorMs, now } = pass;
  await ctx.rateLimiter.acquire("circleci");
  const path = `https://circleci.com/api/v2/project/${circleciProjectPath(slug)}/pipeline`;
  const res = await fetch(path, {
    headers: {
      Accept: "application/json",
      "Circle-Token": token,
    },
  });
  const text = await res.text();
  const bytes = text.length;
  if (!res.ok) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, projectSlug: slug, status: res.status },
      "circleci sync: failed to list pipelines",
    );
    return { upserted: 0, bytes, maxNum: lastSeen };
  }
  const items = parseCircleciPipelineItems(text);
  if (items === null) {
    return { upserted: 0, bytes, maxNum: lastSeen };
  }
  let maxNum = lastSeen;
  let upserted = 0;
  for (const item of items) {
    const r = tryUpsertCircleciPipeline(ctx, full, slug, item, lastSeen, floorMs, now);
    upserted += r.upserted;
    if (r.pipelineNum > maxNum) {
      maxNum = r.pipelineNum;
    }
  }
  return { upserted, bytes, maxNum };
}

export type CircleciSyncableOptions = {
  ensureCircleciMcpRunning: () => Promise<void>;
};

export function createCircleciSyncable(options: CircleciSyncableOptions): Syncable {
  const initialSyncDepthDays = 14;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 90 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureCircleciMcpRunning();

      const apiTok = await ctx.getSecret("api_token");
      if (apiTok === null || apiTok.trim() === "") {
        return syncNoopResult(cursor, t0);
      }

      const repos = ctx.listIndexedMetadataValues("github", "repo");
      if (repos.length === 0) {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor) ?? { projects: {} };
      const nextProjects: Record<string, number> = { ...prev.projects };
      let upserted = 0;
      let bytes = 0;
      const now = Date.now();
      const floorMs = now - initialSyncDepthDays * 86_400_000;
      const pass: CircleciPass = { ctx, token: apiTok.trim(), floorMs, now };

      for (const full of repos) {
        const slug = githubRepoToCircleProjectSlug(full);
        if (slug === null) {
          continue;
        }
        const lastSeen = nextProjects[slug] ?? 0;
        const r = await syncCircleciProjectPipelines(pass, full, slug, lastSeen); // NOSONAR S9382: one project at a time through the shared CircleCI rate limiter - the list is every indexed GitHub repo (uncapped), so Promise.all would be an unbounded burst
        bytes += r.bytes;
        upserted += r.upserted;
        nextProjects[slug] = r.maxNum;
      }

      return syncPassCursorSuccess(t0, bytes, encodeCursor({ projects: nextProjects }), upserted);
    },
  };
}
