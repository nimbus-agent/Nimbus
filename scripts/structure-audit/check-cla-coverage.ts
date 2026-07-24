#!/usr/bin/env bun

/**
 * audit:cla-coverage — asserts every gated public repo has `.github/workflows/cla.yml`
 * AND that its CLA signature-version string is identical across all of them, so a
 * missing workflow or a partial version bump goes red. Same fail-soft-local /
 * strict-in-CI contract as the other org-drift-sweep gates.
 */

import { isStrict, runGh, strictSkip } from "./_gh-audit.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

const GATED_REPOS = [
  "Nimbus",
  "nimbus-sdk",
  "nimbus-client",
  "nimbus-vscode",
  "nimbus-web-clipper",
  "awesome-nimbus",
  "nimbus-recipes",
];

/**
 * Pure diff. `live[repo]` is the repo's observed CLA signature-version
 * (e.g. "version1"), "" if a cla.yml exists but no version could be parsed, or
 * `null` if cla.yml is absent. Flags absent workflows, unparseable versions, and
 * any version differing from the first repo's.
 */
export function diffClaCoverage(repos: string[], live: Record<string, string | null>): AuditResult {
  const errors: string[] = [];
  let expected: string | undefined;
  for (const repo of repos) {
    const v = live[repo];
    if (v === null || v === undefined) {
      errors.push(`${repo}: no cla.yml workflow`);
      continue;
    }
    if (v === "") {
      errors.push(`${repo}: cla.yml has no parseable signature version`);
      continue;
    }
    if (expected === undefined) expected = v;
    else if (v !== expected) {
      errors.push(`${repo}: cla version ${v} != ${expected} (partial bump?)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Extract the `version<N>` segment from a `path-to-signatures` line in cla.yml. */
function parseVersion(yaml: string): string {
  const m = yaml.match(/path-to-signatures:\s*['"]?signatures\/(version\d+)\//);
  return m?.[1] ?? "";
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const label = "audit:cla-coverage";

  // Reachability probe. The 7 gated repos are PUBLIC, so reading their contents
  // needs no auth and a per-repo 404 unambiguously means "cla.yml absent" — a
  // real finding, not an auth question. The only fail-soft case is `gh`/network
  // being unavailable at all, which this one probe detects. (This is why we do
  // NOT reuse ruleset-drift's queried===0 heuristic: there, a 404 could mean
  // unauthorized; here it cannot.)
  const probe = runGh(["gh", "api", "repos/nimbus-agent/Nimbus", "--jq", ".name"]);
  if (!probe.ok) {
    const outcome = strictSkip(label, strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  const live: Record<string, string | null> = {};
  for (const repo of GATED_REPOS) {
    const res = runGh([
      "gh",
      "api",
      `repos/nimbus-agent/${repo}/contents/.github/workflows/cla.yml`,
      "--jq",
      ".content",
    ]);
    // Reachability already confirmed by the probe → a failure here is a genuine
    // 404 (file absent), recorded as `null` and flagged by diffClaCoverage.
    if (!res.ok) {
      live[repo] = null;
      continue;
    }
    // `.replace(/\s/g, "")` strips the newlines GitHub inserts into the base64
    // *envelope* of the contents API response — NOT the decoded YAML. Do not
    // "simplify" it away: without it, Buffer decoding of the wrapped base64 fails.
    const yaml = Buffer.from(res.stdout.replace(/\s/g, ""), "base64").toString("utf8");
    live[repo] = parseVersion(yaml);
  }

  const result = diffClaCoverage(GATED_REPOS, live);
  if (!result.ok) {
    for (const err of result.errors) console.error(`${label}: ${err}`);
    process.exit(1);
  }
  console.log(`${label}: OK (${GATED_REPOS.length} repos)`);
}
