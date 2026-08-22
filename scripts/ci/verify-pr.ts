#!/usr/bin/env bun
// scripts/ci/verify-pr.ts — `bun run verify:pr [<pr-number>]`
//
// The post-push honesty check: after you push, did CI actually agree? On PR #1038, a
// CONFLICTING pull request produced four green checks — because a CONFLICTING PR runs NO
// `pull_request` workflows at all, so its "passing" checks are the *absence* of CI, not
// evidence of it. Every local gate in this plan (Tasks 1-6) can be green while that is true;
// this is the one check that reads the actual, server-side outcome instead.
//
// Not a manifest gate: it needs network + `gh` auth, exactly the properties `CI_ONLY_GATES`
// (scripts/lib/preflight-gates.ts) documents as disqualifying for the local preflight tiers.
//
// The decision logic (`evaluatePrState`) is pure data-in/data-out and is fully unit-tested
// without `gh`. Only `main()` shells out.

import { isRecord } from "../structure-audit/_gh-audit.ts";

export interface PrCheck {
  readonly name: string;
  readonly state: "pass" | "fail" | "pending" | "skipping";
}

export interface PrState {
  readonly mergeable: string;
  readonly checks: readonly PrCheck[];
}

/**
 * The one check the `General` ruleset (14784377) requires for a merge: an `if: always()`
 * aggregator that `needs:` every other PR job. Named here because "every reported check is
 * green" and "the gate reported" are different claims, and only the second protects `main`.
 *
 * A check that has not been CREATED yet does not appear in `gh pr checks` output at all — so a
 * PR whose aggregator has not started looks, to a loop over reported checks, exactly like a PR
 * that has no aggregator. #1298 merged at 17:47:15Z with this check not yet created; it started
 * at 17:57:44Z and failed, putting two broken tests on `main`. Absence must therefore be its own
 * reason, not silence.
 */
export const REQUIRED_GATE = "PR quality — required gates";

export interface PrVerdict {
  readonly green: boolean;
  readonly reasons: readonly string[];
}

/**
 * A CONFLICTING PR runs NO `pull_request` workflows, so its check list is not evidence of
 * anything. In #1038 that produced four green checks and a completely unverified branch. It is
 * checked first and reported explicitly, because the failure mode is "looks fine".
 *
 * Any `mergeable` value other than the literal "MERGEABLE" is treated the same way in spirit —
 * `gh` also reports "UNKNOWN" while the mergeability check hasn't finished (this is the real
 * shape returned for an already-merged PR), and neither state is proof the final merge ref was
 * actually built. Only the exact "MERGEABLE" value is trusted.
 *
 * A check that is failing, still pending, or skipped is never counted as passing — "not yet
 * failed" and "did not run" are both distinct from "passed". Zero reported checks is likewise
 * not evidence of a green PR; it is the same "absence of CI" trap as the CONFLICTING case, just
 * arrived at a different way.
 */
export function evaluatePrState(s: PrState): PrVerdict {
  const reasons: string[] = [];

  if (s.mergeable === "CONFLICTING") {
    reasons.push(
      "PR is CONFLICTING — pull_request workflows are SUPPRESSED; passing checks are not real coverage",
    );
  } else if (s.mergeable !== "MERGEABLE") {
    reasons.push(
      `PR mergeable state is "${s.mergeable}", not MERGEABLE — cannot confirm CI ran against the final merge ref`,
    );
  }

  if (s.checks.length === 0) {
    reasons.push("no checks reported for this PR — absence of checks is not evidence of a pass");
  }

  for (const c of s.checks) {
    if (c.state === "fail") reasons.push(`check failed: ${c.name}`);
  }

  const pending = s.checks.filter((c) => c.state === "pending").map((c) => c.name);
  if (pending.length > 0)
    reasons.push(`still pending (not yet failed is not passed): ${pending.join(", ")}`);

  const skipped = s.checks.filter((c) => c.state === "skipping").map((c) => c.name);
  if (skipped.length > 0)
    reasons.push(`skipped, never ran (skipped is not passed): ${skipped.join(", ")}`);

  // Checked LAST and separately from the loop above: the merge-gating check being absent is a
  // distinct failure from any reported check being red, and it is the one that reads as green.
  if (s.checks.length > 0 && !s.checks.some((c) => c.name === REQUIRED_GATE)) {
    reasons.push(
      `the merge-gating check "${REQUIRED_GATE}" has not reported at all — it is the only check the ruleset requires, and a merge now would bypass it silently`,
    );
  }

  return { green: reasons.length === 0, reasons };
}

/**
 * `gh` prints human-readable text to stderr on rate limits, network failures, GitHub outages
 * and auth problems — feeding that straight to `JSON.parse` produces an unreadable
 * `SyntaxError: Unexpected token` stack trace that tells the user nothing about what actually
 * went wrong. Split out from the `Bun.spawnSync` call so it is unit-testable without `gh`.
 */
export function parseGhOutput(
  argsLabel: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): unknown {
  const out = stdout.trim();
  const err = stderr.trim();
  if (exitCode !== 0) {
    throw new Error(`gh ${argsLabel} failed (exit ${String(exitCode)}): ${err || "no output"}`);
  }
  try {
    return JSON.parse(out) as unknown;
  } catch {
    throw new Error(`gh ${argsLabel} returned non-JSON output: ${out.slice(0, 200)}`);
  }
}

function ghJson(args: readonly string[]): unknown {
  const p = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return parseGhOutput(args.join(" "), p.exitCode, p.stdout.toString(), p.stderr.toString());
}

/** `gh` reports this exact family of message when the branch has no open PR at all. */
const NO_PR_PATTERN = /no pull requests found/i;

function isNoPrError(message: string): boolean {
  return NO_PR_PATTERN.test(message);
}

function parseMergeable(raw: unknown): string {
  if (!isRecord(raw)) throw new Error("gh pr view output was not a JSON object");
  const { mergeable } = raw;
  if (typeof mergeable !== "string") {
    throw new Error("gh pr view output is missing a string 'mergeable' field");
  }
  return mergeable;
}

function toCheckState(bucket: unknown): PrCheck["state"] {
  if (bucket === "pass" || bucket === "pending" || bucket === "skipping") return bucket;
  // "fail", "cancel", and anything unrecognized are all treated as a failure — a bucket value
  // this script doesn't know about is never silently upgraded to a pass.
  return "fail";
}

function parseChecks(raw: unknown): PrCheck[] {
  if (!Array.isArray(raw)) throw new Error("gh pr checks output was not a JSON array");
  return raw.map((entry: unknown, i: number) => {
    if (!isRecord(entry)) throw new Error(`gh pr checks entry ${String(i)} was not a JSON object`);
    const { name, bucket } = entry;
    if (typeof name !== "string") {
      throw new Error(`gh pr checks entry ${String(i)} is missing a string 'name' field`);
    }
    return { name, state: toCheckState(bucket) };
  });
}

function currentBranch(): string {
  const p = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const name = p.stdout.toString().trim();
  return name.length > 0 ? name : "HEAD";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function main(): number {
  const prArg = process.argv[2];
  const target = prArg !== undefined ? [prArg] : [];
  const branch = currentBranch();
  const label = prArg !== undefined ? `#${prArg}` : `branch ${branch}`;

  let mergeable: string;
  try {
    const raw = ghJson([
      "pr",
      "view",
      ...target,
      "--json",
      "mergeable,mergeStateStatus,number,state",
    ]);
    mergeable = parseMergeable(raw);
  } catch (err) {
    const message = errorMessage(err);
    if (isNoPrError(message)) {
      console.log(`no open PR for ${branch} — nothing to verify`);
      return 1;
    }
    console.error(`could not determine PR state for ${label}: ${message}`);
    return 2;
  }

  let checks: PrCheck[];
  try {
    const raw = ghJson(["pr", "checks", ...target, "--json", "name,state,bucket"]);
    checks = parseChecks(raw);
  } catch (err) {
    const message = errorMessage(err);
    if (isNoPrError(message)) {
      console.log(`no open PR for ${branch} — nothing to verify`);
      return 1;
    }
    console.error(`could not determine PR state for ${label}: ${message}`);
    return 2;
  }

  const verdict = evaluatePrState({ mergeable, checks });
  if (verdict.green) {
    console.log(
      `PR ${label} is green: mergeable, and every required check has actually concluded successfully.`,
    );
    return 0;
  }

  console.log(`PR ${label} is NOT verified green:`);
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
