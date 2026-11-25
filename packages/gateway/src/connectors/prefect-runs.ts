import type { SyncContext } from "../sync/types.ts";
import { DAG_RUN_WINDOW_MS } from "./_lib/dag-run.ts";
import type { FetchOutcome } from "./_lib/fetch-outcome.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import { mapPrefectRunToItem } from "./prefect-run-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * Prefect flow runs that were due in the last {@link DAG_RUN_WINDOW_MS} as `prefect:flow_run` items (metadata
 * only), plus the names of the task runs that failed in them. A run still `SCHEDULED` is not fetched. Best
 * effort; the caller catches what this throws. Request and reply shapes follow Prefect's documented REST API
 * (`POST /flow_runs/filter`, `POST /task_runs/filter`), not a live workspace's.
 */
export const PREFECT_RUN_PAGE = 100;
export const PREFECT_RUN_MAX_PAGES = 5;
export const PREFECT_TASK_PAGE = 200;
export const PREFECT_TASK_MAX_PAGES = 3;

const RUN_STATES = [
  "RUNNING",
  "PENDING",
  "COMPLETED",
  "FAILED",
  "CRASHED",
  "CANCELLED",
  "CANCELLING",
  "PAUSED",
];

export type PrefectPost = (path: string, body: Record<string, unknown>) => Promise<FetchOutcome>;

async function walk(
  post: PrefectPost,
  path: string,
  pageSize: number,
  maxPages: number,
  body: (offset: number) => Record<string, unknown>,
): Promise<{ rows: unknown[]; bytes: number }> {
  const rows: unknown[] = [];
  let bytes = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const out = await post(path, body(page * pageSize));
    bytes += out.bytes;
    if (out.kind !== "ok" || !Array.isArray(out.parsed)) break;
    rows.push(...out.parsed);
    if (out.parsed.length < pageSize) break;
  }
  return { rows, bytes };
}

function failedTaskMap(rows: readonly unknown[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const t = asRecord(r);
    const run = t === undefined ? undefined : stringField(t, "flow_run_id");
    const name = t === undefined ? undefined : stringField(t, "name");
    if (run === undefined || name === undefined) continue;
    map.set(run, [...(map.get(run) ?? []), name]);
  }
  return map;
}

export async function syncPrefectRuns(
  ctx: SyncContext,
  post: PrefectPost,
  now: number,
): Promise<{ upserted: number; bytes: number }> {
  const since = new Date(now - DAG_RUN_WINDOW_MS).toISOString();
  const runs = await walk(
    post,
    "/flow_runs/filter",
    PREFECT_RUN_PAGE,
    PREFECT_RUN_MAX_PAGES,
    (offset) => ({
      limit: PREFECT_RUN_PAGE,
      offset,
      sort: "EXPECTED_START_TIME_DESC",
      flow_runs: {
        expected_start_time: { after_: since, before_: new Date(now).toISOString() },
        state: { type: { any_: RUN_STATES } },
      },
    }),
  );
  let bytes = runs.bytes;
  let failedTasks = new Map<string, string[]>();
  const anyFailed = runs.rows.some((r) => {
    const t = asRecord(r)?.["state_type"];
    return t === "FAILED" || t === "CRASHED";
  });
  if (anyFailed) {
    try {
      const tasks = await walk(
        post,
        "/task_runs/filter",
        PREFECT_TASK_PAGE,
        PREFECT_TASK_MAX_PAGES,
        (offset) => ({
          limit: PREFECT_TASK_PAGE,
          offset,
          sort: "EXPECTED_START_TIME_DESC",
          task_runs: {
            state: { type: { any_: ["FAILED", "CRASHED"] } },
            expected_start_time: { after_: since },
          },
        }),
      );
      bytes += tasks.bytes;
      failedTasks = failedTaskMap(tasks.rows);
    } catch (err) {
      ctx.logger.warn({ serviceId: "prefect", err }, "prefect failed-task listing failed");
    }
  }
  const upserted = upsertMapped(ctx, runs.rows, (raw) =>
    mapPrefectRunToItem(raw, { syncedAt: now, failedTasks }),
  );
  return { upserted, bytes };
}
