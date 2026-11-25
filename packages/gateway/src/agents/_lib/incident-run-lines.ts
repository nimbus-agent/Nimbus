import type { DataLane, DataRunView } from "../../incident/incident-record-types.ts";
import { plain, utcLabel } from "./incident-render.ts";
import { hardenedTitleLink } from "./render.ts";

/**
 * The run lines of the data lane, shared by the Data Incident Brief and the general incident brief. A run is
 * metadata only (state, timing, failed task names, how it began); every provider string goes through
 * `plain` or `hardenedTitleLink`, the fixed text is ours. No log is ever shown because none is indexed.
 */

export const RUNS_NOTE =
  "_Runs of the jobs above that failed, or that ran from 24 hours before to 1 hour after the alert (newest first). A run shows its state, timing and failed task names; logs are never indexed._";

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60
    ? `${String(m)}m ${String(s % 60)}s`
    : `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

export function runLine(r: DataRunView): string {
  const when = r.startMs === null ? "" : `, started ${utcLabel(r.startMs)}`;
  const took =
    r.startMs !== null && r.endMs !== null && r.endMs >= r.startMs
      ? `, took ${duration(r.endMs - r.startMs)}`
      : "";
  const tasks =
    r.failedTasks.length === 0
      ? ""
      : `, failed tasks: ${r.failedTasks.map((t) => `\`${plain(t)}\``).join(", ")}${r.failedTaskCount > r.failedTasks.length ? ` (and ${String(r.failedTaskCount - r.failedTasks.length)} more)` : ""}`;
  const trigger = r.trigger === null ? "" : `, trigger ${plain(r.trigger)}`;
  return `- ${hardenedTitleLink(r.job, r.url)} - ${plain(r.service)} run ${plain(r.state ?? r.outcome)}${when}${took}${tasks}${trigger} (rule: ${r.rule})`;
}

/** The "and N more" line for runs the record cut, or none. */
export function runsMore(d: DataLane): string[] {
  const more = (d.totals.runs ?? 0) - (d.runs?.length ?? 0);
  return more > 0 ? [`_and ${String(more)} more_`] : [];
}

/** The Data Incident Brief's whole "Runs of those jobs" section body. */
export function runSectionLines(d: DataLane): string[] {
  if (d.runs === undefined) return ["_Runs were not recorded in this version of the record._"];
  if (d.orchestration.length === 0)
    return ["_No orchestration job matched, so no run was looked up._"];
  if (d.runs.length === 0) {
    return (d.totals.runs ?? 0) > 0
      ? ["_Runs were found but omitted for size._"]
      : ["_No run of the jobs listed above failed or ran in the incident window._"];
  }
  return [...d.runs.map(runLine), ...runsMore(d), RUNS_NOTE];
}
