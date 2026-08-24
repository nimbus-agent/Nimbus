import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "github_actions";
const CURSOR_PREFIX = "nimbus-gha1:";

type GhaSyncCursorV1 = { repos: Record<string, number> };

function encodeCursor(c: GhaSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): GhaSyncCursorV1 | null {
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
  const reposRaw = rec["repos"];
  if (reposRaw === null || typeof reposRaw !== "object" || Array.isArray(reposRaw)) {
    return { repos: {} };
  }
  const repos: Record<string, number> = {};
  for (const [k, v] of Object.entries(reposRaw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      repos[k] = Math.floor(v);
    }
  }
  return { repos };
}

function applyGithubRateLimitPenaltyIfNeeded(ctx: SyncContext, res: Response): void {
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0" || remaining === null) {
      const retryAfter = res.headers.get("retry-after");
      const sec = retryAfter === null ? 60 : Number.parseInt(retryAfter, 10);
      const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000;
      ctx.rateLimiter.penalise("github", ms);
    }
  }
}

function splitOwnerRepo(full: string): { owner: string; repo: string } | null {
  const i = full.indexOf("/");
  if (i <= 0 || i >= full.length - 1) {
    return null;
  }
  return { owner: full.slice(0, i), repo: full.slice(i + 1) };
}

function buildGithubActionsRunTitle(
  display: string | undefined,
  name: string | undefined,
  id: number,
  conclusion: string | undefined,
  status: string | undefined,
): string {
  const titleBase = display ?? name ?? `Run ${String(id)}`;
  if (conclusion !== undefined && conclusion !== "") {
    return `${titleBase} — ${conclusion}`;
  }
  if (status !== undefined && status !== "") {
    return `${titleBase} (${status})`;
  }
  return titleBase;
}

function parseGithubWorkflowRunsArray(text: string): unknown[] | null {
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
  const wr = root["workflow_runs"];
  return Array.isArray(wr) ? wr : null;
}

function tryUpsertGithubActionsRun(
  ctx: SyncContext,
  full: string,
  item: unknown,
  lastSeen: number,
  floorMs: number,
  now: number,
): { upserted: 0 | 1; runId: number | null } {
  const run = asRecord(item);
  if (run === undefined) {
    return { upserted: 0, runId: null };
  }
  const id = numberField(run, "id");
  if (id === undefined || id <= lastSeen) {
    return { upserted: 0, runId: null };
  }
  const createdRaw = stringField(run, "created_at");
  const createdMs = createdRaw === undefined ? Number.NaN : Date.parse(createdRaw);
  if (Number.isFinite(createdMs) && createdMs < floorMs) {
    return { upserted: 0, runId: null };
  }
  const htmlUrl = stringField(run, "html_url");
  const name = stringField(run, "name");
  const display = stringField(run, "display_title");
  const conclusion = stringField(run, "conclusion");
  const status = stringField(run, "status");
  const event = stringField(run, "event");
  const headBranch = stringField(run, "head_branch");
  const headSha = stringField(run, "head_sha");
  const runStarted = stringField(run, "run_started_at");
  const updatedAt = stringField(run, "updated_at");
  const tEnd = updatedAt === undefined ? now : Date.parse(updatedAt);
  const tStart = runStarted === undefined ? tEnd : Date.parse(runStarted);
  const durationMs =
    Number.isFinite(tEnd) && Number.isFinite(tStart) && tEnd >= tStart ? tEnd - tStart : null;
  const title = buildGithubActionsRunTitle(display, name, id, conclusion, status);
  const externalId = `${full}#run-${String(id)}`;
  const modifiedAt = Number.isFinite(createdMs) ? createdMs : now;
  const meta: Record<string, unknown> = {
    workflowName: name ?? null,
    runId: id,
    event: event ?? null,
    conclusion: conclusion ?? null,
    headSha: headSha ?? null,
    headBranch: headBranch ?? null,
    durationMs,
    status: status ?? null,
  };
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "ci_run",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: "",
    url: htmlUrl ?? null,
    canonicalUrl: htmlUrl ?? null,
    modifiedAt,
    authorId: null,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
  return { upserted: 1, runId: id };
}

type GithubActionsRepoSyncArgs = {
  ctx: SyncContext;
  full: string;
  owner: string;
  repo: string;
  headers: Record<string, string>;
  lastSeen: number;
  floorMs: number;
  now: number;
};

async function syncGithubActionsForRepo(
  args: GithubActionsRepoSyncArgs,
): Promise<{ upserted: number; bytes: number; maxId: number }> {
  const { ctx, full, owner, repo, headers, lastSeen, floorMs, now } = args;
  await ctx.rateLimiter.acquire("github");
  const u = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`,
  );
  u.searchParams.set("per_page", "30");
  const res = await fetch(u.toString(), { headers });
  const text = await res.text();
  const bytes = text.length;
  applyGithubRateLimitPenaltyIfNeeded(ctx, res);
  if (!res.ok) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, repo: full, status: res.status },
      "github_actions sync: failed to list runs",
    );
    return { upserted: 0, bytes, maxId: lastSeen };
  }
  const wr = parseGithubWorkflowRunsArray(text);
  if (wr === null) {
    return { upserted: 0, bytes, maxId: lastSeen };
  }
  let maxId = lastSeen;
  let upserted = 0;
  for (const item of wr) {
    const r = tryUpsertGithubActionsRun(ctx, full, item, lastSeen, floorMs, now);
    upserted += r.upserted;
    if (r.runId !== null && r.runId > maxId) {
      maxId = r.runId;
    }
  }
  return { upserted, bytes, maxId };
}

export type GithubActionsSyncableOptions = {
  ensureGithubMcpRunning: () => Promise<void>;
};

export function createGithubActionsSyncable(options: GithubActionsSyncableOptions): Syncable {
  const initialSyncDepthDays = 14;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 60 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGithubMcpRunning();

      const pat = await ctx.getSharedSecret("github", "pat");
      if (pat === null || pat.trim() === "") {
        return syncNoopResult(cursor, t0);
      }

      const repos = ctx.listIndexedGithubRepos();
      if (repos.length === 0) {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor) ?? { repos: {} };
      const nextRepos: Record<string, number> = { ...prev.repos };
      let upserted = 0;
      let bytes = 0;
      const now = Date.now();
      const floorMs = now - initialSyncDepthDays * 86_400_000;

      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${pat.trim()}`,
      };

      for (const full of repos) {
        const parts = splitOwnerRepo(full);
        if (parts === null) {
          continue;
        }
        const lastSeen = nextRepos[full] ?? 0;
        const r = await syncGithubActionsForRepo({
          ctx,
          full,
          owner: parts.owner,
          repo: parts.repo,
          headers,
          lastSeen,
          floorMs,
          now,
        });
        bytes += r.bytes;
        upserted += r.upserted;
        nextRepos[full] = r.maxId;
      }

      return {
        cursor: encodeCursor({ repos: nextRepos }),
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: bytes,
      };
    },
  };
}
