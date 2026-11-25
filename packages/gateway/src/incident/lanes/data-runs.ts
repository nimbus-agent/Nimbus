import type { Database } from "bun:sqlite";
import type { DataItemView, DataRunView, GapNote } from "../incident-record-types.ts";
import { CHAT_WINDOW_BEFORE_MS, codeUnitCompare, gap, oneLine } from "./caps.ts";

/**
 * The runs part of the data lane (Phase 10, the Data Incident Brief's DAG-run input): runs of the orchestration
 * items the lane already matched by name, read from the `airflow:dag_run`, `dagster:job_run` and
 * `prefect:flow_run` rows the gateway syncs index. A run is listed when it FAILED or when it RAN inside the
 * incident window (from {@link RUN_WINDOW_BEFORE_MS} before the open time to {@link RUN_WINDOW_AFTER_MS} after
 * it), newest first. Reads the local index only (I57 (a)); a run is metadata, never a log.
 */

export const RUN_WINDOW_BEFORE_MS = CHAT_WINDOW_BEFORE_MS;
export const RUN_WINDOW_AFTER_MS = 3_600_000;
/** Failed task names kept per run in a record (the full count is `failedTaskCount`). */
export const RUN_TASK_CAP = 5;

const RUN_SOURCES: readonly { service: string; type: string; label: string }[] = [
  { service: "airflow", type: "dag_run", label: "Airflow" },
  { service: "dagster", type: "job_run", label: "Dagster" },
  { service: "prefect", type: "flow_run", label: "Prefect" },
];

type RunRow = {
  id: string;
  service: string;
  type: string;
  url: string | null;
  metadata: string | null;
  parent: string;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** A provider string as one capped display line, or null when it is not a string. */
function lineOrNull(v: unknown, max: number): string | null {
  return typeof v === "string" ? oneLine(v, max) : null;
}

/** The query only returns rows whose metadata is valid JSON with a non-null `parent_item_id`, so it is an object. */
function viewOf(r: RunRow, jobTitle: string): DataRunView {
  const m = JSON.parse(r.metadata ?? "{}") as Record<string, unknown>;
  const outcome = m["outcome"];
  const tasks = Array.isArray(m["failed_tasks"])
    ? m["failed_tasks"].filter((t): t is string => typeof t === "string")
    : [];
  return {
    id: r.id,
    service: r.service,
    type: r.type,
    job: oneLine(jobTitle),
    state: lineOrNull(m["state"], 120),
    outcome:
      outcome === "failed" || outcome === "success" || outcome === "running" ? outcome : "other",
    startMs: num(m["start_ms"]),
    endMs: num(m["end_ms"]),
    failedTasks: tasks.slice(0, RUN_TASK_CAP).map((t) => oneLine(t, 120)),
    failedTaskCount: num(m["failed_task_count"]) ?? tasks.length,
    trigger: lineOrNull(m["trigger"], 40),
    url: r.url,
    rule: "data:run_of_matched_job",
  };
}

export type RunsResult = {
  readonly runs: DataRunView[];
  readonly total: number;
  readonly truncated: boolean;
  readonly gaps: GapNote[];
};

/**
 * Runs of `jobs` (the lane's matched orchestration items) that failed or ran in the window, and a named gap
 * for each run source that has matched jobs but no run item at all in the index (never silence).
 */
export function runsOfJobs(
  db: Database,
  jobs: readonly DataItemView[],
  openedAtMs: number | null,
  scanCap: number,
): RunsResult {
  const out: DataRunView[] = [];
  const gaps: GapNote[] = [];
  let truncated = false;
  const from = openedAtMs === null ? 0 : openedAtMs - RUN_WINDOW_BEFORE_MS;
  const to = openedAtMs === null ? 0 : openedAtMs + RUN_WINDOW_AFTER_MS;
  for (const src of RUN_SOURCES) {
    const mine = jobs.filter((j) => j.service === src.service);
    if (mine.length === 0) continue;
    const hasRun = db
      .query("SELECT 1 AS one FROM item WHERE service = ? AND type = ? LIMIT 1")
      .get(src.service, src.type);
    if (hasRun === null) {
      gaps.push(
        gap(
          "missing_entity_type",
          `No ${src.label} run is indexed, so what a run of the ${src.label} jobs listed here did is absent (its sync has not read runs yet, or the connector is not connected).`,
        ),
      );
      continue;
    }
    const titles = new Map(mine.map((j) => [j.id, j.title]));
    const marks = mine.map(() => "?").join(",");
    // The failed arm needs the start only when a window exists; with no open time only failures qualify.
    const windowArm = openedAtMs === null ? "" : " OR (s <= ? AND (e IS NULL OR e >= ?))";
    const failedArm =
      openedAtMs === null ? "outcome = 'failed'" : "(outcome = 'failed' AND s <= ?)";
    const args: (string | number)[] = [src.service, src.type, ...mine.map((j) => j.id)];
    if (openedAtMs !== null) args.push(to, to, from);
    // lane-census: scope=dag_run,job_run,flow_run service=airflow,dagster,prefect
    const rows = db
      .query(
        `SELECT id, service, type, url, metadata, parent FROM (
           SELECT id, service, type, url, metadata,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.parent_item_id') END AS parent,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.outcome') END AS outcome,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.start_ms') END AS s,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.end_ms') END AS e
             FROM item WHERE service = ? AND type = ?)
          WHERE parent IN (${marks}) AND (${failedArm}${windowArm})
          ORDER BY s DESC, id ASC
          LIMIT ${String(scanCap)}`,
      )
      .all(...args) as RunRow[];
    if (rows.length >= scanCap) truncated = true;
    for (const r of rows) {
      out.push(viewOf(r, titles.get(r.parent) ?? r.parent));
    }
  }
  out.sort((a, b) => {
    const d = (b.startMs ?? 0) - (a.startMs ?? 0);
    return d !== 0 ? d : codeUnitCompare(a.id, b.id);
  });
  return { runs: out, total: out.length, truncated, gaps };
}
