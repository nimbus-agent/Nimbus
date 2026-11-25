/**
 * Shared pieces of the orchestration RUN items (`airflow:dag_run`, `dagster:job_run`, `prefect:flow_run`):
 * the Data Incident Brief's data lane reads these (`incident/lanes/data.ts`). A run is METADATA ONLY, the
 * no-row-data contract: its id, the item of the DAG, job or deployment it belongs to, a normalised outcome,
 * the raw state name, start and end, duration, the NAMES of its failed tasks or steps and how it was
 * triggered (the key set is the same in the three mappers; a test pins it). Never a log line, an error message, a run configuration or a parameter value.
 */

/** Runs are fetched for this long back from the sync; older ones stay as indexed until the owner erases them. */
export const DAG_RUN_WINDOW_MS = 7 * 24 * 3_600_000;
/** At most this many failed task or step names are kept per run (the true count is `failed_task_count`). */
export const DAG_RUN_MAX_FAILED_TASKS = 20;
const NAME_MAX = 120;
const TITLE_MAX = 200;

export type DagRunOutcome = "failed" | "success" | "running" | "other";

/** Clamp a vendor-supplied identifier to one short line (a task or step name is an identifier, not prose). */
export function clampName(raw: string): string {
  const flat = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX)}…` : flat;
}

export function clampRunTitle(s: string): string {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s;
}

/** A sorted, de-duplicated, capped list of clamped task names, with the count before the cap. */
export function failedTaskNames(names: Iterable<string>): { list: string[]; total: number } {
  const set = new Set<string>();
  for (const n of names) {
    const c = clampName(n);
    if (c !== "") set.add(c);
  }
  // By code unit, never by locale, so the stored order is the same on every machine.
  const all = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { list: all.slice(0, DAG_RUN_MAX_FAILED_TASKS), total: all.length };
}

/** The run's duration in ms, or null when either end is unknown or the end precedes the start. */
export function runDurationMs(startMs: number | null, endMs: number | null): number | null {
  return startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null;
}

/** Unix ms of an ISO-8601 string, or null. */
export function isoMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}
