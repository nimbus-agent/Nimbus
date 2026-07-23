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
  required_rule_types: string[];
  pull_request: Record<string, unknown>;
}

/** The per-repo overrides layered on top of `SharedRuleset`. */
export interface RepoRulesetOverrides {
  bypass_actor_types: string[];
}

/** The on-disk shape of `.github/rulesets/general-branch.json`. */
export interface DesiredRulesetFile {
  shared: SharedRuleset;
  repos: Record<string, RepoRulesetOverrides>;
}

/** `SharedRuleset` merged with one repo's overrides — what `diffRuleset` compares against live config. */
export interface DesiredRuleset extends SharedRuleset {
  bypass_actor_types: string[];
}

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

export function mergeDesired(
  shared: SharedRuleset,
  overrides: RepoRulesetOverrides,
): DesiredRuleset {
  return { ...shared, bypass_actor_types: overrides.bypass_actor_types };
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

  const bypassActors = Array.isArray(live["bypass_actors"]) ? live["bypass_actors"] : [];
  const liveBypassTypes = bypassActors
    .filter(isRecord)
    .map((a) => a["actor_type"])
    .filter((t): t is string => typeof t === "string");
  if (!sameSet(liveBypassTypes, desired.bypass_actor_types)) {
    errors.push(
      `bypass_actor_types: expected ${JSON.stringify(desired.bypass_actor_types)}, got ${JSON.stringify(liveBypassTypes)}`,
    );
  }

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

if (import.meta.main) {
  const file = loadDesiredFile(process.cwd());
  const repoNames = Object.keys(file.repos);
  const allErrors: string[] = [];
  let ghUnavailable = false;

  for (const repo of repoNames) {
    let listProc: ReturnType<typeof Bun.spawnSync>;
    try {
      listProc = Bun.spawnSync([
        "gh",
        "api",
        `repos/nimbus-agent/${repo}/rulesets`,
        "--jq",
        `.[] | select(.name=="${file.shared.name}") | .id`,
      ]);
    } catch {
      ghUnavailable = true;
      break;
    }
    if (!listProc.success) {
      ghUnavailable = true;
      break;
    }

    const id = new TextDecoder().decode(listProc.stdout).trim();
    if (id === "") {
      // gh succeeded (authenticated, reachable) and simply found no matching
      // ruleset on this repo — that is real drift, not a fail-soft skip.
      allErrors.push(`${repo}: no '${file.shared.name}' ruleset found`);
      continue;
    }

    let detailProc: ReturnType<typeof Bun.spawnSync>;
    try {
      detailProc = Bun.spawnSync(["gh", "api", `repos/nimbus-agent/${repo}/rulesets/${id}`]);
    } catch {
      ghUnavailable = true;
      break;
    }
    if (!detailProc.success) {
      ghUnavailable = true;
      break;
    }

    const live: unknown = JSON.parse(new TextDecoder().decode(detailProc.stdout));
    const overrides = file.repos[repo];
    if (overrides === undefined) continue;
    const desired = mergeDesired(file.shared, overrides);
    const result = diffRuleset(desired, live);
    for (const err of result.errors) allErrors.push(`${repo}: ${err}`);
  }

  if (ghUnavailable) {
    console.warn(
      "audit:ruleset-drift: skipped — gh unavailable or unauthenticated (needs org-read on nimbus-agent)",
    );
    process.exit(0);
  }

  if (allErrors.length > 0) {
    for (const err of allErrors) console.error(`audit:ruleset-drift: ${err}`);
    process.exit(1);
  }
  console.log(`audit:ruleset-drift: OK (${repoNames.length} repos)`);
}
