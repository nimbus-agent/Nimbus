#!/usr/bin/env bun

/**
 * audit:org-settings-drift — asserts the org's live settings match the desired
 * values in `.github/org-access.json`. Manual UI settings revert silently
 * (`members_can_create_repositories`, `default_repository_permission`); this
 * makes them a gated property. The diff is pure and unit-tested; the CLI reads
 * live config via `gh` and is fail-soft locally / strict in the CI sweep.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

export interface OrgSettings {
  members_can_create_repositories: boolean;
  default_repository_permission: string;
}

export interface OrgAccessFile {
  settings: OrgSettings;
  team_reachability: { exempt: string[] };
}

export function diffOrgSettings(desired: OrgSettings, live: unknown): AuditResult {
  if (!isRecord(live)) {
    return { ok: false, errors: ["org settings response is not an object"] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(desired) as (keyof OrgSettings)[]) {
    if (live[key] !== desired[key]) {
      errors.push(
        `${key}: expected ${JSON.stringify(desired[key])}, got ${JSON.stringify(live[key])}`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export function loadOrgAccess(repoRoot: string): OrgAccessFile {
  const raw = readFileSync(join(repoRoot, ".github/org-access.json"), "utf8");
  return JSON.parse(raw) as OrgAccessFile;
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const desired = loadOrgAccess(process.cwd()).settings;

  const res = runGh([
    "gh",
    "api",
    "orgs/nimbus-agent",
    "--jq",
    "{members_can_create_repositories, default_repository_permission}",
  ]);
  if (!res.ok) {
    const outcome = strictSkip("audit:org-settings-drift", strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  const live: unknown = JSON.parse(res.stdout);
  const result = diffOrgSettings(desired, live);
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:org-settings-drift: ${err}`);
    process.exit(1);
  }
  console.log("audit:org-settings-drift: OK");
}
