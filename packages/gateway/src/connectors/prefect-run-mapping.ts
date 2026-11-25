import {
  clampName,
  clampRunTitle,
  type DagRunOutcome,
  failedTaskNames,
  isoMs,
  runDurationMs,
} from "./_lib/dag-run.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type PrefectRunMappedRow = MappedRow<"prefect", "flow_run">;

export interface PrefectRunContext {
  readonly syncedAt: number;
  /** Failed task-run names by flow run id, from the task-run listing (best effort). */
  readonly failedTasks: ReadonlyMap<string, readonly string[]>;
}

function outcomeOf(stateType: string | null): DagRunOutcome {
  switch (stateType) {
    case "FAILED":
    case "CRASHED":
      return "failed";
    case "COMPLETED":
      return "success";
    case "RUNNING":
    case "PENDING":
    case "SCHEDULED":
    case "PAUSED":
    case "CANCELLING":
      return "running";
    default:
      return "other";
  }
}

/**
 * One `POST /flow_runs/filter` entry as a `prefect:flow_run` item. The parent is the deployment's own
 * item id (`prefect:<deployment_id>`), null for a flow run started with no deployment. The run's
 * `parameters`, `state.message` and `state.data` are never read.
 */
export function mapPrefectRunToItem(
  raw: unknown,
  ctx: PrefectRunContext,
): PrefectRunMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const id = stringField(row, "id");
  if (id === undefined || id === "") return null;
  const name = stringField(row, "name") ?? null;
  const deploymentId = stringField(row, "deployment_id");
  const stateType = stringField(row, "state_type") ?? null;
  const stateName = stringField(row, "state_name") ?? stateType;
  const start = isoMs(row["start_time"]) ?? isoMs(row["expected_start_time"]);
  const end = isoMs(row["end_time"]);
  const label = name ?? id;
  const tasks = failedTaskNames(ctx.failedTasks.get(id) ?? []);
  return {
    service: "prefect",
    type: "flow_run",
    externalId: id,
    title: clampRunTitle(`${label} ${stateName ?? "unknown"}`),
    bodyPreview: `Prefect flow run ${label}: ${stateName ?? "unknown"}`,
    url: null,
    canonicalUrl: null,
    modifiedAt: end ?? start ?? ctx.syncedAt,
    metadata: {
      run_id: id,
      parent_item_id:
        deploymentId === undefined || deploymentId === "" ? null : `prefect:${deploymentId}`,
      parent_name: name === null ? null : clampName(name),
      state: stateName,
      outcome: outcomeOf(stateType),
      start_ms: start,
      end_ms: end,
      duration_ms: runDurationMs(start, end),
      failed_tasks: tasks.list,
      failed_task_count: tasks.total,
      trigger: row["auto_scheduled"] === true ? "schedule" : "manual",
      canonical_url: null,
    },
    syncedAt: ctx.syncedAt,
  };
}
