import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface BitriseMappedRow {
  readonly service: "bitrise";
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

export interface BitriseBuildMappingContext {
  readonly appSlug: string;
  readonly syncedAt: number;
}

function appCanonicalUrl(slug: string): string {
  return `https://app.bitrise.io/app/${slug}`;
}

function buildCanonicalUrl(buildSlug: string): string {
  return `https://app.bitrise.io/build/${buildSlug}`;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function pickBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function mapBitriseAppToItem(raw: unknown, syncedAt: number): BitriseMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const slug = stringField(row, "slug");
  if (slug === undefined || slug === "") {
    return null;
  }
  const title = stringField(row, "title") ?? slug;
  const projectType = stringField(row, "project_type") ?? null;
  const repoUrl = stringField(row, "repo_url") ?? null;
  const defaultBranch = stringField(row, "default_branch_name") ?? null;
  const isDisabled = pickBoolean(row["is_disabled"]);

  const metadata: Record<string, unknown> = {
    project_type: projectType,
    repo_url: repoUrl,
    default_branch: defaultBranch,
    is_disabled: isDisabled,
  };

  const canonicalUrl = appCanonicalUrl(slug);

  return {
    service: "bitrise",
    type: "app",
    externalId: slug,
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
  slug: string,
  buildNumber: number | undefined,
  workflow: string | undefined,
  branch: string | undefined,
): string {
  const parts: string[] = [];
  if (buildNumber !== undefined) {
    parts.push(`#${String(buildNumber)}`);
  }
  if (workflow !== undefined && workflow !== "") {
    parts.push(workflow);
  }
  if (branch !== undefined && branch !== "") {
    parts.push(`(${branch})`);
  }
  return parts.length === 0 ? slug : parts.join(" ");
}

export function mapBitriseBuildToItem(
  raw: unknown,
  ctx: BitriseBuildMappingContext,
): BitriseMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const slug = stringField(row, "slug");
  if (slug === undefined || slug === "") {
    return null;
  }
  const buildNumber = numberField(row, "build_number");
  const workflow = stringField(row, "triggered_workflow");
  const branch = stringField(row, "branch");
  const commitHash = stringField(row, "commit_hash") ?? null;
  const commitMessage = stringField(row, "commit_message") ?? null;
  const triggeredBy = stringField(row, "triggered_by") ?? null;
  const statusCode = numberField(row, "status") ?? null;
  const statusText = stringField(row, "status_text") ?? "unknown";
  const pullRequestId = numberField(row, "pull_request_id") ?? null;

  const triggeredAt = parseIsoMs(row["triggered_at"]);
  const startedAt = parseIsoMs(row["started_on_worker_at"]);
  const finishedAt = parseIsoMs(row["finished_at"]);
  const modifiedAt = finishedAt ?? startedAt ?? triggeredAt ?? ctx.syncedAt;
  const durationMs = startedAt !== null && finishedAt !== null ? finishedAt - startedAt : null;

  const metadata: Record<string, unknown> = {
    app_slug: ctx.appSlug,
    status: statusText,
    status_code: statusCode,
    workflow_id: workflow ?? null,
    branch: branch ?? null,
    commit_hash: commitHash,
    commit_message: commitMessage,
    triggered_by: triggeredBy,
    pull_request_id: pullRequestId,
    triggered_at: triggeredAt,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
  };

  const canonicalUrl = buildCanonicalUrl(slug);
  const title = buildTitle(slug, buildNumber, workflow, branch);

  return {
    service: "bitrise",
    type: "build",
    externalId: `${ctx.appSlug}/${slug}`,
    title,
    bodyPreview: commitMessage ?? title,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
