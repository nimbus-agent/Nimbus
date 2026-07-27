#!/usr/bin/env bun

/**
 * audit:ci-latency — per-job CI execution, runner queue and DAG wait across the
 * org, gated against a committed baseline.
 *
 * ONLY execution regressions fail. Queue wait, DAG wait and job instability are
 * reported and never gated: none is caused by the change under test, and a gate
 * that reports a condition nobody can fix is one everybody learns to ignore.
 *
 * See docs/superpowers/specs/2026-07-27-p4b-ci-latency-design.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isStrict, strictSkip } from "../structure-audit/_gh-audit.ts";
import { computeUpdatedBaseline, parseBaseline, serializeBaseline } from "./baseline.ts";
import { collectAll } from "./collect.ts";
import { MAX_READ_FAILURE_RATIO, MIN_REPORTED_QUEUE_MIN } from "./constants.ts";
import { evaluate } from "./evaluate.ts";
import { summarize } from "./summarize.ts";

const BASELINE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "structure-audit",
  "ci-latency-baseline.json",
);

function readBaselineFile(): string {
  try {
    return readFileSync(BASELINE_PATH, "utf8");
  } catch {
    return '{"version":1,"generated_at":"","entries":{}}';
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const strict = isStrict(argv, process.env);
  const updateMode = argv.includes("--update-baseline");
  const label = "audit:ci-latency";

  const collected = collectAll();
  const { observations, attempted, readFailures, sawNonZeroDagWait } = collected;

  if (observations.length === 0) {
    // Nothing readable at all: no gh, no auth, or a total API outage.
    const outcome = strictSkip(label, strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  if (readFailures > 0) {
    console.warn(`::warning::${label}: ${readFailures}/${attempted} job-list read(s) failed`);
  }
  // A partial sample is worse than none: the survivors are whichever runs
  // happened to succeed, so gating on their median could manufacture a
  // regression. Degrade to a skip rather than gate on degraded data.
  if (attempted > 0 && readFailures / attempted > MAX_READ_FAILURE_RATIO) {
    const outcome = strictSkip(
      label,
      strict,
      `${readFailures}/${attempted} job reads failed — sample too degraded to gate on`,
    );
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }
  // The created_at eligibility assumption is undocumented API behaviour. If it
  // ever changes, dagWait silently goes to zero everywhere and `queue` quietly
  // re-absorbs dependency execution — with no error anywhere. Warn, never fail:
  // an upstream API change is not something a contributor's PR can fix. A
  // window sampling only root jobs (no `needs:` anywhere in it) would ALSO show
  // this, so the wording only reports the observation, not a conclusion.
  if (!sawNonZeroDagWait) {
    console.warn(
      `::warning::${label}: no observation carried a non-zero dagWait — if any sampled workflow uses \`needs:\`, the created_at eligibility assumption may have changed`,
    );
  }

  const summaries = summarize(observations);
  const baseline = parseBaseline(readBaselineFile());

  if (updateMode) {
    const next = computeUpdatedBaseline(baseline, summaries, new Date().toISOString());
    writeFileSync(BASELINE_PATH, serializeBaseline(next));
    console.log(
      `${label}: baseline updated — ${next.entries.size} key(s) from ${observations.length} observation(s)`,
    );
    process.exit(0);
  }

  const result = evaluate(summaries, baseline);

  // Observational lines first, so a red is read in context.
  const worstQueue = [...summaries.values()].sort((a, b) => b.queueMedian - a.queueMedian)[0];
  if (worstQueue && worstQueue.queueMedian > MIN_REPORTED_QUEUE_MIN) {
    console.warn(
      `::warning::${label}: worst median runner queue ${worstQueue.queueMedian.toFixed(1)}m on "${worstQueue.key}" — contention, not a code regression`,
    );
  }
  const worstDagWait = [...summaries.values()].sort((a, b) => b.dagWaitMedian - a.dagWaitMedian)[0];
  if (worstDagWait && worstDagWait.dagWaitMedian > MIN_REPORTED_QUEUE_MIN) {
    console.warn(
      `::warning::${label}: worst median DAG wait ${worstDagWait.dagWaitMedian.toFixed(1)}m on "${worstDagWait.key}" — dependency chain depth, not a code regression`,
    );
  }
  for (const f of result.findings) {
    if (f.kind === "regression") continue;
    console.warn(`::warning::${label}: ${f.key}: ${f.detail} (${f.kind})`);
  }
  for (const f of result.regressions) {
    console.error(`::error::${label}: ${f.key}: ${f.detail}`);
  }

  if (result.regressions.length > 0) {
    console.error(`${label}: FAILED — ${result.regressions.length} job(s) slower than baseline`);
    process.exit(1);
  }
  console.log(`${label}: OK (${summaries.size} key(s), ${observations.length} observation(s))`);
}
