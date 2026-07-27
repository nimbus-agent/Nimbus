/**
 * The only impure module: walks the Actions API and returns raw observations.
 * Every parser is exported and pure so the whole shape is table-tested offline.
 *
 * Restricted to `push` on the default branch: PR runs execute a different job
 * set against different cache state, so mixing them compares unlike things.
 */

import { isRecord, runGh } from "../structure-audit/_gh-audit.ts";
import {
  AUDITED_REPOS,
  MAX_JOB_PAGES,
  MAX_RUNS_PER_WORKFLOW,
  RUN_LIST_PAGE,
  SAMPLE_EVENT,
} from "./constants.ts";
import type { JobObservation } from "./types.ts";

const MS_PER_MIN = 60_000;

export interface RunMeta {
  id: string;
  name: string;
  runStartedAt: string;
}

export interface CollectResult {
  observations: JobObservation[];
  /** Job-list fetches attempted, for the failure-ratio check. */
  attempted: number;
  readFailures: number;
  /** True once any observation carried a non-zero dagWait — the created_at guard. */
  sawNonZeroDagWait: boolean;
}

export function parseRunMeta(json: string): RunMeta[] {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p) || !Array.isArray(p["workflow_runs"])) return [];
    const out: RunMeta[] = [];
    for (const r of p["workflow_runs"]) {
      if (!isRecord(r)) continue;
      const id = r["id"];
      const name = r["name"];
      const started = r["run_started_at"];
      if (typeof id !== "number" || typeof name !== "string" || typeof started !== "string") {
        continue;
      }
      out.push({ id: String(id), name, runStartedAt: started });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Keep at most `MAX_RUNS_PER_WORKFLOW` runs of each workflow.
 *
 * Capping per workflow rather than per repo is the whole point: a flat per-repo
 * cap let the noisiest workflow consume the window, leaving `CI` with 4 of 30
 * runs and every ratchet threshold above 5 permanently unreachable.
 */
export function selectRuns(runs: readonly RunMeta[]): RunMeta[] {
  const seen = new Map<string, number>();
  const out: RunMeta[] = [];
  for (const r of runs) {
    const n = seen.get(r.name) ?? 0;
    if (n >= MAX_RUNS_PER_WORKFLOW) continue;
    seen.set(r.name, n + 1);
    out.push(r);
  }
  return out;
}

function minutesBetween(later: unknown, earlier: unknown): number | null {
  if (typeof later !== "string" || typeof earlier !== "string") return null;
  const a = new Date(later).getTime();
  const b = new Date(earlier).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (a - b) / MS_PER_MIN;
}

export function parseJobObservations(
  json: string,
  repo: string,
  workflow: string,
  runStartedAt: string,
): JobObservation[] {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p) || !Array.isArray(p["jobs"])) return [];
    const out: JobObservation[] = [];
    for (const j of p["jobs"]) {
      if (!isRecord(j)) continue;
      if (j["conclusion"] !== "success") continue;
      const name = j["name"];
      if (typeof name !== "string") continue;
      const exec = minutesBetween(j["completed_at"], j["started_at"]);
      const queue = minutesBetween(j["started_at"], j["created_at"]);
      const dagWait = minutesBetween(j["created_at"], runStartedAt);
      if (exec === null || queue === null || dagWait === null) continue;
      out.push({
        repo,
        workflow,
        job: name,
        exec: Math.max(0, exec),
        queue: Math.max(0, queue),
        dagWait: Math.max(0, dagWait),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Pulls `total_count` off a `jobs` page. `per_page=100` truncates silently —
 * confirmed live on a 105-job run — and this is how the collector knows more
 * pages remain. Returns `null` rather than 0 on malformed JSON so a paging
 * loop can tell "nothing there" from "unreadable" and refuse to page forever.
 */
export function parseJobsTotalCount(json: string): number | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    const tc = p["total_count"];
    return typeof tc === "number" ? tc : null;
  } catch {
    return null;
  }
}

/** How many `jobs` entries one page actually returned, success or not. */
function parseJobsPageCount(json: string): number {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p) || !Array.isArray(p["jobs"])) return 0;
    return p["jobs"].length;
  } catch {
    return 0;
  }
}

/**
 * All observations for one repo. An unreadable repo yields none — never a
 * finding — but read failures are COUNTED, because a partial sample is more
 * dangerous than no sample: the survivors are whichever runs happened to
 * succeed, so their median can be biased and the gate could manufacture a
 * regression from it.
 */
export function collectRepo(repo: string): CollectResult {
  const res = runGh([
    "gh",
    "api",
    `repos/nimbus-agent/${repo}/actions/runs?per_page=${RUN_LIST_PAGE}&event=${SAMPLE_EVENT}&status=success`,
  ]);
  if (!res.ok) {
    // A failed run-LIST read must still count against the degradation guard:
    // losing a whole repo silently is worse than losing one run within it.
    return { observations: [], attempted: 1, readFailures: 1, sawNonZeroDagWait: false };
  }

  const out: JobObservation[] = [];
  let attempted = 0;
  let readFailures = 0;
  let sawNonZeroDagWait = false;

  for (const run of selectRuns(parseRunMeta(res.stdout))) {
    attempted++;
    const firstPage = runGh([
      "gh",
      "api",
      `repos/nimbus-agent/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    ]);
    if (!firstPage.ok) {
      readFailures++;
      continue;
    }
    const obs = parseJobObservations(firstPage.stdout, repo, run.name, run.runStartedAt);
    if (obs.some((o) => o.dagWait > 0)) sawNonZeroDagWait = true;
    out.push(...obs);

    // Page through until every job is retrieved. Bounded by MAX_JOB_PAGES so a
    // bad/wildly-wrong total_count can never spin the loop forever.
    const total = parseJobsTotalCount(firstPage.stdout);
    let fetched = parseJobsPageCount(firstPage.stdout);
    let page = 1;
    while (total !== null && fetched < total && page < MAX_JOB_PAGES) {
      page++;
      attempted++;
      const nextPage = runGh([
        "gh",
        "api",
        `repos/nimbus-agent/${repo}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`,
      ]);
      if (!nextPage.ok) {
        readFailures++;
        break;
      }
      const more = parseJobObservations(nextPage.stdout, repo, run.name, run.runStartedAt);
      if (more.some((o) => o.dagWait > 0)) sawNonZeroDagWait = true;
      out.push(...more);
      fetched += parseJobsPageCount(nextPage.stdout);
    }
  }
  return { observations: out, attempted, readFailures, sawNonZeroDagWait };
}

export function collectAll(repos: readonly string[] = AUDITED_REPOS): CollectResult {
  const merged: CollectResult = {
    observations: [],
    attempted: 0,
    readFailures: 0,
    sawNonZeroDagWait: false,
  };
  for (const repo of repos) {
    const r = collectRepo(repo);
    merged.observations.push(...r.observations);
    merged.attempted += r.attempted;
    merged.readFailures += r.readFailures;
    merged.sawNonZeroDagWait ||= r.sawNonZeroDagWait;
  }
  return merged;
}
