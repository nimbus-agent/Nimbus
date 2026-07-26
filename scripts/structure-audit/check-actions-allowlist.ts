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

import { isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

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

export interface WorkflowRef {
  id: number;
  name: string;
  state: string;
}

/**
 * The repo's workflows.
 *
 * Needed because `actions/runs` returns the newest runs REPO-WIDE, so a quiet
 * workflow falls off the page entirely. Measured on this repo: 26 workflows,
 * but the newest 100 runs covered only 13 of them — the gate would have been
 * blind to half, plausibly including `cla.yml`, which runs only on PRs and is
 * the exact outage this gate exists to catch. Each workflow's latest run is
 * therefore fetched individually.
 */
export function parseWorkflows(json: string): WorkflowRef[] | null {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return null;
    const list = p["workflows"];
    if (!Array.isArray(list)) return null;
    const out: WorkflowRef[] = [];
    for (const w of list) {
      if (!isRecord(w)) continue;
      const id = w["id"];
      const name = w["name"];
      const state = w["state"];
      if (typeof id !== "number" || typeof name !== "string") continue;
      out.push({ id, name, state: typeof state === "string" ? state : "active" });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * A disabled workflow cannot run, so its last-ever run being a startup failure
 * is history rather than a live defect. Only active workflows are asked.
 */
export function isActiveWorkflow(w: WorkflowRef): boolean {
  return w.state === "active";
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

  // The two halves need DIFFERENT permissions and are evaluated independently.
  //
  // `actions/permissions` needs repo Administration on a GitHub App token, and
  // the workflow `permissions:` block has no `administration` scope at all — so
  // `github.token` may simply be unable to read it. Making that fatal would put
  // the sweep permanently red for a reason nobody can fix from CI, so an
  // unreadable allowlist degrades to a warning and the startup-failure half
  // (which needs only `actions: read`) still runs. Only if BOTH are unreadable
  // is there nothing to say.
  const permRes = runGh(["gh", "api", `repos/${repo}/actions/permissions`]);
  const allowedActions = permRes.ok ? parsePermissions(permRes.stdout) : null;

  let result: AllowlistResult | null = null;
  if (permRes.ok) {
    let selected: SelectedActions | null = null;
    if (allowedActions === "selected") {
      const selRes = runGh(["gh", "api", `repos/${repo}/actions/permissions/selected-actions`]);
      selected = selRes.ok ? parseSelectedActions(selRes.stdout) : null;
    }
    const refs = collectActionRefs(
      readWorkflows(join(import.meta.dir, "..", "..", ".github", "workflows")),
    );
    result = evaluateAllowlist(repo, allowedActions, selected, refs);
  }

  // The direct half: a workflow that cannot start says so itself. Asked PER
  // WORKFLOW, because `actions/runs` returns the newest runs repo-wide and a
  // quiet workflow drops off the page (26 workflows here; the newest 100 runs
  // covered 13).
  const wfRes = runGh(["gh", "api", `repos/${repo}/actions/workflows?per_page=100`]);
  const workflows = wfRes.ok ? parseWorkflows(wfRes.stdout) : null;
  let broken: string[] | null = null;
  if (workflows !== null) {
    const latest: RunSummary[] = [];
    let anyRunReadFailed = false;
    for (const w of workflows.filter(isActiveWorkflow)) {
      const r = runGh(["gh", "api", `repos/${repo}/actions/workflows/${w.id}/runs?per_page=1`]);
      if (!r.ok) {
        anyRunReadFailed = true;
        continue;
      }
      const parsed = parseRuns(r.stdout);
      if (parsed === null) {
        anyRunReadFailed = true;
        continue;
      }
      latest.push(...parsed);
    }
    // A partial read cannot prove absence: the one workflow we failed to read
    // might be the broken one. Report unknown rather than a false all-clear.
    broken = anyRunReadFailed && latest.length === 0 ? null : latestStartupFailures(latest);
    if (anyRunReadFailed) {
      console.warn(`::warning::${label}: some workflow run lists were unreadable`);
    }
  }

  if (result === null && broken === null) {
    const outcome = strictSkip(
      label,
      strict,
      "neither the Actions allowlist nor the workflow run list was readable",
    );
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }
  if (result === null) {
    console.warn(
      `::warning::${label}: Actions allowlist unreadable with this token (needs Administration:read) — startup-failure detection still ran`,
    );
  }

  for (const f of result?.findings ?? []) {
    console.error(
      `::error file=.github/workflows/${f.workflow}::${f.ref} is used by ${f.workflow} but is NOT permitted by ${repo}'s Actions allowlist — the workflow will fail at startup, before any job runs`,
    );
  }
  for (const w of broken ?? []) {
    console.error(
      `::error::workflow "${w}" — its most recent run ended in startup_failure: GitHub rejected it before any job ran. Cause is usually an action missing from the Actions allowlist, or invalid workflow YAML. A required check from this workflow will never report.`,
    );
  }

  const detail = result?.detail ?? "allowlist not evaluated";
  if (result?.verdict === "not-permitted" || (broken?.length ?? 0) > 0) {
    console.error(`${label}: FAILED — ${detail}; ${broken?.length ?? 0} workflow(s) broken`);
    process.exit(1);
  }
  // `indeterminate` is a TRANSIENT read failure and so may be strict-red;
  // `unverifiable` is permanent (see the verdict docs) and never is.
  if (result?.verdict === "indeterminate") {
    console.warn(`::warning::${label}: ${detail} (indeterminate)`);
    process.exit(strict ? 1 : 0);
  }
  if (result?.verdict === "unverifiable") {
    console.warn(`::warning::${label}: ${detail}`);
  }
  console.log(
    `${label}: OK — ${repo}: ${detail}; ${broken === null ? "startup state unknown" : `${broken.length} workflow(s) failing at startup`}`,
  );
}
