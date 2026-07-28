#!/usr/bin/env bun

/**
 * audit:org-settings-drift — asserts the org's live settings match the desired
 * values in `.github/org-access.json`. Manual UI settings revert silently and
 * the Free plan has no audit log to reconstruct a revert from, so every setting
 * worth keeping has to be a gated property. The diff is pure and unit-tested;
 * the CLI reads live config via `gh` and is fail-soft locally / strict in the
 * CI sweep.
 *
 * The gate reads FOUR endpoints, not one: `GET /orgs/{org}` carries the member
 * and 2FA policy, but `sha_pinning_required`, `default_workflow_permissions`
 * and the fork-PR approval policy each live on a separate Actions endpoint.
 * `ORG_SETTING_SOURCES` is the single place that mapping lives; adding a
 * setting from an already-listed endpoint needs no code change at all — just a
 * key in the matching `.github/org-access.json` block.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyReadFailure, isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

/** A block of declared `key -> expected value` pairs, diffed generically. */
export type DesiredValues = Record<string, string | boolean>;

export interface OrgAccessFile {
  settings: DesiredValues;
  actions: {
    permissions: DesiredValues;
    workflow: DesiredValues;
    fork_pr_contributor_approval: DesiredValues;
  };
  team_reachability: { exempt: string[] };
}

/** One live-state read: which endpoint to ask, and which declared block to diff it against. */
export interface OrgSettingSource {
  /** Prefix on every error line, so a drift report names the endpoint it came from. */
  readonly label: string;
  /** `gh api` path, no leading slash (Git Bash rewrites a leading slash to a filesystem path). */
  readonly endpoint: string;
  /** Picks this source's declared block out of the parsed access file. */
  readonly select: (file: OrgAccessFile) => DesiredValues;
}

/**
 * The read plan. Order is stable so the CLI's output is deterministic, and
 * `orgs/…` stays first because it is the read whose failure most often means
 * "no auth at all".
 */
export const ORG_SETTING_SOURCES: readonly OrgSettingSource[] = [
  {
    label: "org",
    endpoint: "orgs/nimbus-agent",
    select: (f) => f.settings,
  },
  {
    label: "actions/permissions",
    endpoint: "orgs/nimbus-agent/actions/permissions",
    select: (f) => f.actions.permissions,
  },
  {
    label: "actions/permissions/workflow",
    endpoint: "orgs/nimbus-agent/actions/permissions/workflow",
    select: (f) => f.actions.workflow,
  },
  {
    label: "actions/permissions/fork-pr-contributor-approval",
    endpoint: "orgs/nimbus-agent/actions/permissions/fork-pr-contributor-approval",
    select: (f) => f.actions.fork_pr_contributor_approval,
  },
];

/** GitHub setting keys are lowercase snake_case; anything else is a typo, not a field. */
const SETTING_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * Builds the `--jq` projection for a block: `{key_a, key_b}`. Projecting rather
 * than fetching the whole object keeps a failure legible — a key GitHub stopped
 * returning shows up as `got undefined` against the declared name instead of
 * being lost in a 60-field payload. Keys are validated because they come from a
 * checked-in file and are interpolated into the jq program.
 */
export function buildJqProjection(keys: string[]): string {
  if (keys.length === 0) throw new Error("no keys declared");
  for (const key of keys) {
    if (!SETTING_KEY.test(key)) throw new Error(`invalid setting key: ${JSON.stringify(key)}`);
  }
  return `{${keys.join(", ")}}`;
}

export function diffOrgSettings(desired: DesiredValues, live: unknown): AuditResult {
  if (!isRecord(live)) {
    return { ok: false, errors: ["org settings response is not an object"] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(desired)) {
    if (live[key] !== desired[key]) {
      errors.push(
        `${key}: expected ${JSON.stringify(desired[key])}, got ${JSON.stringify(live[key])}`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

/** What one source contributed to the run. */
export interface SourceOutcome {
  label: string;
  /** `read` — diffed. `absent` — HTTP 404, the endpoint is gone. `indeterminate` — 403/5xx/network. */
  status: "read" | "absent" | "indeterminate";
  errors: string[];
}

/**
 * Decides the CLI's exit code + message from what the per-source loop observed.
 *
 * INVARIANT: drift found on a source that WAS readable is never discarded
 * because a different source's `gh` call failed. Only "nothing was readable at
 * all" degrades to the soft/strict skip — which keeps the pre-existing
 * single-endpoint behaviour byte-identical for an unauthenticated local run.
 *
 * A 404 is a finding, not a skip: every endpoint here is declared in
 * `.github/org-access.json`, so its disappearance is drift of the same kind the
 * gate exists to catch. Anything else (a 403 from a token missing
 * `organization-administration:read`, a 5xx, a network blip) is indeterminate —
 * loud in the sweep output, but never silently recorded as compliance.
 */
export function decideExit(input: { outcomes: SourceOutcome[]; strict: boolean }): {
  code: 0 | 1;
  message: string;
} {
  const { outcomes, strict } = input;
  const label = "audit:org-settings-drift";

  const read = outcomes.filter((o) => o.status === "read");
  const absent = outcomes.filter((o) => o.status === "absent");
  const indeterminate = outcomes.filter((o) => o.status === "indeterminate");

  if (read.length === 0 && absent.length === 0) {
    return strictSkip(label, strict);
  }

  const lines: string[] = [];
  for (const outcome of read) {
    for (const err of outcome.errors) lines.push(`${label}: ${outcome.label}: ${err}`);
  }
  for (const outcome of absent) {
    lines.push(`${label}: ${outcome.label}: endpoint returned HTTP 404 — declared but absent`);
  }

  const unread = indeterminate.map((o) => o.label).join(", ");

  if (lines.length > 0) {
    if (indeterminate.length > 0) lines.push(`${label}: WARNING — could not read: ${unread}`);
    return { code: 1, message: lines.join("\n") };
  }

  if (indeterminate.length > 0) {
    return {
      code: 0,
      message: `${label}: OK (${read.length} sources) — WARNING: could not read ${unread}`,
    };
  }

  return { code: 0, message: `${label}: OK (${read.length} sources)` };
}

export function loadOrgAccess(repoRoot: string): OrgAccessFile {
  const raw = readFileSync(join(repoRoot, ".github/org-access.json"), "utf8");
  return JSON.parse(raw) as OrgAccessFile;
}

/** Reads one source and classifies the result. Exported for the CLI only. */
export function readSource(source: OrgSettingSource, file: OrgAccessFile): SourceOutcome {
  const desired = source.select(file);
  const res = runGh([
    "gh",
    "api",
    source.endpoint,
    "--jq",
    buildJqProjection(Object.keys(desired)),
  ]);
  if (!res.ok) {
    const status = classifyReadFailure(res.httpStatus) === "absent" ? "absent" : "indeterminate";
    return { label: source.label, status, errors: [] };
  }
  let live: unknown;
  try {
    live = JSON.parse(res.stdout);
  } catch {
    return { label: source.label, status: "read", errors: ["response was not valid JSON"] };
  }
  return { label: source.label, status: "read", errors: diffOrgSettings(desired, live).errors };
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const file = loadOrgAccess(process.cwd());

  const outcomes = ORG_SETTING_SOURCES.map((source) => readSource(source, file));

  const outcome = decideExit({ outcomes, strict });
  if (outcome.code === 1) console.error(outcome.message);
  else console.log(outcome.message);
  process.exit(outcome.code);
}
