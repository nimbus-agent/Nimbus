/**
 * Is `main` red, and for how long?
 *
 * Nothing in this repo answered that question. `collect.ts` fetches
 * `actions/runs?...&status=success` — failed runs are never retrieved at all —
 * and then drops any job whose conclusion is not `success`. A workflow that
 * fails 100% of the time therefore produces ZERO observations and is reported
 * as nothing rather than as broken.
 *
 * On 2026-07-28 `main` was red for 4.75 hours across six consecutive pushes and
 * the only reason anyone noticed is that a human happened to be looking.
 *
 * This module is the answer, and it deliberately adds no CI job: `check.ts`
 * already runs on a schedule, so the assessment rides along with it.
 */

import { isRecord, runGh } from "../structure-audit/_gh-audit.ts";

/** One push-triggered workflow run on the default branch. */
export interface PushRun {
  /** `null` while the run is still in progress. */
  conclusion: string | null;
  createdAt: string;
  headSha: string;
}

export interface MainHealth {
  /** False when no run has completed yet — absence of evidence, not health. */
  known: boolean;
  red: boolean;
  /** Consecutive non-success runs at the head, ignoring cancellations. */
  consecutiveFailures: number;
  /** When the current red streak began. */
  redSinceIso: string | null;
  redForHours: number | null;
  latestConclusion: string | null;
}

/**
 * Conclusions that mean the build is broken.
 *
 * `startup_failure` is included deliberately: this org has had a scheduled
 * workflow fail at startup for weeks, which no success-only collector could see.
 */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "action_required",
]);

/**
 * Conclusions that say nothing about health and are skipped entirely — they
 * neither start a red streak nor end one.
 *
 * Cancellations are usually concurrency evictions. Counting them red would
 * manufacture outages out of ordinary CI behaviour; counting them green would
 * let a cancel mask a genuine failure behind it.
 */
const NEUTRAL_CONCLUSIONS: ReadonlySet<string> = new Set(["cancelled", "skipped", "neutral"]);

const HOUR_MS = 3_600_000;

/**
 * Assess default-branch health from push runs, newest first.
 *
 * `now` is injected so this stays pure and testable.
 */
export function assessMainHealth(runs: readonly PushRun[], now: number): MainHealth {
  const decisive = runs.filter(
    (r) => r.conclusion !== null && !NEUTRAL_CONCLUSIONS.has(r.conclusion),
  );

  if (decisive.length === 0) {
    return {
      known: false,
      red: false,
      consecutiveFailures: 0,
      redSinceIso: null,
      redForHours: null,
      latestConclusion: null,
    };
  }

  const latest = decisive[0] as PushRun;
  const latestConclusion = latest.conclusion;

  if (latestConclusion === null || !FAILURE_CONCLUSIONS.has(latestConclusion)) {
    return {
      known: true,
      red: false,
      consecutiveFailures: 0,
      redSinceIso: null,
      redForHours: null,
      latestConclusion,
    };
  }

  let streak = 0;
  let oldest: PushRun = latest;
  for (const r of decisive) {
    if (r.conclusion === null || !FAILURE_CONCLUSIONS.has(r.conclusion)) break;
    streak += 1;
    oldest = r;
  }

  const redSince = Date.parse(oldest.createdAt);
  return {
    known: true,
    red: true,
    consecutiveFailures: streak,
    redSinceIso: oldest.createdAt,
    redForHours: Number.isNaN(redSince) ? null : (now - redSince) / HOUR_MS,
    latestConclusion,
  };
}

/** Human-readable one-liner for the gate output. */
export function formatMainHealth(repo: string, h: MainHealth): string {
  if (!h.known) return `${repo}: main health UNKNOWN — no completed push run`;
  if (!h.red) return `${repo}: main is green`;
  const hours = h.redForHours === null ? "?" : h.redForHours.toFixed(1);
  return `${repo}: main is RED — ${h.consecutiveFailures} consecutive failing push run(s) over ${hours}h (since ${h.redSinceIso})`;
}

// ---------------------------------------------------------------- fetch

/** How many recent push runs to inspect per repo. */
const MAIN_RUN_PAGE = 30;

function parsePushRuns(stdout: string): PushRun[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["workflow_runs"])) return [];
  const out: PushRun[] = [];
  for (const raw of parsed["workflow_runs"]) {
    if (!isRecord(raw)) continue;
    const createdAt = typeof raw["created_at"] === "string" ? raw["created_at"] : null;
    if (createdAt === null) continue;
    out.push({
      conclusion: typeof raw["conclusion"] === "string" ? raw["conclusion"] : null,
      createdAt,
      headSha: typeof raw["head_sha"] === "string" ? raw["head_sha"] : "",
    });
  }
  return out;
}

/**
 * Fetch recent push runs on the default branch — **without** a status filter.
 *
 * The missing filter is the entire point. `collect.ts` asks for
 * `status=success`, which is why a permanently-failing workflow is invisible
 * to it.
 */
export function fetchMainHealth(repo: string, now: number = Date.now()): MainHealth | null {
  const res = runGh([
    "gh",
    "api",
    `repos/nimbus-agent/${repo}/actions/runs?per_page=${MAIN_RUN_PAGE}&event=push&branch=main`,
  ]);
  if (!res.ok) return null;
  return assessMainHealth(parsePushRuns(res.stdout), now);
}
