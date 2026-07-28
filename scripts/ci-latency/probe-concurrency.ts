#!/usr/bin/env bun

/**
 * P4b diagnostic — jobs per run, peak concurrent execution, and how many jobs
 * sat created-but-waiting at that peak.
 *
 * This is the probe that found the slice's premise: a push run demands ~105
 * job slots from a pool granting 13-17. Not a gate; see probe-dag.ts.
 *
 * Usage: bun scripts/ci-latency/probe-concurrency.ts [--runs N]
 */

import { isRecord, runGh } from "../structure-audit/_gh-audit.ts";
import { concurrencySeries, pageJobs } from "./probe-lib.ts";

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

function parseRunsArg(argv: string[]): number {
  const ix = argv.indexOf("--runs");
  if (ix === -1) return 4;
  const n = Number(argv[ix + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

if (import.meta.main) {
  const wanted = parseRunsArg(process.argv.slice(2));
  const listed = api(
    `repos/${REPO}/actions/workflows/ci.yml/runs?event=push&branch=main&status=success&per_page=${wanted}`,
  );
  const runs =
    isRecord(listed) && Array.isArray(listed["workflow_runs"]) ? listed["workflow_runs"] : [];
  if (runs.length === 0) {
    console.error("probe-concurrency: no successful push runs readable — is `gh` authenticated?");
    process.exit(1);
  }

  for (const run of runs) {
    if (!isRecord(run)) continue;
    const id = run["id"];
    const startedAt = run["run_started_at"];
    if (typeof id !== "number" || typeof startedAt !== "string") continue;

    // A truncated read here corrupts the ONE number this probe exists to
    // report. Refuse to print rather than print a low job count that reads as
    // success. Delegates to the shared `pageJobs` helper in probe-lib.ts — see
    // its docstring for why read-completeness tracking lives in exactly one
    // place, shared with probe-dag.ts.
    const { jobs, complete, expected } = pageJobs(
      (page) => api(`repos/${REPO}/actions/runs/${id}/jobs?per_page=100&page=${page}`),
      asJobs,
    );
    if (!complete) {
      console.warn(
        `::warning::probe-concurrency: run ${id} job read incomplete (${jobs.length}/${expected ?? "?"}) — SKIPPED rather than reporting a truncated job count`,
      );
      continue;
    }
    const usable = jobs.filter((j) => j.completed_at !== null);
    if (usable.length === 0) continue;

    const series = concurrencySeries(usable, startedAt);
    const peak = series.length === 0 ? 0 : Math.max(...series);
    const peakMinute = series.indexOf(peak);
    const peakAt = Date.parse(startedAt) + peakMinute * 60_000;
    const waitingAtPeak = usable.filter(
      (j) => Date.parse(j.created_at) <= peakAt && Date.parse(j.started_at) > peakAt,
    ).length;
    const count = (re: RegExp) => usable.filter((j) => re.test(j.name)).length;

    console.log(`\nrun ${id} — ${usable.length} jobs, wall ${series.length - 1}min`);
    console.log(
      `    ubuntu=${count(/ubuntu/)} windows=${count(/windows/)} macos=${count(/macos/)}`,
    );
    console.log(`    PEAK concurrent = ${peak} (minute ${peakMinute})`);
    console.log(`    created-but-waiting at peak = ${waitingAtPeak}`);
    console.log(`    profile: ${series.join(" ")}`);
  }
}
