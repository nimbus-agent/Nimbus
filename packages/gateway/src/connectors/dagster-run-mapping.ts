import {
  clampName,
  clampRunTitle,
  type DagRunOutcome,
  failedTaskNames,
  runDurationMs,
} from "./_lib/dag-run.ts";
import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type DagsterRunMappedRow = MappedRow<"dagster", "job_run">;

export interface DagsterRunContext {
  readonly baseUrl: string;
  readonly syncedAt: number;
}

function outcomeOf(status: string | null): DagRunOutcome {
  switch (status) {
    case "FAILURE":
      return "failed";
    case "SUCCESS":
      return "success";
    case "STARTING":
    case "STARTED":
    case "QUEUED":
    case "NOT_STARTED":
    case "MANAGED":
    case "CANCELING":
      return "running";
    default:
      return "other";
  }
}

/** Dagster times are Unix SECONDS as floats. */
function secondsToMs(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw * 1000) : null;
}

/** How the run began, from the tag KEYS only (a tag value is never read or kept). */
function triggerOf(tags: unknown): string {
  const keys = new Set<string>();
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const r = asRecord(t);
      const k = r === undefined ? undefined : stringField(r, "key");
      if (k !== undefined) keys.add(k);
    }
  }
  if (keys.has("dagster/schedule_name")) return "schedule";
  if (keys.has("dagster/sensor_name")) return "sensor";
  if (keys.has("dagster/backfill")) return "backfill";
  return "manual";
}

function failedSteps(stepStats: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(stepStats)) return out;
  for (const s of stepStats) {
    const r = asRecord(s);
    if (r === undefined || stringField(r, "status") !== "FAILURE") continue;
    const key = stringField(r, "stepKey");
    if (key !== undefined) out.push(key);
  }
  return out;
}

/**
 * One `runsOrError.results[]` entry as a `dagster:job_run` item. The parent is the job's own item id
 * (`dagster:<location>:<repository>:<job>`), or null when the run names no repository origin. The run
 * configuration, the error and the tag values are never read.
 */
export function mapDagsterRunToItem(
  raw: unknown,
  ctx: DagsterRunContext,
): DagsterRunMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const runId = stringField(row, "runId");
  if (runId === undefined || runId === "") return null;
  const jobName = stringField(row, "jobName") ?? null;
  const status = stringField(row, "status") ?? null;
  const origin = asRecord(row["repositoryOrigin"]);
  const repo = origin === undefined ? undefined : stringField(origin, "repositoryName");
  const location = origin === undefined ? undefined : stringField(origin, "repositoryLocationName");
  const parent =
    jobName !== null && jobName !== "" && repo !== undefined && repo !== ""
      ? `dagster:${location ?? "_"}:${repo}:${jobName}`
      : null;
  const start = secondsToMs(row["startTime"]) ?? secondsToMs(row["creationTime"]);
  const end = secondsToMs(row["endTime"]);
  const url =
    ctx.baseUrl === ""
      ? null
      : `${trimTrailingSlash(ctx.baseUrl)}/runs/${encodeURIComponent(runId)}`;
  const tasks = failedTaskNames(failedSteps(row["stepStats"]));
  return {
    service: "dagster",
    type: "job_run",
    externalId: runId,
    title: clampRunTitle(`${jobName ?? "job"} run ${status ?? "unknown"}`),
    bodyPreview: `Dagster run of ${jobName ?? "a job"}: ${status ?? "unknown"}`,
    url,
    canonicalUrl: url,
    modifiedAt: end ?? start ?? ctx.syncedAt,
    metadata: {
      run_id: runId,
      parent_item_id: parent,
      parent_name: jobName === null ? null : clampName(jobName),
      state: status,
      outcome: outcomeOf(status),
      start_ms: start,
      end_ms: end,
      duration_ms: runDurationMs(start, end),
      failed_tasks: tasks.list,
      failed_task_count: tasks.total,
      trigger: triggerOf(row["tags"]),
      canonical_url: url,
    },
    syncedAt: ctx.syncedAt,
  };
}
