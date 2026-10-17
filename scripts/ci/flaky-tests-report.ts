#!/usr/bin/env bun
// scripts/ci/flaky-tests-report.ts — keep ONE GitHub issue listing the tests that are flaky on CI.
//
// The macOS and Windows test legs retry a failed suite once. When the retry passes, the leg goes
// green and the failure survives only as a warning annotation on that one job, which nobody
// aggregates — so a test can fail on half the runs of a week, cost a re-run every time, and never
// once turn anything red. This script reads those annotations across the window and keeps a
// single issue (`Flaky tests on CI`, label `flaky-tests`) listing them, worst first. It runs
// nightly from `.github/workflows/flaky-tests.yml`.
//
// THE SIGNAL is check-run annotations, not the JUnit artifacts: those are 5–9 MB per leg and
// reading them nightly would cost gigabytes a day, while an annotation list is one small request.
// Two formats are read:
//   - structured, from `scripts/ci/test-with-retry.ts`: a `Retry masked a failure` or
//     `Retry did not help` warning first, then one `Flaky test` warning per test that failed on
//     attempt 1 and passed on the retry (`file=`, `line=`, message `<describe > … > name> (<Type>)`),
//     and on a final failure one `Test failed` error per test still failing (or `Test run failed`);
//   - legacy, from the shell loop it replaced: `Flaky test` warnings whose message is Bun's raw
//     `(fail) <name> [<ms>ms]` line, no file, printed after attempt 1 failed — BEFORE the retry
//     ran, so on their own they say "failed once", not "flaky".
//
// WHAT COUNTS: a test counts once per leg run whose retry passed it. A structured `Flaky test`
// already means that — unless the retry failed without naming a single failing test (killed by
// the time cap, crashed, or an error outside any test), when the emitter still lists every
// attempt-1 failure as flaky although nothing says the retry passed them; those are not counted.
// A legacy one counts only on a leg that ended green, the one case where every attempt-1 failure
// is known to have passed the retry (the leg's own `Retry masked a failure` warning is no help: it
// was printed last, where GitHub's 10-warnings-per-step cap often dropped it — job 117125931902).
// Neither kind of skipped annotation is lost silently: the issue footer counts them.
//
// API BUDGET (GITHUB_TOKEN: ~1,000 requests per hour per repository): one paginated list of the
// window's `CI` runs, one check-run list per finished run, and one annotation list per macOS/
// Windows leg that ran and has annotations — about 350 requests for a busy week. The count is
// printed, and stated in the issue footer.
//
// Usage: bun scripts/ci/flaky-tests-report.ts [--days <1-30>] [--write-issue]
//   Without --write-issue it is a DRY RUN: it prints the issue body and writes nothing.
//   REPO (default nimbus-agent/Nimbus) names the repository; `gh` must be authenticated.

import { appendFile } from "node:fs/promises";

import { isRecord, parseHttpStatus } from "../structure-audit/_gh-audit.ts";

export const ISSUE_TITLE = "Flaky tests on CI";
export const ISSUE_LABEL = "flaky-tests";
/** Rows shown in the issue table; the rest are counted, not listed. */
export const TOP_ROWS = 40;

const LABEL_COLOR = "FBCA04";
const LABEL_DESCRIPTION = "Tests that failed and then passed on a CI leg's retry";
const DEFAULT_REPO = "nimbus-agent/Nimbus";
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const EXAMPLES_PER_ROW = 3;
/** Parallel `gh` processes. Low enough to stay clear of GitHub's secondary rate limits. */
const CONCURRENCY = 4;
const RETRY_DELAY_MS = 3_000;
/** GitHub rejects an issue body longer than this many characters. */
const BODY_LIMIT = 65_536;
const DAY_MS = 86_400_000;
/** The `path` GitHub records for an annotation whose workflow command named no file. */
const NO_FILE = ".github";
const USAGE = "usage: bun scripts/ci/flaky-tests-report.ts [--days <1-30>] [--write-issue]";

const FLAKY_TITLE = "Flaky test";
const MASKED_TITLE = "Retry masked a failure";
const NOT_HELPED_TITLE = "Retry did not help";
const TEST_FAILED_TITLE = "Test failed";
/** The legacy loop's warning for an attempt 1 that failed without a `(fail)` line. */
const LEGACY_UNNAMED_TITLE = "Attempt 1 failed with no (fail) line";

// ── Annotations ───────────────────────────────────────────────────────────────────────────────

/** The fields of a GitHub check-run annotation this report reads. */
export interface Annotation {
  readonly path: string;
  /** `undefined` when the workflow command named no line (GitHub records 0). */
  readonly line: number | undefined;
  /** `notice`, `warning`, or `failure` (an `::error`). */
  readonly level: string;
  readonly title: string;
  readonly message: string;
}

/** The annotations in `gh api --paginate --slurp …/annotations` output (an array of pages). */
export function parseAnnotations(pages: unknown): Annotation[] {
  const out: Annotation[] = [];
  if (!Array.isArray(pages)) return out;
  for (const page of pages as unknown[]) {
    if (!Array.isArray(page)) continue;
    for (const a of page as unknown[]) {
      if (!isRecord(a)) continue;
      const { path, start_line: line, annotation_level: level, title, message } = a;
      if (typeof path !== "string" || typeof level !== "string" || typeof message !== "string") {
        continue;
      }
      out.push({
        path,
        line: typeof line === "number" && line > 0 ? line : undefined,
        level,
        title: typeof title === "string" ? title : "",
        message,
      });
    }
  }
  return out;
}

export interface FlakyObservation {
  readonly format: "structured" | "legacy";
  /** Repo-relative, forward slashes; `undefined` when the annotation names no file. */
  readonly file: string | undefined;
  readonly line: number | undefined;
  /** `describe > … > test`. */
  readonly name: string;
  /** The JUnit failure type (`TimeoutError`, `AssertionError`, …); structured format only. */
  readonly failureType: string | undefined;
}

const LEGACY_PREFIX = "(fail) ";
/** Bun's duration suffix on a `(fail)` line: ` [60001.66ms]`. */
const LEGACY_DURATION = /\s*\[\d+(?:\.\d+)?m?s\]$/;
/** The last parenthesised group is the failure type; the name may carry parentheses of its own. */
const TYPE_SUFFIX = /^(.*\S)\s+\(([^()]+)\)$/;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A `Flaky test` warning as an observation, in either format; `undefined` for anything else. */
export function parseFlakyAnnotation(a: Annotation): FlakyObservation | undefined {
  if (a.level !== "warning" || a.title !== FLAKY_TITLE) return undefined;
  const message = oneLine(a.message);
  if (message === "") return undefined;
  if (message.startsWith(LEGACY_PREFIX)) {
    const name = message.slice(LEGACY_PREFIX.length).replace(LEGACY_DURATION, "").trim();
    if (name === "") return undefined;
    return { format: "legacy", file: undefined, line: undefined, name, failureType: undefined };
  }
  const file = a.path === NO_FILE || a.path === "" ? undefined : a.path.replaceAll("\\", "/");
  const typed = TYPE_SUFFIX.exec(message);
  return {
    format: "structured",
    file,
    line: file === undefined ? undefined : a.line,
    name: typed?.[1] ?? message,
    failureType: typed?.[2],
  };
}

function keyOf(o: { readonly file: string | undefined; readonly name: string }): string {
  return `${o.file ?? ""}\u0000${o.name}`;
}

export interface LegRetry {
  /** The leg needed a retry. */
  readonly retried: boolean;
  /** The retry passed: the leg is green only because of it. */
  readonly masked: boolean;
  /** The flaky tests this leg counts, each once. */
  readonly tests: readonly FlakyObservation[];
  /** Flaky-test annotations NOT counted: the retry gave no verdict on those tests. */
  readonly unverified: number;
}

/** What one leg's annotations say about its retry; `conclusion` is the check run's. */
export function flakyTestsForLeg(
  annotations: readonly Annotation[],
  conclusion: string | null,
): LegRetry {
  const has = (level: string, title: string): boolean =>
    annotations.some((a) => a.level === level && a.title === title);
  // Bun prints each `(fail)` line twice — inline and again in its end-of-run recap — and the
  // legacy loop annotated both.
  const observed = new Map<string, FlakyObservation>();
  for (const a of annotations) {
    const o = parseFlakyAnnotation(a);
    if (o !== undefined && !observed.has(keyOf(o))) observed.set(keyOf(o), o);
  }
  const notHelped = has("warning", NOT_HELPED_TITLE);
  const retried =
    notHelped ||
    has("warning", MASKED_TITLE) ||
    has("warning", LEGACY_UNNAMED_TITLE) ||
    observed.size > 0;
  // The legacy loop printed `Retry masked a failure` last, where the step's 10-warning cap often
  // dropped it — so a leg that retried and ended green is the same fact.
  const masked =
    retried && !notHelped && (has("warning", MASKED_TITLE) || conclusion === "success");
  // A retry that failed without naming one failing test (killed, crashed, an error outside any
  // test) gave no verdict, yet test-with-retry.ts still lists every attempt-1 failure as flaky.
  const inconclusive = notHelped && !has("failure", TEST_FAILED_TITLE);
  const tests = [...observed.values()].filter((o) =>
    o.format === "structured" ? !inconclusive : masked,
  );
  return { retried, masked, tests, unverified: observed.size - tests.length };
}

// ── Runs, legs and check runs ─────────────────────────────────────────────────────────────────

const PR_LEG = /^PR quality — Cross-platform \(([^(){}]+)\)$/;
/** The push legs; the Linux one never retries, so it is not read. */
const PUSH_LEG = /(?:^|\/ )Unit \+ Coverage — ((?:macos|windows)-[\w.-]+)$/;

/** The leg a check run is, by its name — or `undefined` when it is not a retrying test leg. */
export function legLabel(checkRunName: string): string | undefined {
  const pr = PR_LEG.exec(checkRunName)?.[1];
  if (pr !== undefined) return pr;
  const push = PUSH_LEG.exec(checkRunName)?.[1];
  return push === undefined ? undefined : `${push} (push)`;
}

export interface WorkflowRun {
  readonly id: number;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly checkSuiteId: number;
  readonly createdAt: string;
}

/** The objects under `key` on every page of a `--slurp`ed list response. */
function listItems(pages: unknown, key: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (!Array.isArray(pages)) return out;
  for (const page of pages as unknown[]) {
    const list = isRecord(page) ? page[key] : undefined;
    if (Array.isArray(list)) out.push(...(list as unknown[]).filter(isRecord));
  }
  return out;
}

export function parseWorkflowRuns(pages: unknown): WorkflowRun[] {
  const out: WorkflowRun[] = [];
  for (const r of listItems(pages, "workflow_runs")) {
    const { id, event, status, conclusion, check_suite_id: suite, created_at: createdAt } = r;
    if (
      typeof id !== "number" ||
      typeof event !== "string" ||
      typeof status !== "string" ||
      typeof suite !== "number" ||
      typeof createdAt !== "string"
    ) {
      continue;
    }
    const verdict = typeof conclusion === "string" ? conclusion : null;
    out.push({ id, event, status, conclusion: verdict, checkSuiteId: suite, createdAt });
  }
  return out;
}

const SCANNED_EVENTS = new Set(["pull_request", "push"]);

/** Finished, uncancelled push/pull_request runs created since `since`. */
export function selectRuns(
  runs: readonly WorkflowRun[],
  since: string,
): { kept: WorkflowRun[]; skipped: number } {
  const sinceMs = Date.parse(since);
  const kept = runs.filter(
    (r) =>
      SCANNED_EVENTS.has(r.event) &&
      r.status === "completed" &&
      r.conclusion !== "cancelled" &&
      Date.parse(r.createdAt) >= sinceMs,
  );
  return { kept, skipped: runs.length - kept.length };
}

export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  /** The job page. */
  readonly url: string;
  readonly annotationsCount: number;
}

export function parseCheckRuns(pages: unknown): CheckRun[] {
  const out: CheckRun[] = [];
  for (const c of listItems(pages, "check_runs")) {
    const { id, name, conclusion, html_url: url, output } = c;
    if (typeof id !== "number" || typeof name !== "string" || typeof url !== "string") continue;
    const count = isRecord(output) ? output["annotations_count"] : undefined;
    out.push({
      id,
      name,
      conclusion: typeof conclusion === "string" ? conclusion : null,
      url,
      annotationsCount: typeof count === "number" ? count : 0,
    });
  }
  return out;
}

// ── GitHub access ─────────────────────────────────────────────────────────────────────────────

export interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Spawn = (args: readonly string[], stdin: string | undefined) => Promise<SpawnResult>;

export interface Gh {
  /** Every page of a GET (`gh api --paginate --slurp <path>`); one request counted per page. */
  pages(path: string): Promise<unknown[]>;
  /** Any other `gh` command, its stdout; counted as one request. Never retried: it may write. */
  run(args: readonly string[], stdin?: string): Promise<string>;
  /** Requests made so far. */
  calls(): number;
}

export function createGh(spawn: Spawn, sleep: (ms: number) => Promise<void>): Gh {
  let calls = 0;
  const failed = (args: readonly string[], r: SpawnResult): Error =>
    new Error(
      `gh ${args.join(" ")} failed (exit ${String(r.code)}): ${r.stderr.trim() || r.stdout.trim() || "no output"}`,
    );
  return {
    async pages(path) {
      const args = ["api", "--paginate", "--slurp", path];
      for (let attempt = 1; ; attempt += 1) {
        const r = await spawn(args, undefined);
        if (r.code !== 0) {
          calls += 1;
          // A 5xx or a network failure (no HTTP status at all) is worth one more try; a 4xx is not.
          const status = parseHttpStatus(r.stderr);
          if (attempt === 1 && (status === undefined || status >= 500)) {
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          throw failed(args, r);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(r.stdout);
        } catch {
          throw new Error(
            `gh ${args.join(" ")} returned non-JSON output: ${r.stdout.slice(0, 200)}`,
          );
        }
        if (!Array.isArray(parsed)) {
          throw new Error(`gh ${args.join(" ")} did not return an array of pages`);
        }
        const pages: unknown[] = parsed;
        calls += Math.max(1, pages.length);
        return pages;
      }
    },
    async run(args, stdin) {
      const r = await spawn(args, stdin);
      calls += 1;
      if (r.code !== 0) throw failed(args, r);
      return r.stdout;
    },
    calls: () => calls,
  };
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── Collection ────────────────────────────────────────────────────────────────────────────────

export interface LegResult extends LegRetry {
  /** The job page. */
  readonly url: string;
  /** `windows-2025, 2/2`, `macos-15`, `windows-2025 (push)`, … */
  readonly leg: string;
  readonly event: string;
  readonly runCreatedAt: string;
}

export interface Collected {
  readonly runs: { readonly pullRequest: number; readonly push: number; readonly skipped: number };
  /** Retrying test legs that ran to a conclusion. */
  readonly legsRan: number;
  /** One per leg whose annotations were read. */
  readonly legs: readonly LegResult[];
}

/**
 * The window's `CI` runs → their retrying test legs → the annotations of each leg that ran to a
 * conclusion and has any. `filter=all` keeps the legs of every attempt of a re-run workflow, each
 * a real run of the suite; a job that a re-run merely copied carries no annotations and is skipped.
 */
export async function collectLegs(gh: Gh, repo: string, since: string): Promise<Collected> {
  const created = encodeURIComponent(`>=${since}`);
  const runsPath = `repos/${repo}/actions/workflows/ci.yml/runs?created=${created}&per_page=100&exclude_pull_requests=true`;
  const { kept, skipped } = selectRuns(parseWorkflowRuns(await gh.pages(runsPath)), since);

  const perRun = await mapConcurrent(kept, CONCURRENCY, async (run) => {
    const path = `repos/${repo}/check-suites/${String(run.checkSuiteId)}/check-runs?per_page=100&filter=all`;
    return parseCheckRuns(await gh.pages(path)).flatMap((checkRun) => {
      const leg = legLabel(checkRun.name);
      return leg === undefined ? [] : [{ run, checkRun, leg }];
    });
  });
  const ran = perRun
    .flat()
    .filter((l) => l.checkRun.conclusion === "success" || l.checkRun.conclusion === "failure");

  const legs = await mapConcurrent(
    ran.filter((l) => l.checkRun.annotationsCount > 0),
    CONCURRENCY,
    async ({ run, checkRun, leg }): Promise<LegResult> => {
      const path = `repos/${repo}/check-runs/${String(checkRun.id)}/annotations?per_page=100`;
      const annotations = parseAnnotations(await gh.pages(path));
      return {
        url: checkRun.url,
        leg,
        event: run.event,
        runCreatedAt: run.createdAt,
        ...flakyTestsForLeg(annotations, checkRun.conclusion),
      };
    },
  );

  return {
    runs: {
      pullRequest: kept.filter((r) => r.event === "pull_request").length,
      push: kept.filter((r) => r.event === "push").length,
      skipped,
    },
    legsRan: ran.length,
    legs,
  };
}

// ── Aggregation ───────────────────────────────────────────────────────────────────────────────

export interface FlakyRow {
  readonly file: string | undefined;
  readonly line: number | undefined;
  readonly name: string;
  readonly failureTypes: readonly string[];
  /** Leg runs in which the test was flaky. */
  readonly jobs: number;
  readonly pullRequestJobs: number;
  readonly pushJobs: number;
  /** Most flaky first. */
  readonly legs: readonly { readonly leg: string; readonly jobs: number }[];
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Newest first. */
  readonly examples: readonly { readonly url: string; readonly at: string }[];
}

interface Sighting {
  readonly leg: LegResult;
  readonly test: FlakyObservation;
}

interface Group {
  readonly file: string | undefined;
  readonly name: string;
  readonly sightings: Sighting[];
}

/** Code-unit order: deterministic, unlike `localeCompare`'s treatment of punctuation. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A legacy annotation names no file, so one test seen both before and after test-with-retry.ts
 * would split into two rows. When exactly one file has a flaky test of that name, it is that test;
 * when several do, the no-file row is left on its own rather than guessed.
 */
function foldNamelessRows(groups: Map<string, Group>): void {
  const withFile = new Map<string, string[]>();
  for (const [key, g] of groups) {
    if (g.file !== undefined) withFile.set(g.name, [...(withFile.get(g.name) ?? []), key]);
  }
  for (const [key, g] of [...groups]) {
    if (g.file !== undefined) continue;
    const targets = withFile.get(g.name);
    const target = targets?.length === 1 ? groups.get(targets[0] ?? "") : undefined;
    if (target === undefined) continue;
    target.sightings.push(...g.sightings);
    groups.delete(key);
  }
}

function toRow(g: Group): FlakyRow {
  // One count per leg run, however many times the run listed the test.
  const runs = [...new Map(g.sightings.map((s) => [s.leg.url, s])).values()].sort(
    (a, b) =>
      compareText(b.leg.runCreatedAt, a.leg.runCreatedAt) || compareText(a.leg.url, b.leg.url),
  );
  const perLeg = new Map<string, number>();
  for (const s of runs) perLeg.set(s.leg.leg, (perLeg.get(s.leg.leg) ?? 0) + 1);
  const types = new Set<string>();
  for (const s of runs) if (s.test.failureType !== undefined) types.add(s.test.failureType);
  return {
    file: g.file,
    line: runs.find((s) => s.test.line !== undefined)?.test.line,
    name: g.name,
    failureTypes: [...types].sort(compareText),
    jobs: runs.length,
    pullRequestJobs: runs.filter((s) => s.leg.event === "pull_request").length,
    pushJobs: runs.filter((s) => s.leg.event === "push").length,
    legs: [...perLeg]
      .map(([leg, jobs]) => ({ leg, jobs }))
      .sort((a, b) => b.jobs - a.jobs || compareText(a.leg, b.leg)),
    firstSeen: runs.at(-1)?.leg.runCreatedAt ?? "",
    lastSeen: runs[0]?.leg.runCreatedAt ?? "",
    examples: runs
      .slice(0, EXAMPLES_PER_ROW)
      .map((s) => ({ url: s.leg.url, at: s.leg.runCreatedAt })),
  };
}

/** One row per (file-or-unknown, test name), most flaky first, then most recently seen. */
export function aggregateFlakyTests(legs: readonly LegResult[]): FlakyRow[] {
  const groups = new Map<string, Group>();
  for (const leg of legs) {
    for (const test of leg.tests) {
      const key = keyOf(test);
      const group = groups.get(key) ?? { file: test.file, name: test.name, sightings: [] };
      group.sightings.push({ leg, test });
      groups.set(key, group);
    }
  }
  foldNamelessRows(groups);
  return [...groups.values()]
    .map(toRow)
    .sort(
      (a, b) =>
        b.jobs - a.jobs || compareText(b.lastSeen, a.lastSeen) || compareText(a.name, b.name),
    );
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

export interface ReportContext {
  readonly repo: string;
  readonly days: number;
  readonly since: string;
  readonly until: string;
  readonly runs: Collected["runs"];
  readonly legsRan: number;
  readonly legsRead: number;
  readonly legsRetried: number;
  readonly legsMasked: number;
  /** Leg runs that counted at least one flaky test. */
  readonly legsFlaky: number;
  readonly unverified: number;
  readonly apiCalls: number;
  /** This workflow run; `undefined` for a local dry run. */
  readonly runUrl: string | undefined;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** `2026-10-16T09:30:00Z` → `2026-10-16 09:30`. */
function minute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * An inline code span that survives a GFM table cell: the fence outgrows any backtick run inside,
 * and `|` is escaped (GFM honours `\|` even inside a code span). Code spans also keep a test name
 * from @-mentioning anyone or auto-linking an issue number.
 */
function code(text: string): string {
  const flat = oneLine(text);
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat.replaceAll("|", "\\|")}${pad}${fence}`;
}

/** A repo path as a URL path: every segment encoded, parentheses too (they would end the link). */
function urlPath(file: string): string {
  return file
    .split("/")
    .map((s) => encodeURIComponent(s).replaceAll("(", "%28").replaceAll(")", "%29"))
    .join("/");
}

function renderRow(n: number, r: FlakyRow, repo: string): string {
  const types = r.failureTypes.map(code).join(", ");
  const test = types === "" ? code(r.name) : `${code(r.name)}<br>${types}`;
  let file = "—";
  if (r.file !== undefined) {
    const where = r.line === undefined ? r.file : `${r.file}:${String(r.line)}`;
    const anchor = r.line === undefined ? "" : `#L${String(r.line)}`;
    file = `[${code(where)}](https://github.com/${repo}/blob/main/${urlPath(r.file)}${anchor})`;
  }
  const legs = r.legs.map((l) => `${code(l.leg)} ×${String(l.jobs)}`).join("<br>");
  const examples = r.examples.map((e) => `[${e.at.slice(5, 10)}](${e.url})`).join(" ");
  const split = `${String(r.pullRequestJobs)} / ${String(r.pushJobs)}`;
  return `| ${String(n)} | ${test} | ${file} | ${String(r.jobs)} | ${split} | ${legs} | ${r.lastSeen.slice(0, 10)} | ${r.firstSeen.slice(0, 10)} | ${examples} |`;
}

function composeBody(rows: readonly FlakyRow[], shown: number, ctx: ReportContext): string {
  const window = `${minute(ctx.since)} → ${minute(ctx.until)} UTC (${plural(ctx.days, "day")})`;
  const lines = [
    `Tests that **failed on a CI leg's first attempt and passed on its retry**, from \`CI\` runs created ${window}. The retry turned each of those legs green, so nothing went red: this issue is the only place the failures add up. Fix the test, or the code under it, rather than relying on the retry.`,
    "",
  ];
  if (rows.length === 0) {
    lines.push("No test failed on a first attempt and passed on its retry in this window.", "");
  } else {
    const more = rows.length - shown;
    const tail =
      more > 0 ? ` Showing the top ${String(shown)}; ${String(more)} more are not listed.` : "";
    lines.push(
      `**${plural(rows.length, "flaky test")}** across ${plural(ctx.legsFlaky, "leg run")}.${tail}`,
      "",
      "| # | Test | File | Leg runs | PR / push | Legs | Last seen | First seen | Examples |",
      "|--:|------|------|--:|:-:|------|------|------|------|",
      ...rows.slice(0, shown).map((r, i) => renderRow(i + 1, r, ctx.repo)),
      "",
    );
  }
  const source =
    ctx.runUrl === undefined
      ? "a local dry run of `scripts/ci/flaky-tests-report.ts`"
      : `[workflow run](${ctx.runUrl}) of \`.github/workflows/flaky-tests.yml\``;
  const scanned = ctx.runs.pullRequest + ctx.runs.push;
  lines.push(
    "### How this is measured",
    "",
    `- **Window:** \`CI\` runs created ${window}.`,
    `- **Runs:** ${String(scanned)} \`CI\` runs (${String(ctx.runs.pullRequest)} pull_request, ${String(ctx.runs.push)} push); ${String(ctx.runs.skipped)} cancelled or unfinished runs skipped.`,
    `- **Legs:** ${String(ctx.legsRan)} macOS/Windows test legs ran (the PR \`Cross-platform\` legs and the push \`Unit + Coverage\` legs), and the ${String(ctx.legsRead)} with annotations were read: ${String(ctx.legsRetried)} retried, and ${String(ctx.legsMasked)} were green only because of the retry.`,
    `- **Counting:** a test counts once per leg run in which it failed on the first attempt and passed on the retry. A flaky-test annotation is not counted when the retry gave no verdict on it — a leg from before \`scripts/ci/test-with-retry.ts\` whose retry also failed, or a retry that was killed or crashed: ${plural(ctx.unverified, "such annotation")} ${ctx.unverified === 1 ? "was" : "were"} not counted. Legs from before that script name no file (—).`,
    "- **Cap:** GitHub keeps at most 10 warning annotations per step, so a leg with more flaky tests than that names only the first few; before `scripts/ci/test-with-retry.ts` the suite's own output shared the cap and could crowd them out entirely.",
    `- **Source:** ${source}, ${String(ctx.apiCalls)} GitHub API requests. Rewritten nightly: edits to this body are overwritten.`,
    "",
  );
  return lines.join("\n");
}

/** The issue body: the top rows, fewer if that is what fits under GitHub's body limit. */
export function renderIssueBody(rows: readonly FlakyRow[], ctx: ReportContext): string {
  let shown = Math.min(rows.length, TOP_ROWS);
  let body = composeBody(rows, shown, ctx);
  while (body.length > BODY_LIMIT && shown > 0) {
    shown -= 1;
    body = composeBody(rows, shown, ctx);
  }
  return body;
}

export function renderCloseComment(ctx: ReportContext): string {
  const runs = ctx.runs.pullRequest + ctx.runs.push;
  const link = ctx.runUrl === undefined ? "." : `: ${ctx.runUrl}`;
  return `No test failed on a first attempt and passed on its retry in the last ${plural(ctx.days, "day")} of CI (${String(runs)} runs, ${String(ctx.legsRan)} legs scanned), so this is closed. The nightly job opens a new issue when one does${link}`;
}

// ── The issue ─────────────────────────────────────────────────────────────────────────────────

export interface OpenIssue {
  readonly number: number;
  readonly title: string;
}

export type IssueAction =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly number: number }
  | { readonly kind: "close"; readonly number: number }
  | { readonly kind: "none" };

export function parseOpenIssues(raw: unknown): OpenIssue[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).flatMap((i) =>
    isRecord(i) && typeof i["number"] === "number" && typeof i["title"] === "string"
      ? [{ number: i["number"], title: i["title"] }]
      : [],
  );
}

/** Search matches loosely, so only an exact title counts; with two, the oldest is kept current. */
export function planIssueAction(open: readonly OpenIssue[], hasRows: boolean): IssueAction {
  const numbers = open.filter((i) => i.title === ISSUE_TITLE).map((i) => i.number);
  const existing = numbers.length === 0 ? undefined : Math.min(...numbers);
  if (hasRows)
    return existing === undefined ? { kind: "create" } : { kind: "edit", number: existing };
  return existing === undefined ? { kind: "none" } : { kind: "close", number: existing };
}

async function ensureLabel(gh: Gh, repo: string): Promise<void> {
  // `--force` updates the label when it exists, so this is safe to run every night.
  await gh.run([
    "label",
    "create",
    ISSUE_LABEL,
    "--repo",
    repo,
    "--color",
    LABEL_COLOR,
    "--description",
    LABEL_DESCRIPTION,
    "--force",
  ]);
}

/** Carries out `action`; the body goes over stdin, so its size never meets an argv limit. */
export async function applyIssueAction(
  gh: Gh,
  repo: string,
  action: IssueAction,
  body: string,
  closeComment: string,
): Promise<string> {
  switch (action.kind) {
    case "none":
      return "nothing flaky and no open issue: nothing to do";
    case "close":
      await gh.run([
        "issue",
        "close",
        String(action.number),
        "--repo",
        repo,
        "--comment",
        closeComment,
      ]);
      return `nothing flaky: closed #${String(action.number)}`;
    case "create": {
      await ensureLabel(gh, repo);
      const url = await gh.run(
        [
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          ISSUE_TITLE,
          "--label",
          ISSUE_LABEL,
          "--body-file",
          "-",
        ],
        body,
      );
      return `opened ${url.trim()}`;
    }
    case "edit":
      await ensureLabel(gh, repo);
      await gh.run(
        [
          "issue",
          "edit",
          String(action.number),
          "--repo",
          repo,
          "--add-label",
          ISSUE_LABEL,
          "--body-file",
          "-",
        ],
        body,
      );
      return `updated #${String(action.number)}`;
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

export interface Options {
  readonly days: number;
  readonly writeIssue: boolean;
}

/** The options, or a message saying what was wrong. */
export function parseArgs(argv: readonly string[]): Options | string {
  let days = DEFAULT_DAYS;
  let writeIssue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--write-issue") {
      writeIssue = true;
      continue;
    }
    let value: string | undefined;
    if (arg === "--days") {
      i += 1;
      value = argv[i];
    } else if (arg.startsWith("--days=")) {
      value = arg.slice("--days=".length);
    } else {
      return `unknown argument: ${arg}`;
    }
    const n = Number(value);
    if (
      value === undefined ||
      value.trim() === "" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > MAX_DAYS
    ) {
      return `--days takes a whole number from 1 to ${String(MAX_DAYS)}`;
    }
    days = n;
  }
  return { days, writeIssue };
}

export interface MainDeps {
  readonly gh: Gh;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly print: (text: string) => void;
  readonly appendSummary: (markdown: string) => Promise<void>;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Second precision: GitHub's search date syntax takes `2026-10-10T05:41:00Z`. */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function workflowRunUrl(env: MainDeps["env"]): string | undefined {
  const server = nonEmpty(env["GITHUB_SERVER_URL"]);
  const repo = nonEmpty(env["GITHUB_REPOSITORY"]);
  const id = nonEmpty(env["GITHUB_RUN_ID"]);
  if (server === undefined || repo === undefined || id === undefined) return undefined;
  return `${server}/${repo}/actions/runs/${id}`;
}

export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const opts = parseArgs(argv);
  if (typeof opts === "string") {
    deps.print(`flaky-tests-report: ${opts}\n${USAGE}`);
    return 2;
  }
  const repo = nonEmpty(deps.env["REPO"]) ?? DEFAULT_REPO;
  const until = isoSeconds(deps.now);
  const since = isoSeconds(new Date(deps.now.getTime() - opts.days * DAY_MS));
  try {
    const collected = await collectLegs(deps.gh, repo, since);
    const rows = aggregateFlakyTests(collected.legs);
    const legs = collected.legs;
    const ctx: ReportContext = {
      repo,
      days: opts.days,
      since,
      until,
      runs: collected.runs,
      legsRan: collected.legsRan,
      legsRead: legs.length,
      legsRetried: legs.filter((l) => l.retried).length,
      legsMasked: legs.filter((l) => l.masked).length,
      legsFlaky: legs.filter((l) => l.tests.length > 0).length,
      unverified: legs.reduce((sum, l) => sum + l.unverified, 0),
      apiCalls: deps.gh.calls(),
      runUrl: workflowRunUrl(deps.env),
    };
    const body = renderIssueBody(rows, ctx);
    deps.print(body);
    await deps.appendSummary(body);
    if (opts.writeIssue) {
      const listed = await deps.gh.run([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--search",
        `"${ISSUE_TITLE}" in:title`,
        "--json",
        "number,title",
        "--limit",
        "100",
      ]);
      const action = planIssueAction(parseOpenIssues(JSON.parse(listed)), rows.length > 0);
      const done = await applyIssueAction(deps.gh, repo, action, body, renderCloseComment(ctx));
      deps.print(`flaky-tests-report: ${done}`);
    } else {
      deps.print(
        "flaky-tests-report: dry run, nothing written (pass --write-issue to update the issue)",
      );
    }
    deps.print(
      `flaky-tests-report: ${plural(rows.length, "flaky test")} in ${String(ctx.runs.pullRequest + ctx.runs.push)} runs and ${String(ctx.legsRan)} legs; ${String(deps.gh.calls())} GitHub API requests in total.`,
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.print(`::error title=Flaky-tests report failed::${oneLine(message)}`);
    return 1;
  }
}

async function spawnGh(args: readonly string[], stdin: string | undefined): Promise<SpawnResult> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    gh: createGh(spawnGh, (ms) => Bun.sleep(ms)),
    env: process.env,
    now: new Date(),
    print: (text) => console.log(text),
    appendSummary: async (markdown) => {
      const target = nonEmpty(process.env["GITHUB_STEP_SUMMARY"]);
      if (target !== undefined) await appendFile(target, `${markdown}\n`);
    },
  });
  process.exit(code);
}
