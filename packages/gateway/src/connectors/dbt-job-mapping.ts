import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface DbtMappingContext {
  readonly apiBase: string;
  readonly accountId: number;
  readonly syncedAt: number;
}

export interface DbtMappedRow {
  readonly service: "dbt";
  readonly type: "job";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function mapState(value: unknown): string | null {
  if (value === 1) {
    return "active";
  }
  if (value === 2) {
    return "deleted";
  }
  return null;
}

export function jobUrl(
  apiBase: string,
  accountId: number,
  projectId: number | null,
  jobId: number,
): string {
  const base = trimTrailingSlash(apiBase);
  if (projectId === null) {
    return `${base}/deploy/${String(accountId)}`;
  }
  return `${base}/deploy/${String(accountId)}/projects/${String(projectId)}/jobs/${String(jobId)}`;
}

function readMostRecentRun(row: Record<string, unknown>): {
  status: string | null;
  finishedAtMs: number | null;
} {
  const run = asRecord(row["most_recent_run"]) ?? asRecord(row["most_recent_completed_run"]);
  if (run === undefined) {
    return { status: null, finishedAtMs: null };
  }
  return {
    status: stringField(run, "status_humanized") ?? null,
    finishedAtMs: parseIsoMs(run["finished_at"]),
  };
}

export function mapDbtJobToItem(raw: unknown, ctx: DbtMappingContext): DbtMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = numberField(row, "id");
  if (id === undefined) {
    return null;
  }

  const name = stringField(row, "name") ?? null;
  const projectId = numberField(row, "project_id") ?? null;
  const environmentId = numberField(row, "environment_id") ?? null;
  const dbtVersion = stringField(row, "dbt_version") ?? null;
  const state = mapState(row["state"]);

  const schedule = asRecord(row["schedule"]);
  const scheduleCron = schedule === undefined ? null : (stringField(schedule, "cron") ?? null);

  const triggers = asRecord(row["triggers"]) ?? null;

  const createdAtMs = parseIsoMs(row["created_at"]);
  const updatedAtMs = parseIsoMs(row["updated_at"]);

  const { status: mostRecentRunStatus, finishedAtMs: mostRecentRunFinishedAt } =
    readMostRecentRun(row);

  const canonicalUrl = jobUrl(ctx.apiBase, ctx.accountId, projectId, id);
  const title = name ?? `job ${String(id)}`;
  const bodyPreview = `${title} — ${mostRecentRunStatus ?? state ?? "?"}`;
  const modifiedAt = updatedAtMs ?? createdAtMs ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    job_id: id,
    name,
    account_id: ctx.accountId,
    project_id: projectId,
    environment_id: environmentId,
    dbt_version: dbtVersion,
    state,
    schedule_cron: scheduleCron,
    triggers,
    created_at: createdAtMs,
    updated_at: updatedAtMs,
    most_recent_run_status: mostRecentRunStatus,
    most_recent_run_finished_at: mostRecentRunFinishedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "dbt",
    type: "job",
    externalId: `${String(ctx.accountId)}:${String(id)}`,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
