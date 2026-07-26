#!/usr/bin/env bun

/**
 * audit:actions-allowlist — for every org repo whose `allowed_actions` is
 * `selected`, assert every action a workflow `uses:` is actually permitted to
 * run.
 *
 * This is the gate that would have caught the 2026-07-24 CLA outage on day
 * zero. `Nimbus` is the only repo with a restricted allowlist, and
 * `contributor-assistant/github-action` was absent from `patterns_allowed`, so
 * GitHub rejected `cla.yml` before any job started: 23 consecutive
 * `startup_failure` runs, a REQUIRED check that never reported, and every PR
 * silently unmergeable for two days.
 *
 * `cla-coverage` was green throughout, because it verifies that each repo HAS
 * `cla.yml` at a consistent version. A gate that checks a control's PRESENCE
 * cannot see that the control is structurally unable to EXECUTE — absence of a
 * red signal was indistinguishable from absence of the signal entirely.
 *
 * See docs/superpowers/specs/2026-07-26-p5-p3-infra-batch-design.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyReadFailure, isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

export interface WorkflowFile {
  path: string;
  text: string;
}

export interface ActionRef {
  ref: string;
  workflow: string;
}

export interface SelectedActions {
  githubOwnedAllowed: boolean;
  verifiedAllowed: boolean;
  patternsAllowed: string[];
}

/**
 * `unverifiable` is deliberately distinct from `indeterminate`, and deliberately
 * NOT red under `--strict`.
 *
 * `indeterminate` means a read failed and might succeed next run — the program's
 * rule that a strict run evaluating nothing is red applies, because the silence
 * is transient. `unverifiable` means `verified_allowed` is on and an action is
 * covered only by that: GitHub exposes no API for "is this creator a verified
 * Marketplace partner", so the answer can never arrive. Treating a permanent
 * epistemic limit as a hard failure produces a gate that is red forever, and a
 * gate that is always red is one everybody learns to ignore — the exact failure
 * this sub-program exists to prevent.
 */
export type AllowlistVerdict =
  | "ok"
  | "not-permitted"
  | "unverifiable"
  | "indeterminate"
  | "skipped";

export interface AllowlistResult {
  repo: string;
  verdict: AllowlistVerdict;
  findings: ActionRef[];
  detail: string;
}

/**
 * Every `uses:` reference in a set of workflows.
 *
 * Local (`./path`) and Docker (`docker://`) references are skipped: the Actions
 * allowlist governs neither, so reporting them would be noise that trains
 * people to ignore the gate.
 */
export function collectActionRefs(files: readonly WorkflowFile[]): ActionRef[] {
  const out: ActionRef[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const m of f.text.matchAll(/^\s*-?\s*uses:\s*["']?([^"'\s#]+)["']?/gm)) {
      const ref = m[1];
      if (!ref || ref.startsWith("./") || ref.startsWith(".\\") || ref.startsWith("docker://")) {
        continue;
      }
      const key = `${f.path}::${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref, workflow: f.path });
    }
  }
  return out;
}

/** `owner/repo` from `owner/repo/sub/path@ref`. */
function ownerRepoOf(ref: string): string {
  const [nameWithPath] = ref.split("@");
  const parts = (nameWithPath ?? "").split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (nameWithPath ?? "");
}

/**
 * Does any `patterns_allowed` entry cover this reference? Supports the forms
 * GitHub documents: exact `owner/repo`, `owner/repo@ref`, `owner/*`, and a
 * trailing `*` wildcard.
 */
export function isCoveredByPatterns(ref: string, patterns: readonly string[]): boolean {
  const ownerRepo = ownerRepoOf(ref);
  for (const p of patterns) {
    if (p === ref || p === ownerRepo) return true;
    if (p.endsWith("*")) {
      const prefix = p.slice(0, -1);
      // Match against both the full reference and the bare owner/repo, so
      // `github/codeql-action@*` covers `github/codeql-action/init@v3`.
      if (ref.startsWith(prefix) || ownerRepo.startsWith(prefix)) return true;
      if (`${ownerRepo}@`.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** GitHub-owned actions live under the `actions` and `github` orgs. */
function isGitHubOwned(ref: string): boolean {
  const owner = ref.split("/")[0];
  return owner === "actions" || owner === "github";
}

/**
 * An action owned by the same org as the repo consuming it. GitHub always
 * permits these regardless of the allowlist, so counting one as unpermitted
 * would be a false finding — `nimbus-agent/.github/actions/*` is ours.
 */
function isSameOrg(ref: string, repo: string): boolean {
  const owner = ref.split("/")[0];
  return owner !== undefined && owner === repo.split("/")[0];
}

export function evaluateAllowlist(
  repo: string,
  allowedActions: string | null,
  selected: SelectedActions | null,
  refs: readonly ActionRef[],
): AllowlistResult {
  if (allowedActions !== "selected") {
    return {
      repo,
      verdict: "skipped",
      findings: [],
      detail: `allowed_actions is ${allowedActions ?? "unreadable"} — no allowlist to violate`,
    };
  }
  if (selected === null) {
    return { repo, verdict: "indeterminate", findings: [], detail: "selected-actions unreadable" };
  }

  const findings: ActionRef[] = [];
  const unverifiable: ActionRef[] = [];
  for (const r of refs) {
    if (isSameOrg(r.ref, repo)) continue;
    if (selected.githubOwnedAllowed && isGitHubOwned(r.ref)) continue;
    if (isCoveredByPatterns(r.ref, selected.patternsAllowed)) continue;
    if (selected.verifiedAllowed) {
      // Verified-creator status is not derivable from any API. Report unknown
      // rather than manufacturing either a finding or a pass.
      unverifiable.push(r);
      continue;
    }
    findings.push(r);
  }

  if (findings.length > 0) {
    return {
      repo,
      verdict: "not-permitted",
      findings,
      detail: `${findings.length} action(s) not permitted by the allowlist`,
    };
  }
  if (unverifiable.length > 0) {
    return {
      repo,
      verdict: "unverifiable",
      findings: [],
      detail: `${unverifiable.length} action ref(s) covered only by verified_allowed (${[...new Set(unverifiable.map((u) => u.ref.split("@")[0]))].join(", ")}) — no API exposes verified-creator status`,
    };
  }
  return { repo, verdict: "ok", findings: [], detail: `${refs.length} action ref(s) permitted` };
}

/** `allowed_actions` from the permissions endpoint; null when unreadable or Actions is off. */
export function parsePermissions(json: string): string | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    if (p["enabled"] === false) return null;
    const a = p["allowed_actions"];
    return typeof a === "string" ? a : null;
  } catch {
    return null;
  }
}

export interface RunSummary {
  workflow: string;
  conclusion: string | null;
  status: string | null;
  createdAt: string;
}

/**
 * Workflows whose MOST RECENT run failed at startup.
 *
 * This is the direct, unambiguous half of the gate, and it is the half that
 * would actually have caught the CLA outage. Inferring permission from
 * `patterns_allowed` requires knowing verified-creator status, which no API
 * exposes; a `startup_failure` requires knowing nothing — GitHub rejected the
 * workflow before any job ran, which is the observable symptom itself. It also
 * catches causes the pattern check cannot see at all, such as invalid workflow
 * YAML.
 *
 * Scoped to each workflow's LATEST run so a since-fixed historical failure does
 * not red the sweep forever: the question is "is this workflow able to start
 * *now*", not "has it ever failed".
 */
export function latestStartupFailures(runs: readonly RunSummary[]): string[] {
  const latest = new Map<string, RunSummary>();
  for (const r of runs) {
    const seen = latest.get(r.workflow);
    if (!seen || r.createdAt > seen.createdAt) latest.set(r.workflow, r);
  }
  return [...latest.entries()]
    .filter(([, r]) => r.conclusion === "startup_failure" || r.status === "startup_failure")
    .map(([name]) => name)
    .sort();
}

export function parseRuns(json: string): RunSummary[] | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    const runs = p["workflow_runs"];
    if (!Array.isArray(runs)) return null;
    const out: RunSummary[] = [];
    for (const r of runs) {
      if (!isRecord(r)) continue;
      const workflow = r["name"];
      const createdAt = r["created_at"];
      if (typeof workflow !== "string" || typeof createdAt !== "string") continue;
      out.push({
        workflow,
        conclusion: typeof r["conclusion"] === "string" ? r["conclusion"] : null,
        status: typeof r["status"] === "string" ? r["status"] : null,
        createdAt,
      });
    }
    return out;
  } catch {
    return null;
  }
}

export function parseSelectedActions(json: string): SelectedActions | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    const patterns = p["patterns_allowed"];
    return {
      githubOwnedAllowed: p["github_owned_allowed"] === true,
      verifiedAllowed: p["verified_allowed"] === true,
      patternsAllowed: Array.isArray(patterns) ? patterns.filter((x) => typeof x === "string") : [],
    };
  } catch {
    return null;
  }
}

function readWorkflows(dir: string): WorkflowFile[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => ({ path: f, text: readFileSync(join(dir, f), "utf8") }));
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const label = "audit:actions-allowlist";
  const repo = "nimbus-agent/Nimbus";

  const probe = runGh(["gh", "api", `repos/${repo}/actions/permissions`]);
  if (!probe.ok) {
    // A 404 here means the token cannot read Actions settings, not that the
    // repo is unprotected — never a finding.
    const outcome = strictSkip(
      label,
      strict,
      classifyReadFailure(probe.httpStatus) === "absent"
        ? "Actions permissions not readable with this token"
        : undefined,
    );
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  const allowedActions = parsePermissions(probe.stdout);
  let selected: SelectedActions | null = null;
  if (allowedActions === "selected") {
    const selRes = runGh(["gh", "api", `repos/${repo}/actions/permissions/selected-actions`]);
    selected = selRes.ok ? parseSelectedActions(selRes.stdout) : null;
  }

  const refs = collectActionRefs(
    readWorkflows(join(import.meta.dir, "..", "..", ".github", "workflows")),
  );
  const result = evaluateAllowlist(repo, allowedActions, selected, refs);

  // The direct half: a workflow that cannot start says so itself.
  const runsRes = runGh(["gh", "api", `repos/${repo}/actions/runs?per_page=100`]);
  const runs = runsRes.ok ? parseRuns(runsRes.stdout) : null;
  const broken = runs === null ? null : latestStartupFailures(runs);

  for (const f of result.findings) {
    console.error(
      `::error file=.github/workflows/${f.workflow}::${f.ref} is used by ${f.workflow} but is NOT permitted by ${repo}'s Actions allowlist — the workflow will fail at startup, before any job runs`,
    );
  }
  for (const w of broken ?? []) {
    console.error(
      `::error::workflow "${w}" — its most recent run ended in startup_failure: GitHub rejected it before any job ran. Cause is usually an action missing from the Actions allowlist, or invalid workflow YAML. A required check from this workflow will never report.`,
    );
  }

  const hardFail = result.verdict === "not-permitted" || (broken?.length ?? 0) > 0;
  if (hardFail) {
    console.error(`${label}: FAILED — ${result.detail}; ${broken?.length ?? 0} workflow(s) broken`);
    process.exit(1);
  }
  if (result.verdict === "indeterminate" || broken === null) {
    console.warn(`::warning::${label}: ${result.detail} (indeterminate)`);
    process.exit(strict ? 1 : 0);
  }
  if (result.verdict === "unverifiable") {
    // Never red: a permanent unknown, not a transient one. See the verdict docs.
    console.warn(`::warning::${label}: ${result.detail}`);
  }
  console.log(`${label}: OK — ${repo}: ${result.detail}; no workflow is failing at startup`);
}
