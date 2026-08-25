#!/usr/bin/env bun

/**
 * audit:workflow-lint — every GitHub Actions workflow in this repo must be
 * structurally valid and contain only syntactically valid shell.
 *
 * WHY THIS EXISTS. A heredoc body inside a `run: |` block has to start at
 * column 0, and doing so TERMINATES the YAML block scalar — which makes the
 * whole workflow file invalid. GitHub's response to an invalid workflow is
 * uniquely hard to read: it records a run with **zero jobs** and a `failure`
 * conclusion, so the PR goes red with no job, no log, and no annotation. It is
 * easily mistaken for a product failure. This cost a full CI round trip on
 * `install-smoke.yml`.
 *
 * Crucially, `js-yaml` parses that file WITHOUT complaint, so "it parses" is
 * not sufficient validation — hence the explicit column-0 check, which is the
 * real point of this gate.
 *
 * Local + deterministic (checked-in files only, no network, no token), so it
 * runs in the preflight fast tier. `--root <path>` aims it at another checkout.
 *
 * KNOWN GAP, stated rather than implied: `bash -n` is a *parser*, so it catches
 * syntax errors but NOT runtime faults. In particular an unbound variable under
 * `set -u` (e.g. a bare `$XDG_RUNTIME_DIR`) parses fine and still aborts the
 * step at run time. Catching that would need shellcheck-grade analysis.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";

import { parseRootArg } from "../structure-audit/check-action-sha-pins.ts";
import { readWorkflowFiles } from "../structure-audit/check-workflow-run-triggers.ts";

/**
 * Keys allowed to start at column 0 in a workflow file. Anything else there
 * means a block scalar was terminated early — see the header.
 */
export const TOP_LEVEL_KEYS: readonly string[] = [
  "name",
  "on",
  "concurrency",
  "permissions",
  "jobs",
  "env",
  "defaults",
  "run-name",
];

export interface ColumnZeroEscape {
  readonly line: number;
  readonly content: string;
}

export interface BashBody {
  readonly job: string;
  readonly step: string;
  readonly script: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lines starting at column 0 that are not a recognised top-level key.
 *
 * Deliberately textual rather than AST-based: the whole failure mode is that
 * the parser accepts the file, so an AST walk cannot see the problem.
 */
export function findColumnZeroEscapes(text: string): ColumnZeroEscape[] {
  const out: ColumnZeroEscape[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line === "" || /^\s/.test(line)) return;
    // Column-0 comments and document markers are ordinary YAML. 13 of this
    // repo's workflows open with a comment block (156 such lines), so treating
    // them as escapes would fail the gate on a completely valid tree. The
    // trade-off is a comment line inside a heredoc body being skipped — but a
    // heredoc that is ALL comments is not a shape worth chasing.
    if (line.startsWith("#") || line === "---" || line === "...") return;
    const key = /^([A-Za-z_-]+):/.exec(line)?.[1];
    if (key !== undefined && TOP_LEVEL_KEYS.includes(key)) return;
    out.push({ line: i + 1, content: line });
  });
  return out;
}

function shellOf(step: Record<string, unknown>, jobDefault: string | undefined): string {
  const explicit = step["shell"];
  if (typeof explicit === "string") return explicit;
  // GitHub's default `run:` shell is bash on Linux/macOS and pwsh on Windows.
  // We cannot know the runner OS statically (it is often a matrix value), so
  // treat an unspecified shell as bash: this repo always marks its Windows
  // steps `shell: pwsh` explicitly, so the residual false-positive risk is a
  // Windows step that omits `shell:` — which would be a bug regardless.
  return jobDefault ?? "bash";
}

function defaultShell(container: unknown): string | undefined {
  if (!isRecord(container)) return undefined;
  const defaults = container["defaults"];
  if (!isRecord(defaults)) return undefined;
  const run = defaults["run"];
  if (!isRecord(run)) return undefined;
  const shell = run["shell"];
  return typeof shell === "string" ? shell : undefined;
}

/** Every `run:` body that GitHub will execute with bash. */
export function bashRunBodies(text: string): BashBody[] {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return [];
  }
  if (!isRecord(doc)) return [];
  const workflowShell = defaultShell(doc);
  const jobs = doc["jobs"];
  if (!isRecord(jobs)) return [];

  const bodies: BashBody[] = [];
  for (const [jobName, jobRaw] of Object.entries(jobs)) {
    if (!isRecord(jobRaw)) continue;
    const jobShell = defaultShell(jobRaw) ?? workflowShell;
    const steps = jobRaw["steps"];
    if (!Array.isArray(steps)) continue;
    for (const [i, stepRaw] of steps.entries()) {
      if (!isRecord(stepRaw)) continue;
      const script = stepRaw["run"];
      if (typeof script !== "string") continue;
      const shell = shellOf(stepRaw, jobShell);
      if (shell !== "bash" && shell !== "sh") continue;
      const name = stepRaw["name"];
      bodies.push({
        job: jobName,
        step: typeof name === "string" ? name : `step #${String(i + 1)}`,
        script,
      });
    }
  }
  return bodies;
}

/**
 * Jobs that run steps on a runner without declaring `timeout-minutes`.
 *
 * WHY THIS IS A GATE. A job with no `timeout-minutes` inherits GitHub's
 * 360-minute default, so a step that wedges rather than fails holds a runner
 * slot for six hours and, when downstream jobs `needs:` it, holds the whole
 * workflow with it. That is not hypothetical here: on 2026-08-19 the Sandbox
 * leg of `coverage-gates-pal` wedged in its apt step on two concurrent runs —
 * a job that normally finishes in 1-4 minutes — and the fix (`_test-suite.yml`,
 * see the comment above its `timeout-minutes: 30`) capped that one job while
 * seven others across the tree still had no cap at all.
 *
 * Reusable-workflow callers (`uses:` at job level) are skipped, not exempted:
 * GitHub rejects `timeout-minutes` on them outright, and the timeout belongs
 * on the jobs inside the called workflow.
 */
export function jobsWithoutTimeout(text: string): string[] {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    // Unparsable YAML is already reported by `lintWorkflow`; do not pile on.
    return [];
  }
  if (!isRecord(doc)) return [];
  const jobs = doc["jobs"];
  if (!isRecord(jobs)) return [];

  const out: string[] = [];
  for (const [name, jobRaw] of Object.entries(jobs)) {
    if (!isRecord(jobRaw)) continue;
    if (typeof jobRaw["uses"] === "string") continue;
    if (jobRaw["timeout-minutes"] === undefined) out.push(name);
  }
  return out;
}

/**
 * `checkScript` returns an error message, or null when the script is valid.
 * Injected so the pure lint logic is testable without a shell on PATH; the CLI
 * passes a `bash -n` implementation. Omitting it skips the shell check.
 */
export function lintWorkflow(
  file: string,
  text: string,
  checkScript?: (script: string) => string | null,
): string[] {
  const findings: string[] = [];

  try {
    yaml.load(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push(`${file}: could not be parsed as YAML (${message})`);
    // A file that does not parse cannot be walked for steps, but the column-0
    // check below is textual and still applies — and is usually the cause.
  }

  for (const esc of findColumnZeroEscapes(text)) {
    findings.push(
      `${file}:${String(esc.line)}: line starts at column 0 but is not a top-level key ` +
        `(${esc.content.slice(0, 60)}) — this terminates the enclosing block scalar and ` +
        `makes the workflow invalid; GitHub will record a run with zero jobs. If this is a ` +
        `heredoc body, use printf and keep every line indented.`,
    );
  }

  for (const job of jobsWithoutTimeout(text)) {
    findings.push(
      `${file}: job "${job}" declares no \`timeout-minutes\`, so it inherits GitHub's ` +
        `360-minute default — a wedged step holds a runner slot for six hours instead of ` +
        `failing. Add a cap a few times the job's normal runtime.`,
    );
  }

  if (checkScript !== undefined) {
    for (const body of bashRunBodies(text)) {
      const err = checkScript(body.script);
      if (err !== null) {
        findings.push(
          `${file}: bash syntax error in job "${body.job}" step "${body.step}": ${err}`,
        );
      }
    }
  }

  return findings;
}

/** `bash -n` over a temp file; null when the script parses. */
export function makeBashChecker(): ((script: string) => string | null) | null {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-wf-lint-"));
  const scratch = join(dir, "body.sh");
  try {
    writeFileSync(scratch, "true\n");
    execFileSync("bash", ["-n", scratch], { stdio: "pipe" });
  } catch {
    return null;
  }
  return (script: string): string | null => {
    writeFileSync(scratch, script);
    try {
      execFileSync("bash", ["-n", scratch], { stdio: "pipe" });
      return null;
    } catch (e) {
      const err = e as { stderr?: Buffer };
      return String(err.stderr ?? e)
        .replaceAll(scratch, "<step>")
        .trim();
    }
  };
}

if (import.meta.main) {
  const label = "audit:workflow-lint";
  const root = parseRootArg(process.argv.slice(2));
  const files = readWorkflowFiles(root);
  const checker = makeBashChecker();

  const findings: string[] = [];
  for (const f of files) {
    findings.push(...lintWorkflow(f.path, f.text, checker ?? undefined));
  }

  for (const finding of findings) {
    const [file] = finding.split(":");
    console.error(`::error file=${file}::${finding}`);
  }
  if (findings.length > 0) {
    console.error(`${label}: FAILED — ${String(findings.length)} finding(s)`);
    process.exit(1);
  }
  // Say plainly when the shell half did not run, so a green line never
  // overstates what was actually checked.
  const shellNote =
    checker === null
      ? "bash unavailable — YAML + column-0 checks only"
      : `${String(files.reduce((n, f) => n + bashRunBodies(f.text).length, 0))} bash body(ies) parsed`;
  console.log(`${label}: OK (${String(files.length)} workflow(s), ${shellNote})`);
}
