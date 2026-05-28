import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface RunSummary {
  readonly run_id: number | null;
  readonly life_cycle_state: string | null;
  readonly result_state: string | null;
  readonly start_time: number | null;
  readonly run_duration: number | null;
  readonly creator_user_name: string | null;
  readonly cluster_id: string | null;
}

export interface DatabricksMappingContext {
  readonly host: string;
  readonly runsByJobId: Map<number, RunSummary>;
  readonly syncedAt: number;
}

export interface DatabricksMappedRow {
  readonly service: "databricks";
  readonly type: "data_pipeline";
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

export function jobUrl(host: string, jobId: number): string {
  return `${trimTrailingSlash(host)}/jobs/${String(jobId)}`;
}

function formatRunStatus(run: RunSummary): string {
  const life = run.life_cycle_state ?? "?";
  return run.result_state === null ? life : `${life}/${run.result_state}`;
}

export function mapDatabricksJobToItem(
  raw: unknown,
  ctx: DatabricksMappingContext,
): DatabricksMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const jobId = numberField(row, "job_id");
  if (jobId === undefined) {
    return null;
  }

  const settings = asRecord(row["settings"]) ?? {};
  const name = stringField(settings, "name");

  const creatorUserName = stringField(row, "creator_user_name") ?? null;

  const scheduleObj = asRecord(settings["schedule"]) ?? {};
  const scheduleCron = stringField(scheduleObj, "quartz_cron_expression") ?? null;

  const format = stringField(settings, "format") ?? null;
  const createdAt = numberField(row, "created_time") ?? null;

  const run = ctx.runsByJobId.get(jobId);
  const latestRunId = run?.run_id ?? null;
  const latestRunStatus = run !== undefined ? formatRunStatus(run) : null;
  const latestRunStartedAt = run?.start_time ?? null;
  const latestRunDurationMs = run?.run_duration ?? null;
  const latestRunClusterId = run?.cluster_id ?? null;
  const latestRunTriggeredBy = run?.creator_user_name ?? null;

  const canonicalUrl = jobUrl(ctx.host, jobId);
  const title = name !== undefined && name !== "" ? name : `Job ${String(jobId)}`;
  const bodyPreview = `${title} — ${latestRunStatus ?? "no runs"}`;
  const modifiedAt = latestRunStartedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    job_id: jobId,
    name: name ?? null,
    creator_user_name: creatorUserName,
    schedule_cron: scheduleCron,
    format,
    created_at: createdAt,
    latest_run_id: latestRunId,
    latest_run_status: latestRunStatus,
    latest_run_started_at: latestRunStartedAt,
    latest_run_duration_ms: latestRunDurationMs,
    latest_run_cluster_id: latestRunClusterId,
    latest_run_triggered_by: latestRunTriggeredBy,
    canonical_url: canonicalUrl,
  };

  return {
    service: "databricks",
    type: "data_pipeline",
    externalId: `job_${String(jobId)}`,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
