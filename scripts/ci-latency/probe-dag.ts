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
import {
  accumulateBinding,
  asJobs,
  type Job,
  median,
  minutesBetween,
  pageJobs,
} from "./probe-lib.ts";

const REPO = "nimbus-agent/Nimbus";

function api(path: string): unknown {
  const r = runGh(["gh", "api", path]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Pages through a run's jobs, reporting whether the read was COMPLETE.
 *
 * Delegates to the shared `pageJobs` helper in `probe-lib.ts` — see its
 * docstring for why read-completeness tracking lives in exactly one place.
 */
function jobsForRun(runId: number): { jobs: Job[]; complete: boolean } {
  const { jobs, complete } = pageJobs(
    (page) => api(`repos/${REPO}/actions/runs/${runId}/jobs?per_page=100&page=${page}`),
    asJobs,
  );
  return { jobs, complete };
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
  let droppedLegs = 0;
  let totalLegs = 0;

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
    // Eligibility is per-leg, not per-run: which upstream job actually gated
    // THIS leg depends on when THIS leg became runnable (`leg.created_at`), not
    // on which candidate happened to finish last in wall-clock time across the
    // whole run. `accumulateBinding` reports legs it could not attribute rather
    // than dropping them silently — see its docstring for why that matters more
    // now that the gating margin is ~1.2 min rather than ~60.
    totalLegs += legs.length;
    droppedLegs += accumulateBinding(binding, upstream, legs);
    for (const leg of legs) {
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
  if (droppedLegs > 0) {
    console.warn(
      `::warning::probe-dag: ${droppedLegs}/${totalLegs} E2E leg(s) had NO upstream candidate completing at or before their eligibility moment and are absent from the attribution tally below`,
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
