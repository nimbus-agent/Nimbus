#!/usr/bin/env bun

/**
 * audit:team-reachability — asserts every org repo is reachable through at least
 * one team's repo grant. Teams were created for the periphery and never extended
 * to the publishing chain; this makes "reachable through a team" a gated
 * property. The pure diff is unit-tested; the CLI lists repos + team grants via
 * `gh` (paginated, archived repos excluded) and is fail-soft / strict.
 */

import { isStrict, runGh, strictSkip } from "./_gh-audit.ts";
import { loadOrgAccess } from "./check-org-settings-drift.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

/** Repos in `allRepos` that appear in no team's grant list and are not exempt. */
export function findUnreachable(
  allRepos: string[],
  teamRepos: string[],
  exempt: string[],
): AuditResult {
  const reachable = new Set(teamRepos);
  const exemptSet = new Set(exempt);
  const errors = allRepos
    .filter((r) => !reachable.has(r) && !exemptSet.has(r))
    .map((r) => `${r}: reachable through no team`);
  return { ok: errors.length === 0, errors };
}

/** Newline-separated `gh --jq` output → trimmed non-empty lines. */
function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const exempt = loadOrgAccess(process.cwd()).team_reachability.exempt;
  const label = "audit:team-reachability";

  const softFail = () => {
    const outcome = strictSkip(
      label,
      strict,
      "reachability indeterminate — could not read all teams/repos",
    );
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  };

  // Active (non-archived) repos. --paginate walks Link headers so the list is
  // never truncated at the 30/page default.
  const reposRes = runGh([
    "gh",
    "api",
    "--paginate",
    "orgs/nimbus-agent/repos",
    "--jq",
    ".[] | select(.archived == false) | .name",
  ]);
  if (!reposRes.ok) softFail();
  const allRepos = lines(reposRes.stdout);

  const teamsRes = runGh([
    "gh",
    "api",
    "--paginate",
    "orgs/nimbus-agent/teams",
    "--jq",
    ".[].slug",
  ]);
  if (!teamsRes.ok) softFail();
  const teamSlugs = lines(teamsRes.stdout);

  const teamRepos: string[] = [];
  for (const slug of teamSlugs) {
    const res = runGh([
      "gh",
      "api",
      "--paginate",
      `orgs/nimbus-agent/teams/${slug}/repos`,
      "--jq",
      ".[].name",
    ]);
    if (!res.ok) softFail();
    teamRepos.push(...lines(res.stdout));
  }

  const result = findUnreachable(allRepos, teamRepos, exempt);
  if (!result.ok) {
    for (const err of result.errors) console.error(`${label}: ${err}`);
    process.exit(1);
  }
  console.log(`${label}: OK (${allRepos.length} repos reachable)`);
}
