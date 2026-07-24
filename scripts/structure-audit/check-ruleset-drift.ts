#!/usr/bin/env bun

/**
 * audit:ruleset-drift — asserts each active org repo's live `General` branch
 * ruleset matches the declarative shape in `.github/rulesets/general-branch.json`.
 *
 * Manual UI configuration drifts: `nimbus-client` had zero rulesets while its
 * three sibling repos each had two. Checking the desired shape into the repo and
 * diffing it turns uniform protection from a one-time task into a gated property.
 *
 * The diff is pure and unit-tested; the CLI wrapper fetches live config via `gh`.
 * The CLI is fail-soft: it needs network + `gh` auth + org-read, which offline
 * maintainers and external contributors on this public repo lack, so it runs only
 * in the scheduled org-drift-sweep workflow (never the FAST preflight tier) and
 * skips green — rather than failing — when `gh` is unavailable/unauthenticated.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

/** The shape shared by every active org repo's declared ruleset. */
export interface SharedRuleset {
  name: string;
  target: string;
  enforcement: string;
  conditions_ref_include: string[];
  conditions_ref_exclude: string[];
  required_rule_types: string[];
  pull_request: Record<string, unknown>;
}

/**
 * The on-disk shape of `.github/rulesets/general-branch.json`: one shared
 * declared ruleset plus the flat list of repos it is asserted against. There are
 * no per-repo overrides — bypass actors are intentionally not diffed (see
 * `diffRuleset` / the P1 progress log), and everything else is uniform.
 */
export interface DesiredRulesetFile {
  shared: SharedRuleset;
  repos: string[];
}

/** What `diffRuleset` compares against live config — currently identical to the shared shape. */
export type DesiredRuleset = SharedRuleset;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality for the JSON-shaped values a ruleset parameter can hold. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Order-independent set equality for string arrays (e.g. bypass actor types, ref conditions). */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function diffRuleset(desired: DesiredRuleset, live: unknown): AuditResult {
  const errors: string[] = [];

  if (!isRecord(live)) {
    return { ok: false, errors: [`no '${desired.name}' ruleset found (or it is not an object)`] };
  }

  for (const field of ["name", "target", "enforcement"] as const) {
    if (live[field] !== desired[field]) {
      errors.push(`${field}: expected ${String(desired[field])}, got ${String(live[field])}`);
    }
  }

  const conditions = isRecord(live["conditions"]) ? live["conditions"] : {};
  const refName = isRecord(conditions["ref_name"]) ? conditions["ref_name"] : {};
  const liveInclude = stringArray(refName["include"]);
  if (!sameSet(liveInclude, desired.conditions_ref_include)) {
    errors.push(
      `conditions.ref_name.include: expected ${JSON.stringify(desired.conditions_ref_include)}, got ${JSON.stringify(liveInclude)}`,
    );
  }

  // A live `exclude` that names the default branch exempts it from the whole
  // ruleset — a total bypass that leaves `include` intact, so it must be diffed
  // too or the gate stays green while protection is silently gone.
  const liveExclude = stringArray(refName["exclude"]);
  if (!sameSet(liveExclude, desired.conditions_ref_exclude)) {
    errors.push(
      `conditions.ref_name.exclude: expected ${JSON.stringify(desired.conditions_ref_exclude)}, got ${JSON.stringify(liveExclude)}`,
    );
  }

  const rules = Array.isArray(live["rules"]) ? live["rules"] : [];
  const liveRuleTypes = new Set(
    rules
      .filter(isRecord)
      .map((r) => r["type"])
      .filter((t): t is string => typeof t === "string"),
  );
  for (const type of desired.required_rule_types) {
    if (!liveRuleTypes.has(type)) {
      errors.push(`missing required rule: ${type}`);
    }
  }

  // Bypass actors are intentionally NOT diffed. The CI credential is a repo-
  // scoped App installation token with `Administration: read`, which returns an
  // EMPTY `bypass_actors` for org-level actors (OrganizationAdmin) — proven live
  // that even adding `organization-administration: read` does not restore it, and
  // reading them would need `Administration: write`, which an audit gate must not
  // hold. Diffing the field against a declared value therefore false-fails on
  // every repo that carries an org-level bypass. Auditing bypass actors is a
  // follow-up requiring a higher-privilege context (see the P1 progress log in
  // docs/infrastructure-roadmap.md).

  const prRule = rules.find((r) => isRecord(r) && r["type"] === "pull_request");
  if (!isRecord(prRule)) {
    return { ok: false, errors: [...errors, "no pull_request rule present"] };
  }

  const params = isRecord(prRule["parameters"]) ? prRule["parameters"] : {};
  for (const [key, want] of Object.entries(desired.pull_request)) {
    const got = params[key];
    if (!sameValue(got, want)) {
      errors.push(
        `pull_request.${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

export function loadDesiredFile(repoRoot: string): DesiredRulesetFile {
  const raw = readFileSync(join(repoRoot, ".github/rulesets/general-branch.json"), "utf8");
  return JSON.parse(raw) as DesiredRulesetFile;
}

/** A `gh` invocation's outcome — never throws; a missing binary/non-zero exit is `ok: false`. */
interface GhResult {
  ok: boolean;
  stdout: string;
}

/** Wraps `Bun.spawnSync` so a missing `gh` binary or non-zero exit both surface as `ok: false`. */
function runGh(args: string[]): GhResult {
  try {
    const proc = Bun.spawnSync(args);
    if (!proc.success) return { ok: false, stdout: "" };
    return { ok: true, stdout: new TextDecoder().decode(proc.stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Decides the CLI's exit code + message from what the per-repo loop observed.
 *
 * INVARIANT: real drift found on any successfully-queried repo is never
 * discarded because a different repo's `gh` call failed. `queried === 0`
 * (every repo unreachable) is the ONLY case that skips green — any drift
 * recorded on a repo that WAS reachable always wins over partial coverage.
 */
export function decideExit(input: { queried: number; errors: string[]; unreachable: string[] }): {
  code: 0 | 1;
  message: string;
} {
  const { queried, errors, unreachable } = input;

  if (queried === 0) {
    return {
      code: 0,
      message:
        "audit:ruleset-drift: skipped — gh unavailable or unauthenticated (needs org-read on nimbus-agent)",
    };
  }

  if (errors.length > 0) {
    const lines = errors.map((err) => `audit:ruleset-drift: ${err}`);
    if (unreachable.length > 0) {
      lines.push(`audit:ruleset-drift: WARNING — could not query: ${unreachable.join(", ")}`);
    }
    return { code: 1, message: lines.join("\n") };
  }

  if (unreachable.length > 0) {
    return {
      code: 0,
      message: `audit:ruleset-drift: OK (${queried} repos) — WARNING: could not query ${unreachable.join(", ")}`,
    };
  }

  return { code: 0, message: `audit:ruleset-drift: OK (${queried} repos)` };
}

if (import.meta.main) {
  const file = loadDesiredFile(process.cwd());
  const repoNames = file.repos;
  const allErrors: string[] = [];
  const unreachable: string[] = [];
  let queried = 0;

  for (const repo of repoNames) {
    const listResult = runGh([
      "gh",
      "api",
      `repos/nimbus-agent/${repo}/rulesets`,
      "--jq",
      `.[] | select(.name=="${file.shared.name}") | .id`,
    ]);
    if (!listResult.ok) {
      unreachable.push(repo);
      continue;
    }

    const id = listResult.stdout.trim();
    if (id === "") {
      // gh succeeded (authenticated, reachable) and simply found no matching
      // ruleset on this repo — that is real drift, not a fail-soft skip.
      queried += 1;
      allErrors.push(`${repo}: no '${file.shared.name}' ruleset found`);
      continue;
    }

    const detailResult = runGh(["gh", "api", `repos/nimbus-agent/${repo}/rulesets/${id}`]);
    if (!detailResult.ok) {
      unreachable.push(repo);
      continue;
    }

    queried += 1;
    const live: unknown = JSON.parse(detailResult.stdout);
    const result = diffRuleset(file.shared, live);
    for (const err of result.errors) allErrors.push(`${repo}: ${err}`);
  }

  const outcome = decideExit({ queried, errors: allErrors, unreachable });
  if (outcome.code === 1) {
    console.error(outcome.message);
  } else if (outcome.message.includes("skipped")) {
    console.warn(outcome.message);
  } else {
    console.log(outcome.message);
  }
  process.exit(outcome.code);
}
