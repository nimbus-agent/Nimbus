import { asRecord, stringField } from "./unknown-record.ts";

export interface CodemagicMappedRow {
  readonly service: "codemagic";
  readonly type: "app" | "build";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

export interface CodemagicBuildMappingContext {
  readonly appId: string;
  readonly syncedAt: number;
}

function appCanonicalUrl(id: string): string {
  return `https://codemagic.io/app/${id}`;
}

function buildCanonicalUrl(appId: string, buildId: string): string {
  return `https://codemagic.io/app/${appId}/build/${buildId}`;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push(entry);
    }
  }
  return out;
}

export function mapCodemagicAppToItem(raw: unknown, syncedAt: number): CodemagicMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = stringField(row, "_id");
  if (id === undefined || id === "") {
    return null;
  }
  const title = stringField(row, "appName") ?? id;
  const repository = asRecord(row["repository"]) ?? null;
  const workflowIds = stringList(row["workflowIds"]);
  const branches = stringList(row["branches"]);

  const metadata: Record<string, unknown> = {
    repository,
    workflow_ids: workflowIds,
    branches,
  };

  const canonicalUrl = appCanonicalUrl(id);

  return {
    service: "codemagic",
    type: "app",
    externalId: id,
    title,
    bodyPreview: title,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: syncedAt,
    metadata,
    syncedAt,
  };
}

function buildTitle(
  buildId: string,
  version: string | undefined,
  workflow: string | undefined,
  branch: string | undefined,
): string {
  const label = version !== undefined && version !== "" ? version : buildId.slice(0, 7);
  const parts: string[] = [`#${label}`];
  if (workflow !== undefined && workflow !== "") {
    parts.push(workflow);
  }
  if (branch !== undefined && branch !== "") {
    parts.push(`(${branch})`);
  }
  return parts.join(" ");
}

export function mapCodemagicBuildToItem(
  raw: unknown,
  ctx: CodemagicBuildMappingContext,
): CodemagicMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const buildId = stringField(row, "_id");
  if (buildId === undefined || buildId === "") {
    return null;
  }
  const workflow = stringField(row, "workflowId");
  const branch = stringField(row, "branch");
  const tag = stringField(row, "tag") ?? null;
  const version = stringField(row, "version");
  const status = stringField(row, "status") ?? "unknown";
  const message = stringField(row, "message") ?? null;
  const commit = asRecord(row["commit"]) ?? null;

  const startedAt = parseIsoMs(row["startedAt"]);
  const finishedAt = parseIsoMs(row["finishedAt"]);
  const modifiedAt = finishedAt ?? startedAt ?? ctx.syncedAt;
  const durationMs = startedAt !== null && finishedAt !== null ? finishedAt - startedAt : null;

  const metadata: Record<string, unknown> = {
    app_id: ctx.appId,
    status,
    workflow_id: workflow ?? null,
    branch: branch ?? null,
    tag,
    version: version ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    commit,
  };

  const canonicalUrl = buildCanonicalUrl(ctx.appId, buildId);
  const title = buildTitle(buildId, version, workflow, branch);

  return {
    service: "codemagic",
    type: "build",
    externalId: `${ctx.appId}/${buildId}`,
    title,
    bodyPreview: message ?? title,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
