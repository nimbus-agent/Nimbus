import type { SyncContext } from "../sync/types.ts";
import { DAG_RUN_WINDOW_MS } from "./_lib/dag-run.ts";
import type { FetchOutcome } from "./_lib/fetch-outcome.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import { airflowRunKey, mapAirflowRunToItem } from "./airflow-run-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * Airflow DAG runs of the last {@link DAG_RUN_WINDOW_MS} as `airflow:dag_run` items (metadata only), plus the
 * ids of the tasks that FAILED in them. Best effort: the caller catches anything this throws, and a page
 * that fails ends the walk with what was read. Reply shapes are the documented stable REST API's
 * (`GET /dags/~/dagRuns`, `GET /dags/~/dagRuns/~/taskInstances`), not a live account's.
 */
export const AIRFLOW_RUN_PAGE = 100;
export const AIRFLOW_RUN_MAX_PAGES = 5;
export const AIRFLOW_TASK_MAX_PAGES = 3;

export type AirflowGet = (path: string) => Promise<FetchOutcome>;

function listPath(base: string, offset: number, sinceIso: string, extra: Record<string, string>) {
  const p = new URLSearchParams({
    limit: String(AIRFLOW_RUN_PAGE),
    offset: String(offset),
    start_date_gte: sinceIso,
    ...extra,
  });
  return `${base}?${p.toString()}`;
}

async function walk(
  get: AirflowGet,
  base: string,
  key: string,
  sinceIso: string,
  extra: Record<string, string>,
  maxPages: number,
): Promise<{ rows: unknown[]; bytes: number }> {
  const rows: unknown[] = [];
  let bytes = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const out = await get(listPath(base, page * AIRFLOW_RUN_PAGE, sinceIso, extra));
    bytes += out.bytes;
    if (out.kind !== "ok") break;
    const list = asRecord(out.parsed)?.[key];
    const got = Array.isArray(list) ? list : [];
    rows.push(...got);
    if (got.length < AIRFLOW_RUN_PAGE) break;
  }
  return { rows, bytes };
}

function failedTaskMap(rows: readonly unknown[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const t = asRecord(r);
    const dag = t === undefined ? undefined : stringField(t, "dag_id");
    const run = t === undefined ? undefined : stringField(t, "dag_run_id");
    const task = t === undefined ? undefined : stringField(t, "task_id");
    if (dag === undefined || run === undefined || task === undefined) continue;
    const k = airflowRunKey(dag, run);
    map.set(k, [...(map.get(k) ?? []), task]);
  }
  return map;
}

export async function syncAirflowRuns(
  ctx: SyncContext,
  get: AirflowGet,
  baseUrl: string,
  now: number,
): Promise<{ upserted: number; bytes: number }> {
  const sinceIso = new Date(now - DAG_RUN_WINDOW_MS).toISOString();
  const runs = await walk(
    get,
    "/api/v1/dags/~/dagRuns",
    "dag_runs",
    sinceIso,
    { order_by: "-start_date" },
    AIRFLOW_RUN_MAX_PAGES,
  );
  let bytes = runs.bytes;
  const anyFailed = runs.rows.some((r) => asRecord(r)?.["state"] === "failed");
  let failedTasks = new Map<string, string[]>();
  if (anyFailed) {
    try {
      const tasks = await walk(
        get,
        "/api/v1/dags/~/dagRuns/~/taskInstances",
        "task_instances",
        sinceIso,
        { state: "failed" },
        AIRFLOW_TASK_MAX_PAGES,
      );
      bytes += tasks.bytes;
      failedTasks = failedTaskMap(tasks.rows);
    } catch (err) {
      ctx.logger.warn({ serviceId: "airflow", err }, "airflow failed-task listing failed");
    }
  }
  const upserted = upsertMapped(ctx, runs.rows, (raw) =>
    mapAirflowRunToItem(raw, { baseUrl, syncedAt: now, failedTasks }),
  );
  return { upserted, bytes };
}
