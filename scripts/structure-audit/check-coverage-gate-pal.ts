#!/usr/bin/env bun

/**
 * audit:coverage-gate-pal — keeps the PAL classification behind the Linux-only
 * coverage gates honest, AND keeps the mechanism that consumes it wired.
 *
 * `_test-suite.yml` splits its coverage-threshold gates across two jobs:
 * `coverage-gates-pal` (runs on every OS the workflow is called with) and
 * `coverage-gates-linux` (runs only on the Linux runner). That split is safe
 * only while (a) the Linux-only gates' covered code does not branch on
 * platform, and (b) the two jobs actually carry the conditions that implement
 * the split. This audit fails when:
 *
 *   1. a source file branches on platform but is absent from the allowlist
 *   2. an allowlist entry names a file that no longer branches on platform
 *      (or no longer exists) — stale entries rot in the other direction
 *   3. an allowlisted file declares a gate that is not `pal: true`
 *   4. a matrix entry carries no explicit `pal` field
 *   5. either coverage-gate job is missing, carries an unexpected `if:`, or
 *      holds a matrix entry whose `pal:` contradicts the job it sits in
 *   6. the runner literal in `coverage-gates-linux`'s `if:` does not match the
 *      Linux runner label `ci.yml` actually calls `_test-suite.yml` with
 *
 * Rule 4 is why the field is spelled out on all 24 entries: a new gate must be
 * classified deliberately, never by inheriting a default.
 *
 * Rules 5 and 6 exist because an earlier revision validated the `pal:` fields
 * without ever reading the `if:` lines that consume them. That let a job-level
 * `if: … || matrix.gate.pal` ship green even though `matrix` is not available
 * in a job-level condition — the classification was perfect and the mechanism
 * was inert. Rule 6 closes the matching hole for the runner label, which is now
 * duplicated between `ci.yml` and `_test-suite.yml`: bumping it in one place
 * would otherwise silently drop 15 threshold gates from every caller.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./lib.ts";
import {
  PLATFORM_BRANCHING_ALLOWLIST,
  type PlatformFileEntry,
} from "./platform-branching-allowlist.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

export interface GateEntry {
  name: string;
  /** null when the matrix entry carries no `pal` field at all. */
  pal: boolean | null;
}

export interface AuditDeps {
  /**
   * Overrides the real allowlist. Exists so the fixture tests can red-prove
   * rules 1-3 in isolation against a synthetic repo root — passing a temp dir
   * to the real allowlist would drown the assertion in ~35 "file no longer
   * exists" findings.
   */
  allowlist?: readonly PlatformFileEntry[];
}

const TEST_SUITE = ".github/workflows/_test-suite.yml";
const CI_WORKFLOW = ".github/workflows/ci.yml";

const PAL_JOB = "coverage-gates-pal";
const LINUX_JOB = "coverage-gates-linux";

/**
 * The exact conditions the split depends on.
 *
 * `matrix` is deliberately absent from both: GitHub grants a job-level `if:`
 * only `github`, `needs`, `vars` and `inputs`, because the condition is
 * evaluated before the matrix expands.
 */
const PAL_JOB_IF = "inputs.run-tests";
const LINUX_JOB_IF = /^inputs\.run-tests\s*&&\s*inputs\.runner\s*==\s*'([^']+)'$/;

const TEST_SUITE_CALLER = /^\s*uses:\s*\.\/\.github\/workflows\/_test-suite\.yml\s*$/;

/**
 * Runtime platform branching, or a filename that names an OS.
 *
 * The destructured-import alternative is NOT optional to cover:
 * `import { platform } from "node:os"` is the dominant idiom in this codebase
 * (7 files), and an earlier revision of this audit that matched only
 * `process.platform` missed `doctor-core.ts` — whose gate was consequently
 * classified Linux-only by mistake.
 */
const BRANCHES_ON_PLATFORM = [
  /process\.platform/,
  /os\.platform\(\)/,
  /os\.type\(\)/,
  // import { platform } / { platform as alias } / { arch, platform } from "node:os"
  /import\s*\{[^}]*\b(?:platform|type|arch)\b[^}]*\}\s*from\s*["']node:os["']/,
];
const OS_NAMED_FILE = /\/(win32|darwin|linux)\.ts$/;

function collectSources(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !/\.(?:test|spec)\.tsx?$/.test(entry)
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `src` directory anywhere under `packages/`, at any depth.
 *
 * NOT `packages/{*}/src`: `packages/mcp-connectors/src` does not exist — the 94
 * connectors each have their own `packages/mcp-connectors/{name}/src`. A
 * one-level scan silently skipped all of them, and a detector with a silent
 * blind spot is worse than none, because its green is read as coverage.
 */
function findSrcDirs(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === "src") out.push(full);
    else findSrcDirs(full, out);
  }
  return out;
}

/**
 * Every non-test source file under any `src` directory in `packages/` that
 * branches on the host platform. Tests are excluded deliberately: a
 * cross-platform test branching on `process.platform` is correct, not a finding.
 *
 * Comments are stripped before matching (reusing `stripComments` from
 * `./lib.ts`, the same helper `countAnyInSource` uses): a file that only
 * *mentions* `process.platform` in a comment — e.g. documenting that it
 * deliberately does not branch — must not be reported as a finding. The
 * filename-based `OS_NAMED_FILE` check runs on the path, not the source text,
 * so it is unaffected either way.
 */
export function detectPlatformBranchingFiles(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  const files: string[] = [];
  for (const srcDir of findSrcDirs(packagesDir, [])) {
    collectSources(srcDir, files);
  }
  const hits: string[] = [];
  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1).replace(/\\/g, "/");
    const codeOnly = stripComments(readFileSync(file, "utf8"));
    if (OS_NAMED_FILE.test(`/${rel}`) || BRANCHES_ON_PLATFORM.some((re) => re.test(codeOnly))) {
      hits.push(rel);
    }
  }
  return hits.sort((a, b) => a.localeCompare(b));
}

/** Parses one `gate:` block starting at `start`; returns it and the line after it. */
function parseGateBlockAt(lines: string[], start: number): { gates: GateEntry[]; end: number } {
  // Indentation is measured RELATIVE to the `gate:` key rather than assumed at
  // fixed columns, so reformatting the workflow cannot red this gate for a
  // purely cosmetic change. A parse that breaks anyway fails loud, never
  // silent: zero entries is a hard error, and a name whose `pal:` did not parse
  // stays `null`, which rule 4 reports.
  const gateIndent = (lines[start] ?? "").search(/\S/);
  const gates: GateEntry[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    if (line.search(/\S/) <= gateIndent) break;
    const nameMatch = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (nameMatch?.[1] !== undefined) {
      gates.push({ name: nameMatch[1].replace(/^["']|["']$/g, ""), pal: null });
      continue;
    }
    // Trailing `# comment` is tolerated: `pal: true  # note` is valid YAML and
    // must not be misread as an unset field (which would wrongly trip rule 4).
    const palMatch = line.match(/^\s*pal:\s*(true|false)\s*(?:#.*)?$/);
    const last = gates[gates.length - 1];
    if (palMatch?.[1] !== undefined && last) last.pal = palMatch[1] === "true";
  }
  return { gates, end: i };
}

/**
 * Line-based parse of EVERY coverage-gate matrix in the given YAML, returned as
 * one union. A YAML dependency is not worth taking on for a well-known block,
 * and the sibling audits (check-action-sha-pins) parse workflow YAML the same
 * way.
 *
 * "Every", not "the first": the matrix is split across `coverage-gates-pal` and
 * `coverage-gates-linux`. A first-block-only parse would validate half the
 * entries and report OK on the other half — the classification would silently
 * stop being enforced for whichever job came second.
 */
export function parseCoverageGateMatrix(yaml: string): GateEntry[] {
  const lines = yaml.split(/\r?\n/);
  const gates: GateEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s+gate:\s*$/.test(lines[i] ?? "")) continue;
    const { gates: block, end } = parseGateBlockAt(lines, i);
    gates.push(...block);
    i = end - 1;
  }
  return gates;
}

/**
 * Job name → the lines of that job's block (header line excluded).
 *
 * Blank lines and comments are carried into whichever block is open; they are
 * never treated as job headers, so a `# ── section ──` divider between jobs
 * cannot invent one.
 */
export function splitJobBlocks(yaml: string): Map<string, string[]> {
  const lines = yaml.split(/\r?\n/);
  const jobsIx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const out = new Map<string, string[]>();
  if (jobsIx === -1) return out;
  let current: string[] | null = null;
  let jobIndent = -1;
  for (let i = jobsIx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^\s*#/.test(line)) {
      current?.push(line);
      continue;
    }
    const indent = line.search(/\S/);
    if (indent === 0) break; // dedented back out of `jobs:`
    if (jobIndent === -1) jobIndent = indent;
    const header = indent === jobIndent ? line.match(/^\s*([A-Za-z0-9_-]+):\s*$/) : null;
    if (header?.[1] !== undefined) {
      current = [];
      out.set(header[1], current);
      continue;
    }
    current?.push(line);
  }
  return out;
}

/**
 * The value of a top-level key within a job block (e.g. `if`), or null.
 *
 * The key's indent is derived from the block's own minimum indent rather than
 * assumed, so this reads a job-level `if:` and never a step-level one — which
 * is the whole distinction rule 5 exists to police.
 */
export function jobLevelKey(block: readonly string[], key: string): string | null {
  const meaningful = block.filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
  if (meaningful.length === 0) return null;
  const keyIndent = Math.min(...meaningful.map((l) => l.search(/\S/)));
  const re = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`);
  for (const line of meaningful) {
    if (line.search(/\S/) !== keyIndent) continue;
    const m = line.match(re);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

const RUNNER_IS_MATRIX_OS = /^\s*runner:\s*\$\{\{\s*matrix\.os\s*\}\}\s*$/;

/**
 * Every Linux runner label `ci.yml` calls `_test-suite.yml` with — read from
 * the callers' literal `runner:` inputs and, when that SAME job's `runner:`
 * input is `${{ matrix.os }}`, from that job's own `os:` matrix list.
 *
 * Scoped to `_test-suite.yml` callers on purpose: `ci-rust` and `e2e-desktop`
 * also carry an `os:` matrix, but their runner label has no bearing on whether
 * `coverage-gates-linux` fires. A caller can also carry an `os:` matrix for
 * some unrelated purpose while forwarding a literal `runner:` — that list
 * must not be read as Linux-runner labels just because both keys appear in
 * the same job block.
 */
export function testSuiteLinuxRunners(ciYaml: string): string[] {
  const labels = new Set<string>();
  for (const block of splitJobBlocks(ciYaml).values()) {
    if (!block.some((l) => TEST_SUITE_CALLER.test(l))) continue;
    // The `os:` list is only relevant when THIS job actually forwards
    // `runner: ${{ matrix.os }}` — a caller can carry an unrelated `os:`
    // matrix (e.g. for its own `runs-on`) while passing a literal `runner:`,
    // and that list must not be read as Linux-runner labels for the split.
    const forwardsMatrixOs = block.some((l) => RUNNER_IS_MATRIX_OS.test(l));
    for (const line of block) {
      const direct = line.match(/^\s*runner:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/);
      if (direct?.[1]?.startsWith("ubuntu-")) labels.add(direct[1]);
      if (!forwardsMatrixOs) continue;
      const osList = line.match(/^\s*os:\s*\[(.+)\]\s*$/);
      if (osList?.[1] === undefined) continue;
      for (const raw of osList[1].split(",")) {
        const label = raw.trim().replace(/^["']|["']$/g, "");
        if (label.startsWith("ubuntu-")) labels.add(label);
      }
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

/** Rules 5 + 6: the split's own wiring, not just its classification. */
function checkSplitWiring(testSuiteYaml: string, ciYaml: string | null, errors: string[]): void {
  const jobs = splitJobBlocks(testSuiteYaml);
  const byJob = new Map<string, GateEntry[]>();
  for (const [name, block] of jobs) byJob.set(name, parseCoverageGateMatrix(block.join("\n")));

  for (const [job, expectedPal] of [
    [PAL_JOB, true],
    [LINUX_JOB, false],
  ] as const) {
    const block = jobs.get(job);
    if (!block) {
      errors.push(
        `${TEST_SUITE}: job "${job}" not found — the coverage-gate split must stay two jobs; a job-level \`if:\` cannot read \`matrix\`, so a single merged job cannot express it`,
      );
      continue;
    }
    for (const entry of byJob.get(job) ?? []) {
      if (entry.pal !== null && entry.pal !== expectedPal) {
        errors.push(
          `${TEST_SUITE}: coverage gate "${entry.name}" is \`pal: ${entry.pal}\` but sits in "${job}" — move it to "${expectedPal ? PAL_JOB : LINUX_JOB}" or fix its classification`,
        );
      }
    }
  }

  // 5. the PAL job's condition
  const palBlock = jobs.get(PAL_JOB);
  if (palBlock) {
    const cond = jobLevelKey(palBlock, "if");
    if (cond !== PAL_JOB_IF) {
      errors.push(
        `${TEST_SUITE}: job "${PAL_JOB}" must carry \`if: ${PAL_JOB_IF}\` (found ${cond === null ? "no job-level `if:`" : `\`${cond}\``}) — these gates run on every OS, so the only thing that may gate them is whether tests run at all`,
      );
    }
  }

  // 5 + 6. the Linux job's condition, and the runner literal inside it
  const linuxBlock = jobs.get(LINUX_JOB);
  if (!linuxBlock) return;
  const cond = jobLevelKey(linuxBlock, "if");
  const match = cond === null ? null : LINUX_JOB_IF.exec(cond);
  if (!match?.[1]) {
    errors.push(
      `${TEST_SUITE}: job "${LINUX_JOB}" must carry \`if: inputs.run-tests && inputs.runner == '<linux-runner>'\` (found ${cond === null ? "no job-level `if:`" : `\`${cond}\``}) — without it these gates run once per OS again, or not at all`,
    );
    return;
  }
  const declared = match[1];

  if (ciYaml === null) {
    errors.push(`${CI_WORKFLOW} not found — cannot confirm the runner label "${declared}" is real`);
    return;
  }
  const callerRunners = testSuiteLinuxRunners(ciYaml);
  if (callerRunners.length === 0) {
    errors.push(
      `${CI_WORKFLOW}: no Linux runner label found on any \`_test-suite.yml\` caller — "${declared}" in ${TEST_SUITE} cannot be confirmed`,
    );
    return;
  }
  if (callerRunners.length > 1) {
    errors.push(
      `${CI_WORKFLOW}: \`_test-suite.yml\` is called with more than one Linux runner label (${callerRunners.join(", ")}) — "${declared}" in ${TEST_SUITE} can only match one, so the others would silently skip all ${LINUX_JOB} gates`,
    );
    return;
  }
  if (callerRunners[0] !== declared) {
    errors.push(
      `${TEST_SUITE}: "${LINUX_JOB}" gates on runner "${declared}" but ${CI_WORKFLOW} calls the workflow with "${callerRunners[0]}" — every Linux-only coverage gate would be skipped on every caller`,
    );
  }
}

export function auditCoverageGatePal(repoRoot: string, deps: AuditDeps = {}): AuditResult {
  const errors: string[] = [];
  const allowlist = deps.allowlist ?? PLATFORM_BRANCHING_ALLOWLIST;

  const workflow = join(repoRoot, TEST_SUITE);
  if (!existsSync(workflow)) {
    return { ok: false, errors: [`${TEST_SUITE} not found`] };
  }
  const testSuiteYaml = readFileSync(workflow, "utf8");
  const gates = parseCoverageGateMatrix(testSuiteYaml);
  if (gates.length === 0) {
    return { ok: false, errors: [`${TEST_SUITE}: no coverage-gates matrix entries found`] };
  }

  // 4. every matrix entry classified explicitly
  for (const g of gates) {
    if (g.pal === null) {
      errors.push(
        `${TEST_SUITE}: coverage gate "${g.name}" has no explicit \`pal:\` field — add \`pal: true\` (runs on all 3 OSes) or \`pal: false\` (Linux only)`,
      );
    }
  }

  const palByName = new Map(gates.map((g) => [g.name, g.pal]));
  const allowByFile = new Map(allowlist.map((e) => [e.file, e]));
  const detected = detectPlatformBranchingFiles(repoRoot);
  const detectedSet = new Set(detected);

  // 1. detected but unclassified
  for (const file of detected) {
    if (!allowByFile.has(file)) {
      errors.push(
        `${file}: branches on platform but is not in PLATFORM_BRANCHING_ALLOWLIST — add an entry naming the coverage gate that covers it (or "none"), then make sure that gate is \`pal: true\``,
      );
    }
  }

  // 2. classified but no longer branching
  for (const entry of allowlist) {
    if (!detectedSet.has(entry.file)) {
      errors.push(
        `${entry.file}: listed in PLATFORM_BRANCHING_ALLOWLIST but no longer branches on platform (or no longer exists) — remove the stale entry`,
      );
    }
  }

  // 3. EVERY declared gate must be pal: true — the primary and every co-gate.
  //
  // Checking only `gate` left a hole: a file reachable from two gates named one
  // of them, so demoting the OTHER passed rule 3 while its coverage denominator
  // still contained platform-branching code. `coGates` closes it, and the loop
  // below deliberately treats primary and co-gates identically so the two can
  // never drift apart again.
  for (const entry of allowlist) {
    const declared = [entry.gate, ...(entry.coGates ?? [])].filter((g) => g !== "none");
    for (const gate of declared) {
      if (!palByName.has(gate)) {
        errors.push(
          `${entry.file}: declares coverage gate "${gate}", which is not in the ${TEST_SUITE} matrix`,
        );
        continue;
      }
      if (palByName.get(gate) !== true) {
        errors.push(
          `${entry.file}: branches on platform and is covered by gate "${gate}", but that gate is not \`pal: true\` — its coverage would run on Linux only`,
        );
      }
    }
  }

  // 5 + 6. the split's wiring
  const ciPath = join(repoRoot, CI_WORKFLOW);
  checkSplitWiring(testSuiteYaml, existsSync(ciPath) ? readFileSync(ciPath, "utf8") : null, errors);

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const result = auditCoverageGatePal(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:coverage-gate-pal: ${err}`);
    process.exit(1);
  }
  console.log(`audit:coverage-gate-pal: OK`);
}
