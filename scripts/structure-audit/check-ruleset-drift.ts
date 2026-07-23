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
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

export interface DesiredRuleset {
  repos: string[];
  name: string;
  target: string;
  enforcement: string;
  pull_request: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality for the JSON-shaped values a ruleset parameter can hold. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

  const rules = Array.isArray(live["rules"]) ? live["rules"] : [];
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

export function loadDesired(repoRoot: string): DesiredRuleset {
  const raw = readFileSync(join(repoRoot, ".github/rulesets/general-branch.json"), "utf8");
  return JSON.parse(raw) as DesiredRuleset;
}

if (import.meta.main) {
  const desired = loadDesired(process.cwd());
  const allErrors: string[] = [];

  for (const repo of desired.repos) {
    const proc = Bun.spawnSync([
      "gh",
      "api",
      `repos/nimbus-agent/${repo}/rulesets`,
      "--jq",
      `.[] | select(.name=="${desired.name}") | .id`,
    ]);
    const id = new TextDecoder().decode(proc.stdout).trim();
    if (id === "") {
      allErrors.push(`${repo}: no '${desired.name}' ruleset found`);
      continue;
    }
    const detail = Bun.spawnSync(["gh", "api", `repos/nimbus-agent/${repo}/rulesets/${id}`]);
    const live: unknown = JSON.parse(new TextDecoder().decode(detail.stdout));
    const result = diffRuleset(desired, live);
    for (const err of result.errors) allErrors.push(`${repo}: ${err}`);
  }

  if (allErrors.length > 0) {
    for (const err of allErrors) console.error(`audit:ruleset-drift: ${err}`);
    process.exit(1);
  }
  console.log(`audit:ruleset-drift: OK (${desired.repos.length} repos)`);
}
