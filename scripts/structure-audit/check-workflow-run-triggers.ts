#!/usr/bin/env bun

/**
 * audit:workflow-run-triggers — every `workflow_run` consumer in this repo must
 * name only upstream workflows that an outside contributor cannot cause to run.
 *
 * WHY THIS EXISTS. `publish-package-managers.yml` and `publish-linux-repo.yml`
 * are privileged: they run on `workflow_run`, so they execute in the BASE repo
 * with `secrets.*` in scope (the release-bot App key, `WINGET_PAT`, the GPG
 * signing subkey), and they check out
 * `ref: ${{ github.event.workflow_run.head_sha }}` — i.e. they run code from
 * whatever commit the upstream run was for. Scorecard flags exactly that shape
 * (`DangerousWorkflowID`, "untrusted code checkout"), and the shape IS the
 * classic pwn-request if the upstream is fork-reachable.
 *
 * It is safe here for ONE reason, and only one: the sole upstream is the
 * workflow named "Release", which triggers only on `push:` of a `v*` tag, and
 * pushing a tag to this repo requires write access. There is therefore no
 * fork-PR path to that `head_sha`.
 *
 * The job-level `if:` guards are NOT the control. A fork PR's
 * `workflow_run.head_branch` is the contributor's own branch name, so a branch
 * called `v1` satisfies both `startsWith(..., 'v')` and `!contains(..., '-')`.
 * The premise above is the whole defense — so it gets a gate, not a comment.
 *
 * If anyone later adds `pull_request` / `pull_request_target` / any other
 * outside-reachable trigger to an upstream, the premise silently evaporates and
 * the two publish workflows become a live pwn-request. This gate fails the
 * build at that moment instead.
 *
 * Deny-by-default: an upstream trigger outside FORK_UNREACHABLE_TRIGGERS is a
 * finding even if it looks harmless. Widening that list is a security decision.
 *
 * Local + deterministic (checked-in files only, no network, no token), so it
 * runs in the preflight fast tier. `--root <path>` aims it at another checkout
 * for the org-wide sweep.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";

import { parseRootArg } from "./check-action-sha-pins.ts";

/**
 * Triggers that cannot be fired by someone without write access to this repo,
 * and are therefore safe as the upstream of a privileged `workflow_run`.
 *
 * Deliberately three entries. Each is justified individually; anything not
 * listed is a finding, because the failure direction of a wrong entry here is
 * silent (a fork gains a privileged checkout) while the failure direction of a
 * missing one is loud (a red gate and a human decision).
 *
 * - `push`        — pushing any ref to THIS repo requires write access. A fork's
 *                   push happens in the fork and raises no event here.
 * - `workflow_dispatch` — requires `actions: write` on this repo.
 * - `schedule`    — fired by GitHub from the default branch; no actor input.
 *
 * NOT listed, deliberately: `pull_request` and `pull_request_target` (fork
 * contributors), `issue_comment` / `pull_request_review*` / `fork` / `watch` /
 * `public` (any logged-in user), `repository_dispatch` (indirection through a
 * token whose scope this gate cannot see), and `workflow_run` itself (a chain
 * whose root this gate would have to walk to prove anything).
 */
export const FORK_UNREACHABLE_TRIGGERS: readonly string[] = [
  "push",
  "workflow_dispatch",
  "schedule",
];

export interface WorkflowFile {
  path: string;
  text: string;
}

export interface WorkflowRunTrigger {
  /** Names listed under `on.workflow_run.workflows`; empty means unfiltered. */
  workflows: string[];
}

export interface ParsedWorkflow {
  path: string;
  /** The `name:` field, or the file path — which is what GitHub displays when
   * `name:` is absent, and therefore what `workflows:` would have to match. */
  name: string;
  triggers: string[];
  /** Non-null only when this workflow is itself a `workflow_run` consumer. */
  workflowRun: WorkflowRunTrigger | null;
  parseError: string | null;
}

export interface AuditResult {
  ok: boolean;
  errors: string[];
  /** How many `workflow_run` consumers were examined. 0 means the gate proved
   * nothing — callers that care should assert it is non-zero. */
  checked: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The event names in a workflow's `on:`, across all three YAML spellings
 * (`on: push`, `on: [push, pull_request]`, `on:\n  push:\n    tags: …`).
 */
export function triggerNames(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((e): e is string => typeof e === "string");
  if (isRecord(on)) return Object.keys(on);
  return [];
}

function workflowRunOf(on: unknown): WorkflowRunTrigger | null {
  if (!triggerNames(on).includes("workflow_run")) return null;
  const config = isRecord(on) ? on["workflow_run"] : undefined;
  const listed = isRecord(config) ? config["workflows"] : undefined;
  const workflows = Array.isArray(listed)
    ? listed.filter((e): e is string => typeof e === "string")
    : [];
  return { workflows };
}

export function parseWorkflow(path: string, text: string): ParsedWorkflow {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { path, name: path, triggers: [], workflowRun: null, parseError: message };
  }
  const root = isRecord(doc) ? doc : {};
  // A YAML 1.1 loader reads a bare `on` key as boolean true, which lands as the
  // string property "true". js-yaml >= 4 does not, but reading only "on" would
  // make a loader swap degrade this gate to "no triggers found" — i.e. PASS.
  const on = "on" in root ? root["on"] : root["true"];
  const name = typeof root["name"] === "string" ? root["name"] : path;
  return {
    path,
    name,
    triggers: triggerNames(on),
    workflowRun: workflowRunOf(on),
    parseError: null,
  };
}

function checkUpstream(
  consumer: ParsedWorkflow,
  upstreamName: string,
  byName: ReadonlyMap<string, ParsedWorkflow[]>,
  errors: string[],
): void {
  const matches = byName.get(upstreamName) ?? [];
  if (matches.length === 0) {
    errors.push(
      `${consumer.path}: \`workflow_run.workflows\` names "${upstreamName}", which matches no workflow in this repo — the trigger either never fires or will bind to a workflow that does not exist yet; the safety premise cannot be checked`,
    );
    return;
  }
  for (const upstream of matches) {
    const disallowed = upstream.triggers.filter((t) => !FORK_UNREACHABLE_TRIGGERS.includes(t));
    if (disallowed.length === 0) continue;
    errors.push(
      `${consumer.path}: upstream "${upstreamName}" (${upstream.path}) triggers on ${disallowed
        .map((t) => `\`${t}\``)
        .join(
          ", ",
        )} — an outside contributor can then cause the privileged \`workflow_run\` job to check out and execute their commit. Allowed upstream triggers: ${FORK_UNREACHABLE_TRIGGERS.join(", ")}`,
    );
  }
}

export function auditWorkflowRunTriggers(files: readonly WorkflowFile[]): AuditResult {
  const parsed = files.map((f) => parseWorkflow(f.path, f.text));
  const errors: string[] = [];

  // Fail closed: an unparsable file could be either a consumer or an upstream,
  // and skipping it would silently shrink the audited surface.
  for (const wf of parsed) {
    if (wf.parseError !== null) {
      errors.push(`${wf.path}: could not be parsed as YAML (${wf.parseError})`);
    }
  }

  const byName = new Map<string, ParsedWorkflow[]>();
  for (const wf of parsed) {
    const list = byName.get(wf.name) ?? [];
    list.push(wf);
    byName.set(wf.name, list);
  }

  let checked = 0;
  for (const consumer of parsed) {
    if (consumer.workflowRun === null) continue;
    checked += 1;
    const { workflows } = consumer.workflowRun;
    if (workflows.length === 0) {
      errors.push(
        `${consumer.path}: \`workflow_run\` has no \`workflows:\` filter — it fires on the completion of EVERY workflow in this repo, including the fork-reachable \`pull_request\` ones`,
      );
      continue;
    }
    for (const upstreamName of workflows) {
      checkUpstream(consumer, upstreamName, byName, errors);
    }
  }

  return { ok: errors.length === 0, errors, checked };
}

/**
 * Workflow files as {path, text}; path is relative for readable messages.
 *
 * A repo with no `.github/workflows` has nothing to audit — relevant because
 * `--root` aims this at other checkouts, some of which have no workflows.
 */
export function readWorkflowFiles(repoRoot: string): WorkflowFile[] {
  const dir = join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ path: `.github/workflows/${f}`, text: readFileSync(join(dir, f), "utf8") }));
}

if (import.meta.main) {
  const label = "audit:workflow-run-triggers";
  const root = parseRootArg(process.argv.slice(2));
  const result = auditWorkflowRunTriggers(readWorkflowFiles(root));

  for (const err of result.errors) {
    const [file] = err.split(":");
    console.error(`::error file=${file}::${err}`);
  }
  if (!result.ok) {
    console.error(`${label}: FAILED — ${result.errors.length} finding(s)`);
    process.exit(1);
  }
  console.log(
    `${label}: OK (${result.checked} workflow_run consumer(s), all upstreams write-only)`,
  );
}
