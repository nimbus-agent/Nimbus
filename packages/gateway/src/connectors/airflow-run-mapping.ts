import {
  clampName,
  clampRunTitle,
  type DagRunOutcome,
  failedTaskNames,
  isoMs,
  runDurationMs,
} from "./_lib/dag-run.ts";
import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import { dagUrl } from "./airflow-dag-mapping.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type AirflowRunMappedRow = MappedRow<"airflow", "dag_run">;

export interface AirflowRunContext {
  readonly baseUrl: string;
  readonly syncedAt: number;
  /** Failed task ids by {@link airflowRunKey}, from the task-instance listing (best effort). */
  readonly failedTasks: ReadonlyMap<string, readonly string[]>;
}

export function airflowRunKey(dagId: string, runId: string): string {
  return `${dagId}\u0000${runId}`;
}

function outcomeOf(state: string | null): DagRunOutcome {
  switch (state) {
    case "failed":
      return "failed";
    case "success":
      return "success";
    case "running":
    case "queued":
      return "running";
    default:
      return "other";
  }
}

/**
 * One `GET /api/v1/dags/~/dagRuns` entry as an `airflow:dag_run` item. The documented `conf` (the run's
 * parameters, which can hold data) is never read.
 */
export function mapAirflowRunToItem(
  raw: unknown,
  ctx: AirflowRunContext,
): AirflowRunMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const dagId = stringField(row, "dag_id");
  const runId = stringField(row, "dag_run_id");
  if (dagId === undefined || dagId === "" || runId === undefined || runId === "") return null;
  const state = stringField(row, "state") ?? null;
  const start = isoMs(row["start_date"]);
  const end = isoMs(row["end_date"]);
  const url = `${dagUrl(trimTrailingSlash(ctx.baseUrl), dagId)}?dag_run_id=${encodeURIComponent(runId)}`;
  const tasks = failedTaskNames(ctx.failedTasks.get(airflowRunKey(dagId, runId)) ?? []);
  return {
    service: "airflow",
    type: "dag_run",
    externalId: `${dagId}|${runId}`,
    title: clampRunTitle(`${dagId} run ${state ?? "unknown"}`),
    bodyPreview: `Airflow run of ${dagId}: ${state ?? "unknown"}`,
    url,
    canonicalUrl: url,
    modifiedAt: end ?? start ?? ctx.syncedAt,
    metadata: {
      run_id: runId,
      parent_item_id: `airflow:${dagId}`,
      parent_name: clampName(dagId),
      state: state,
      outcome: outcomeOf(state),
      start_ms: start,
      end_ms: end,
      duration_ms: runDurationMs(start, end),
      failed_tasks: tasks.list,
      failed_task_count: tasks.total,
      trigger: stringField(row, "run_type") ?? null,
      canonical_url: url,
    },
    syncedAt: ctx.syncedAt,
  };
}
