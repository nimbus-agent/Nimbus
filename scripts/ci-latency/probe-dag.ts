#!/usr/bin/env bun

/**
 * P4b diagnostic — which upstream job actually gated each `E2E Desktop` leg,
 * and how long each leg waited.
 *
 * Not a gate, and deliberately not registered in preflight-gates.ts: it is the
 * before/after instrument for the tuning slice, because `audit:ci-latency`
 * gates EXECUTION while this slice's win lands in DAG wait.
 *
 * Usage: bun scripts/ci-latency/probe-dag.ts [--runs N]
 */

import { isRecord, runGh } from "../structure-audit/_gh-audit.ts";
import { bindingUpstream, median, minutesBetween } from "./probe-lib.ts";

const REPO = "nimbus-agent/Nimbus";

interface Job {
  name: string;
  created_at: string;
  started_at: string;
  completed_at: string | null;
}

function api(path: string): unknown {
  const r = runGh(["gh", "api", path]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function asJobs(value: unknown): Job[] {
  if (!isRecord(value) || !Array.isArray(value["jobs"])) return [];
  const out: Job[] = [];
  for (const j of value["jobs"]) {
    if (!isRecord(j)) continue;
    const name = j["name"];
    const created = j["created_at"];
    const started = j["started_at"];
    const completed = j["completed_at"];
    if (typeof name !== "string" || typeof created !== "string" || typeof started !== "string") {
      continue;
    }
    out.push({
      name,
      created_at: created,
      started_at: started,
      completed_at: typeof completed === "string" ? completed : null,
    });
  }
  return out;
}

/**
 * Pages through a run's jobs, reporting whether the read was COMPLETE.
 *
 * Job count is this slice's headline metric, so a silently truncated read would
 * report fewer jobs than really ran and be read as proof the change worked. An
 * instrument that fails toward its own hypothesis is worse than none — the same
 * hazard `MAX_READ_FAILURE_RATIO` exists for in the gate itself.
 */
function jobsForRun(runId: number): { jobs: Job[]; complete: boolean } {
  const jobs: Job[] = [];
  let expected: number | undefined;
  for (let page = 1; page <= 5; page++) {
    const payload = api(`repos/${REPO}/actions/runs/${runId}/jobs?per_page=100&page=${page}`);
    if (payload === null) return { jobs, complete: false }; // read FAILED, not "no more pages"
    const total = isRecord(payload) ? payload["total_count"] : undefined;
    if (typeof total === "number") expected = total;
    const batch = asJobs(payload);
    if (batch.length === 0) break;
    jobs.push(...batch);
    if (expected !== undefined && jobs.length >= expected) break;
  }
  return { jobs, complete: expected !== undefined && jobs.length >= expected };
}

function parseRunsArg(argv: string[]): number {
  const ix = argv.indexOf("--runs");
  if (ix === -1) return 15;
  const n = Number(argv[ix + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
}

if (import.meta.main) {
  const wanted = parseRunsArg(process.argv.slice(2));
  const listed = api(
    `repos/${REPO}/actions/workflows/ci.yml/runs?event=push&branch=main&status=success&per_page=${wanted}`,
  );
  const runs =
    isRecord(listed) && Array.isArray(listed["workflow_runs"]) ? listed["workflow_runs"] : [];
  if (runs.length === 0) {
    console.error("probe-dag: no successful push runs readable — is `gh` authenticated?");
    process.exit(1);
  }

  const binding = new Map<string, number>();
  const waitsByLeg = new Map<string, number[]>();
  let incomplete = 0;

  for (const run of runs) {
    if (!isRecord(run)) continue;
    const id = run["id"];
    const startedAt = run["run_started_at"];
    if (typeof id !== "number" || typeof startedAt !== "string") continue;
    const { jobs, complete } = jobsForRun(id);
    // Skip, do not silently include: a partial job list biases the binding-job
    // tally toward whichever pages happened to load.
    if (!complete) {
      incomplete++;
      continue;
    }
    const upstream = jobs.filter((j) => /^CI — (TS\/Bun|Rust\/Tauri)/.test(j.name));
    const legs = jobs.filter((j) => j.name.startsWith("E2E Desktop —"));
    const gatedBy = bindingUpstream(upstream);
    for (const leg of legs) {
      if (gatedBy) binding.set(gatedBy.name, (binding.get(gatedBy.name) ?? 0) + 1);
      const wait = minutesBetween(leg.created_at, startedAt);
      waitsByLeg.set(leg.name, [...(waitsByLeg.get(leg.name) ?? []), wait]);
    }
  }

  console.log(`\nruns sampled: ${runs.length - incomplete}/${runs.length}`);
  if (incomplete > 0) {
    console.warn(
      `::warning::probe-dag: ${incomplete}/${runs.length} run(s) had an incomplete job read and were EXCLUDED — figures below cover the rest`,
    );
  }
  console.log("\nWHICH upstream job gated E2E (times it was last to finish):");
  for (const [name, n] of [...binding].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}x  ${name}`);
  }
  console.log("\nDAG wait per E2E leg (minutes):");
  for (const [leg, ws] of [...waitsByLeg].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(
      `  ${leg.padEnd(34)} median ${median(ws).toFixed(1).padStart(6)}  max ${Math.max(...ws)
        .toFixed(1)
        .padStart(6)}  n=${ws.length}`,
    );
  }
}
