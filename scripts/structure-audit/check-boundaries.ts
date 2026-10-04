#!/usr/bin/env bun

/**
 * audit:boundaries — runs dependency-cruiser's D1/D2/D3 rules (`.dependency-cruiser.cjs`: no
 * cross-package source imports, no cycles, PAL isolation), and refuses to report a pass that the
 * cruise could not have earned.
 *
 * WHY A WRAPPER. From TypeScript 7's arrival (#1049, 2026-08-05) to 2026-10-05, the bare
 * `bunx dependency-cruiser ... packages` this replaces was INERT on a coin flip. dependency-cruiser
 * 18.5.0 parses TypeScript only through `typescript` `>=2.0.0 <7.0.0`. Whether it found one
 * depended on which version Bun's isolated linker happened to link at
 * `node_modules/.bun/node_modules/typescript`, and that choice differs between installs of the SAME
 * lockfile (see `dependency-cruiser-ts6-preload.ts` for the resolution walk). When it found 7, it
 * skipped every `.ts`/`.tsx` file and printed "no dependency violations found (1 modules, 0
 * dependencies cruised)". The one module was `packages/docs/astro.config.mjs`. It exited 0, so the
 * gate read green while enforcing nothing. One CI run per lockfile change on `main` was sampled
 * since then: 19 of 33 were inert, the rest cruised ~1,450 modules. The CI node_modules cache is keyed
 * on `bun.lock`, so whichever outcome the first install of a lockfile drew held for every run
 * after it.
 *
 * WHAT THIS DOES.
 *   1. Pins the compiler. The CLI is spawned under `dependency-cruiser-ts6-preload.ts`, which hands
 *      dependency-cruiser the TypeScript 6 the root `typescript-compiler-api` alias pins. The
 *      install no longer decides whether the gate runs.
 *   2. Reads the verdict from the JSON, not the exit code. In `--output-type json` mode
 *      dependency-cruiser exits 0 even when it finds error-severity violations (measured), so the
 *      verdict is computed here from `summary.violations`.
 *   3. Guards the guard. A cruise that did not check the code it guards FAILS, naming why. The
 *      checks are deliberately structural rather than tuned to today's counts:
 *        - dependency-cruiser's own environment diagnosis (`summary.environment.issues`, e.g.
 *          `missing-typescript-transpiler`) is fatal, as is a run with no usable TypeScript
 *          compiler at all;
 *        - COVERAGE: every non-test `.ts`/`.tsx` file under `packages/{gateway,cli,ui}/src` must
 *          be a cruised module. Those three workspaces are what the D1/D3 rules govern, and they
 *          are ~97% of the graph. The set is enumerated from the filesystem, NOT from the config
 *          under test, so a config change that narrows the scope fails here too. It is also not
 *          read from `git ls-files`, because `verify:docker` streams the tree in without `.git`.
 *        - EDGES: on average every cruised module must import at least one other
 *          (`MIN_EDGES_PER_MODULE`). Under `includeOnly`, an import dependency-cruiser cannot
 *          resolve is DROPPED from the output rather than reported (measured), so a resolution
 *          failure leaves every module present and every edge gone;
 *        - LIVENESS: every forbidden rule's `from.path` / `to.path` (minus its `pathNot`) must
 *          match at least one cruised module. A rule whose subjects no longer exist can never
 *          fire. That is how `mcp-connectors-only-import-sdk` sat dead after the connectors left
 *          the repository on 2026-08-27. Liveness is judged only once every other check passes,
 *          because on an empty cruise every scoped rule merely LOOKS dead.
 *   4. Decides in ONE place. `decide` turns a run into every printed line and the exit code CI
 *      reads; the `import.meta.main` block only prints those lines and exits with that code. The
 *      tests drive `decide`, `auditBoundaries`, and the real script itself to both exit codes.
 *
 * STATED BOUND. The edge floor catches edges disappearing WHOLESALE, not partially. A resolver
 * regression that loses one import kind in ten would pass it. Coverage and liveness are exact.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { REPO_ROOT } from "./lib.ts";

/** The Bun preload that pins dependency-cruiser's TypeScript compiler (see its header). */
export const PRELOAD_PATH = join(import.meta.dir, "dependency-cruiser-ts6-preload.ts");

/**
 * Non-test TypeScript sources the cruise MUST have read: the workspaces whose boundaries the rules
 * exist to protect. Test files are excluded because `.dependency-cruiser.cjs` excludes them by
 * design (a test may cross a boundary, e.g. `packages/cli/src/commands/query.test.ts`), and
 * `__fixtures__` because it holds sample inputs, not source. Widen this deliberately, never narrow it
 * to make the guard pass.
 */
export const REQUIRED_SOURCES_GLOB = "packages/{gateway,cli,ui}/src/**/*.{ts,tsx}";
const NOT_REQUIRED = /\.test\.tsx?$|\/__fixtures__\//;

/**
 * Floor on resolved in-repo dependencies per cruised module. Every full CI cruise from 2026-08 to
 * 2026-10 measured 2.2-2.4 (1,463 modules and 3,476 dependencies on 2026-10-04). An import graph
 * whose average module imports less than one in-repo module has lost its edges, not its coupling.
 */
export const MIN_EDGES_PER_MODULE = 1;

const SAMPLE = 5;

export interface CruiseDependency {
  readonly resolved: string;
  readonly couldNotResolve: boolean;
}

export interface CruiseModule {
  readonly source: string;
  readonly dependencies: readonly CruiseDependency[];
}

/** One side (`from` / `to`) of a forbidden rule, as dependency-cruiser normalizes it. */
export interface RuleSide {
  readonly path: string | null;
  readonly pathNot: string | null;
}

export interface ForbiddenRule {
  readonly name: string;
  readonly comment: string | null;
  readonly from: RuleSide;
  readonly to: RuleSide;
}

export interface CruiseViolation {
  readonly ruleName: string;
  readonly severity: string;
  readonly from: string;
  readonly to: string;
  /** For a cycle: the modules after `from`, ending back at `from`. Empty otherwise. */
  readonly cycle: readonly string[];
}

export interface EnvironmentIssue {
  readonly name: string;
  readonly description: string;
}

/** The subset of dependency-cruiser's JSON result this audit reads, validated. */
export interface CruiseResult {
  readonly modules: readonly CruiseModule[];
  readonly violations: readonly CruiseViolation[];
  readonly rules: readonly ForbiddenRule[];
  readonly environmentIssues: readonly EnvironmentIssue[];
  /** The TypeScript compiler dependency-cruiser used, e.g. `typescript@6.0.3`; null when none. */
  readonly typescript: string | null;
}

export interface BoundariesAssessment {
  /** Error-severity rule violations: code that crosses a boundary. */
  readonly violations: readonly string[];
  /** Non-error violations, reported but not failing (dependency-cruiser's own exit semantics). */
  readonly warnings: readonly string[];
  /** Why the cruise cannot be trusted to have checked anything. The gate itself is broken. */
  readonly inert: readonly string[];
  /** One line of counts, printed on success and on failure alike. */
  readonly summary: string;
}

export class CruiseOutputError extends Error {
  constructor(message: string) {
    super(`dependency-cruiser output is not the shape this audit reads: ${message}`);
    this.name = "CruiseOutputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayAt(record: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new CruiseOutputError(`${where}.${key} is not an array`);
  return value;
}

function recordAt(
  record: Record<string, unknown>,
  key: string,
  where: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new CruiseOutputError(`${where}.${key} is not an object`);
  return value;
}

function stringAt(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new CruiseOutputError(`${where}.${key} is not a string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function parseModule(raw: unknown, i: number): CruiseModule {
  const where = `modules[${i}]`;
  if (!isRecord(raw)) throw new CruiseOutputError(`${where} is not an object`);
  const dependencies = arrayAt(raw, "dependencies", where).map((dep, j): CruiseDependency => {
    const at = `${where}.dependencies[${j}]`;
    if (!isRecord(dep)) throw new CruiseOutputError(`${at} is not an object`);
    return {
      resolved: stringAt(dep, "resolved", at),
      couldNotResolve: dep["couldNotResolve"] === true,
    };
  });
  return { source: stringAt(raw, "source", where), dependencies };
}

function parseRuleSide(rule: Record<string, unknown>, key: "from" | "to", where: string): RuleSide {
  const side = rule[key];
  if (side === undefined) return { path: null, pathNot: null };
  if (!isRecord(side)) throw new CruiseOutputError(`${where}.${key} is not an object`);
  return { path: optionalString(side, "path"), pathNot: optionalString(side, "pathNot") };
}

function parseViolation(raw: unknown, i: number): CruiseViolation {
  const where = `summary.violations[${i}]`;
  if (!isRecord(raw)) throw new CruiseOutputError(`${where} is not an object`);
  const rule = recordAt(raw, "rule", where);
  const cycle = Array.isArray(raw["cycle"]) ? raw["cycle"] : [];
  return {
    ruleName: stringAt(rule, "name", `${where}.rule`),
    severity: stringAt(rule, "severity", `${where}.rule`),
    from: stringAt(raw, "from", where),
    to: stringAt(raw, "to", where),
    cycle: cycle.map((hop, j) => {
      if (!isRecord(hop)) throw new CruiseOutputError(`${where}.cycle[${j}] is not an object`);
      return stringAt(hop, "name", `${where}.cycle[${j}]`);
    }),
  };
}

/** Validate dependency-cruiser's `--output-type json` result down to what this audit reads. */
export function parseCruiseResult(raw: unknown): CruiseResult {
  if (!isRecord(raw)) throw new CruiseOutputError("the top level is not an object");
  const summary = recordAt(raw, "summary", "result");
  const ruleSet = recordAt(summary, "ruleSetUsed", "summary");
  const forbidden = Array.isArray(ruleSet["forbidden"]) ? ruleSet["forbidden"] : [];
  const environment = recordAt(summary, "environment", "summary");
  const issues = Array.isArray(environment["issues"]) ? environment["issues"] : [];
  const transpilers = arrayAt(environment, "transpilersFound", "summary.environment");

  const typescript = transpilers.find(
    (t): t is Record<string, unknown> => isRecord(t) && t["name"] === "typescript",
  );

  return {
    modules: arrayAt(raw, "modules", "result").map(parseModule),
    violations: arrayAt(summary, "violations", "summary").map(parseViolation),
    rules: forbidden.map((rule, i): ForbiddenRule => {
      const where = `summary.ruleSetUsed.forbidden[${i}]`;
      if (!isRecord(rule)) throw new CruiseOutputError(`${where} is not an object`);
      return {
        name: stringAt(rule, "name", where),
        comment: optionalString(rule, "comment"),
        from: parseRuleSide(rule, "from", where),
        to: parseRuleSide(rule, "to", where),
      };
    }),
    environmentIssues: issues.map((issue, i): EnvironmentIssue => {
      const where = `summary.environment.issues[${i}]`;
      if (!isRecord(issue)) throw new CruiseOutputError(`${where} is not an object`);
      return {
        name: stringAt(issue, "name", where),
        description: optionalString(issue, "description") ?? "",
      };
    }),
    typescript:
      typescript !== undefined && typescript["available"] === true
        ? (optionalString(typescript, "currentVersion") ?? "typescript")
        : null,
  };
}

/**
 * Every source file the cruise is required to have read, repo-relative with forward slashes (the
 * form dependency-cruiser reports `modules[].source` in, on every OS), sorted.
 */
export function requiredSourceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const hit of new Glob(REQUIRED_SOURCES_GLOB).scanSync({ cwd: repoRoot })) {
    const file = hit.replaceAll("\\", "/");
    if (!NOT_REQUIRED.test(file)) out.push(file);
  }
  return out.sort();
}

function sideMatches(side: RuleSide, source: string): boolean {
  if (side.path !== null && !new RegExp(side.path).test(source)) return false;
  return side.pathNot === null || !new RegExp(side.pathNot).test(source);
}

function sample(items: readonly string[]): string {
  const head = items.slice(0, SAMPLE).join(", ");
  return items.length > SAMPLE ? `${head}, ...` : head;
}

/** One violation, as the lines this audit prints for it. */
export function formatViolation(v: CruiseViolation, comment: string | null): string {
  const path = v.cycle.length > 0 ? [v.from, ...v.cycle] : [v.from, v.to];
  const head = `  ${v.severity} ${v.ruleName}: ${path.join(" → ")}`;
  return comment === null ? head : `${head}\n      ${comment}`;
}

function inertReasons(result: CruiseResult, required: readonly string[], edges: number): string[] {
  const inert: string[] = [];
  for (const issue of result.environmentIssues) {
    const description = issue.description.replaceAll(/\s+/g, " ").trim();
    inert.push(`dependency-cruiser reported '${issue.name}': ${description}`);
  }
  if (result.typescript === null) {
    inert.push(
      "dependency-cruiser found no usable TypeScript compiler, so it skipped every .ts/.tsx file. " +
        "check-boundaries.ts spawns it under dependency-cruiser-ts6-preload.ts, which supplies " +
        "the root `typescript-compiler-api` alias. Check that the alias is installed and is a " +
        "version dependency-cruiser supports.",
    );
  }

  const cruised = new Set(result.modules.map((m) => m.source));
  if (required.length === 0) {
    inert.push(
      `found no source files matching ${REQUIRED_SOURCES_GLOB}. The coverage check has nothing ` +
        "to compare against, which proves nothing. Run the audit from the repository root.",
    );
  }
  const missing = required.filter((file) => !cruised.has(file));
  if (missing.length > 0) {
    inert.push(
      `${missing.length} of ${required.length} required source files (${REQUIRED_SOURCES_GLOB}, ` +
        `non-test) were never cruised, so no rule could fire on them: ${sample(missing)}`,
    );
  }

  const floor = result.modules.length * MIN_EDGES_PER_MODULE;
  if (edges < floor) {
    inert.push(
      `only ${edges} resolved dependencies across ${result.modules.length} modules (floor: ` +
        `${MIN_EDGES_PER_MODULE} per module; full cruises measure ~2.3). Under includeOnly an ` +
        "unresolvable import is dropped rather than reported, so a resolver failure looks like this.",
    );
  }

  if (result.rules.length === 0) {
    inert.push(
      "the cruise loaded no forbidden rules, so nothing could fail. Check that " +
        "`.dependency-cruiser.cjs` still exports a `forbidden` array.",
    );
  }
  // Liveness is judged only on an otherwise complete cruise. On an empty one, every path-scoped
  // rule looks dead, and "delete the rule" would be exactly the wrong advice. The reasons above
  // are the cause, and that is what gets reported.
  if (inert.length > 0) return inert;
  for (const rule of result.rules) {
    for (const [label, side] of [
      ["from", rule.from],
      ["to", rule.to],
    ] as const) {
      if (side.path === null) continue;
      if (result.modules.some((m) => sideMatches(side, m.source))) continue;
      const not = side.pathNot === null ? "" : ` (minus pathNot /${side.pathNot}/)`;
      inert.push(
        `rule '${rule.name}' can never fire: no cruised module matches its ${label}.path ` +
          `/${side.path}/${not}. Fix the path, or delete a rule whose subject no longer exists.`,
      );
    }
  }
  return inert;
}

/** Judge one cruise: its rule violations, and every reason it cannot be trusted. */
export function assessCruise(
  result: CruiseResult,
  required: readonly string[],
): BoundariesAssessment {
  const comments = new Map(result.rules.map((r) => [r.name, r.comment]));
  const formatted = (v: CruiseViolation) => formatViolation(v, comments.get(v.ruleName) ?? null);
  const edges = result.modules.reduce(
    (n, m) => n + m.dependencies.filter((d) => !d.couldNotResolve).length,
    0,
  );
  const covered = required.filter((f) => result.modules.some((m) => m.source === f)).length;
  return {
    violations: result.violations.filter((v) => v.severity === "error").map(formatted),
    warnings: result.violations.filter((v) => v.severity !== "error").map(formatted),
    inert: inertReasons(result, required, edges),
    summary:
      `${result.modules.length} modules, ${edges} dependencies cruised with ` +
      `${result.typescript ?? "NO TypeScript compiler"}; ${covered}/${required.length} required ` +
      `sources covered; ${result.rules.length} rules`,
  };
}

/** Where to cruise, with which config. The repo's own run is `repoInvocation(REPO_ROOT)`. */
export interface CruiseInvocation {
  readonly cwd: string;
  readonly config: string;
  readonly targets: readonly string[];
}

export function repoInvocation(repoRoot: string): CruiseInvocation {
  return { cwd: repoRoot, config: ".dependency-cruiser.cjs", targets: ["packages"] };
}

/** The dependency-cruiser CLI entry point, read from its manifest's `bin` rather than assumed. */
export function dependencyCruiserBin(repoRoot: string): string {
  const pkgDir = join(repoRoot, "node_modules", "dependency-cruiser");
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`dependency-cruiser is not installed at ${pkgDir}. Run \`bun install\`.`);
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = isRecord(manifest) && isRecord(manifest["bin"]) ? manifest["bin"] : null;
  const entry = bin === null ? undefined : bin["dependency-cruiser"];
  if (typeof entry !== "string") {
    throw new Error(`${manifestPath} declares no "dependency-cruiser" bin entry`);
  }
  return join(pkgDir, entry);
}

export function cruiseArgv(repoRoot: string, invocation: CruiseInvocation): string[] {
  return [
    process.execPath,
    "--preload",
    PRELOAD_PATH,
    dependencyCruiserBin(repoRoot),
    "--config",
    invocation.config,
    "--no-progress",
    "--output-type",
    "json",
    ...invocation.targets,
  ];
}

export type CruiseRun =
  | { readonly ok: true; readonly result: CruiseResult; readonly stderr: string }
  | { readonly ok: false; readonly error: string };

/** Spawn one cruise and validate its JSON. Every failure to produce a result is a failed run. */
export function runCruise(repoRoot: string, invocation: CruiseInvocation): CruiseRun {
  const proc = Bun.spawnSync(cruiseArgv(repoRoot, invocation), {
    cwd: invocation.cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stderr = proc.stderr.toString().trim();
  if (proc.exitCode !== 0) {
    return { ok: false, error: `dependency-cruiser exited ${proc.exitCode}: ${stderr}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(proc.stdout.toString());
  } catch (err) {
    return { ok: false, error: `dependency-cruiser printed no JSON (${String(err)}): ${stderr}` };
  }
  try {
    return { ok: true, result: parseCruiseResult(raw), stderr };
  } catch (err) {
    if (err instanceof CruiseOutputError) return { ok: false, error: err.message };
    throw err;
  }
}

/** What the gate prints, in order, and the exit code CI reads. */
export interface AuditOutcome {
  readonly exitCode: 0 | 1;
  /** The one `OK` line, on a pass. Empty on a failure. */
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

/**
 * The gate's verdict on one cruise run: every line it prints and the exit code CI reads. This is
 * the only place that code is decided. A run that produced no result fails, as does any
 * error-severity violation and any reason the cruise is inert; only a pass prints `OK`.
 */
export function decide(run: CruiseRun, required: readonly string[]): AuditOutcome {
  if (!run.ok) return { exitCode: 1, stdout: [], stderr: [`audit:boundaries: ${run.error}`] };
  const verdict = assessCruise(run.result, required);
  const stderr = run.stderr === "" ? [] : [run.stderr];
  stderr.push(...verdict.warnings);
  if (verdict.violations.length > 0) {
    stderr.push(
      `audit:boundaries: ${verdict.violations.length} boundary violation(s):`,
      ...verdict.violations,
    );
  }
  if (verdict.inert.length > 0) {
    stderr.push(
      "audit:boundaries: the cruise did not check the code it guards, so it cannot pass:",
      ...verdict.inert.map((reason) => `  - ${reason}`),
    );
  }
  if (verdict.violations.length > 0 || verdict.inert.length > 0) {
    stderr.push(`audit:boundaries: ${verdict.summary}`);
    return { exitCode: 1, stdout: [], stderr };
  }
  return { exitCode: 0, stdout: [`audit:boundaries: OK (${verdict.summary})`], stderr };
}

/** One cruise of a checkout: `runCruise` in production, a stand-in in tests. */
export type Cruise = (repoRoot: string, invocation: CruiseInvocation) => CruiseRun;

/**
 * The whole gate for one checkout: cruise it, then judge the cruise against the sources enumerated
 * from that same checkout.
 */
export function auditBoundaries(repoRoot: string, cruise: Cruise = runCruise): AuditOutcome {
  return decide(cruise(repoRoot, repoInvocation(repoRoot)), requiredSourceFiles(repoRoot));
}

// Prints and exits, nothing more: every decision is in `decide`. The test file runs this script
// for real, with a canned cruise, to both exit codes.
if (import.meta.main) {
  const outcome = auditBoundaries(REPO_ROOT);
  for (const line of outcome.stderr) console.error(line);
  for (const line of outcome.stdout) console.log(line);
  process.exit(outcome.exitCode);
}
