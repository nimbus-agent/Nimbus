#!/usr/bin/env bun
// scripts/ci/test-with-retry.ts — run one `bun test` suite with ONE retry that re-runs only the
// files that failed, whenever the failures can all be attributed to files.
//
// Both macOS/Windows legs (the PR cross-platform legs in `ci.yml` and the push leg in
// `_test-suite.yml`) used to retry by re-running the WHOLE suite: ~13 minutes on a Windows shard,
// ~25 on the push leg, to recover one test that timed out on a starved runner. Over the 41
// windows-2025 2/2 shards measured 2026-10-10 → 10-16, 14 needed that retry.
//
// The retry is targeted only when the report accounts for every failure. Bun leaves a file that
// throws while LOADING out of the JUnit entirely (measured on 1.4.3) and prints it as an
// "Unhandled error between tests" block, so a JUnit-only retry could go green while that file
// stayed broken. Any of these therefore forces the old full re-run: no JUnit report, no Bun summary
// (killed by the time cap, crashed, hung), an `N error` line or an unhandled-error block, or a fail
// count the JUnit cannot match test for test.
//
// The test output is fenced with `::stop-commands::`. GitHub keeps only 10 warnings and 10 errors
// per step, and the suite's own output (Bun's `::error` lines, fixtures that print workflow
// commands) used to spend that quota before the retry warnings were printed, so the warnings that
// said a retry had masked a failure were mostly lost. The annotations are now this script's own,
// built from the JUnit, at most 10 of each kind, the most important first.
//
// An attempt is killed at `--cap-seconds` of wall clock, and, with `--silence-seconds`, once it has
// printed nothing for that long. Under `--parallel`, Bun prints a file's results when the file
// finishes, so a long silence means no worker finished anything. A HUNG worker is not stopped by
// Bun's per-test `--timeout`: on macOS a `node:child_process` child spawned inside a `--parallel`
// worker can exit without Bun ever noticing (oven-sh/bun#41024), and the attempt then idled until
// the cap — three macOS PR legs on 2026-10-16/17 sat 19–22 minutes on one file each. Either kill
// exits 124 and gets a full re-run.
//
// Usage:
//   bun scripts/ci/test-with-retry.ts --label=<l> --cap-seconds=<n> --report-dir=<dir>
//     [--silence-seconds=<n>] [--final-junit=<path>] -- bun test <paths…> <flags…>
//
// Writes `<dir>/junit-attempt-<N>.xml` and `<dir>/attempt-<N>.log` per attempt, appends a block to
// `$GITHUB_STEP_SUMMARY` when a retry ran, and exits with the final attempt's code (2 on misuse).
// `--final-junit` receives the report of record: attempt 1's, or attempt 1's with the retried
// files' suites replaced by the retry's, or the full re-run's. Flags that take a value must be
// written `--flag=value`, except `--timeout <n>` style pairs, which are carried through intact.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FailingCase {
  /** Repo-relative, forward slashes. */
  readonly file: string;
  readonly line: number | undefined;
  /** `describe > … > test`, entities decoded. */
  readonly name: string;
  /** The `<failure type>`: AssertionError, TimeoutError, Error, … */
  readonly type: string;
}

export interface BunSummary {
  readonly pass: number;
  readonly fail: number;
  readonly errors: number;
  readonly ran: number;
  /** A "# Unhandled error between tests" block anywhere in the log. */
  readonly unhandled: boolean;
}

export type RetryPlan =
  | { readonly kind: "targeted"; readonly files: readonly string[] }
  | { readonly kind: "full"; readonly reason: string };

export interface AttemptResult {
  readonly code: number;
  readonly cases: readonly FailingCase[] | undefined;
}

export interface Outcome {
  readonly label: string;
  readonly attempt1: AttemptResult;
  /** Undefined when attempt 1 passed and nothing was retried. */
  readonly plan: RetryPlan | undefined;
  readonly final: AttemptResult | undefined;
}

/** When a running attempt is killed: the wall-clock cap, and optionally a silence limit. */
export interface Limits {
  readonly capSeconds: number;
  readonly silenceSeconds: number | undefined;
}

export interface Deps {
  readonly run: (
    argv: readonly string[],
    limits: Limits,
    logPath: string,
  ) => Promise<{ code: number; output: string }>;
  readonly readText: (path: string) => Promise<string | undefined>;
  readonly writeText: (path: string, text: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly appendSummary: (markdown: string) => Promise<void>;
  readonly emit: (line: string) => void;
}

const MAX_PER_KIND = 10;
const EXIT_TIMEOUT = 124;
const EXIT_USAGE = 2;
const KILL_GRACE_MS = 10_000;
const DRAIN_GRACE_MS = 10_000;
const WATCH_INTERVAL_MS = 1_000;

/**
 * Why a running attempt must be killed now, if it must: `cap` once it has run `capSeconds`,
 * `silence` once it has printed nothing for `silenceSeconds`. The cap is checked first, so an
 * attempt that is both over the cap and silent reports the cap.
 */
export function killReason(
  elapsedMs: number,
  silentMs: number,
  limits: Limits,
): "cap" | "silence" | undefined {
  if (elapsedMs >= limits.capSeconds * 1000) return "cap";
  if (limits.silenceSeconds !== undefined && silentMs >= limits.silenceSeconds * 1000) {
    return "silence";
  }
  return undefined;
}

// ── JUnit ──────────────────────────────────────────────────────────────────────────────────────

const ATTR = /([\w:-]+)="([^"]*)"/g;
const TOKEN =
  /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(\/?)>|<\/testcase>|<(?:failure|error)\b([^>]*?)\/?>/g;

function attrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const [, key, value] = m;
    if (key !== undefined && value !== undefined) out.set(key, value);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e] ?? `&${e};`;
  });
}

function normalizeFile(file: string): string {
  return decodeEntities(file).replaceAll("\\", "/").replace(/^\.\//, "");
}

type OpenCase = { file: string; line: number | undefined; name: string; type: string | undefined };

/**
 * Every failing test case in a Bun JUnit report, in document order — or `undefined` when the text
 * is not a JUnit report at all. Describe names come from the nested `<testsuite>`s; the depth-0
 * suite is the file and is not part of the name.
 */
export function failingCases(xml: string): FailingCase[] | undefined {
  if (!/<testsuites\b/.test(xml)) return undefined;
  const suites: string[] = [];
  const out: FailingCase[] = [];
  let open: OpenCase | undefined;
  for (const m of xml.matchAll(TOKEN)) {
    const tag = m[0];
    if (tag.startsWith("</testsuite")) {
      suites.pop();
    } else if (tag.startsWith("<testsuite")) {
      if (m[2] !== "/") suites.push(decodeEntities(attrs(m[1] ?? "").get("name") ?? ""));
    } else if (tag.startsWith("</testcase")) {
      if (open?.type !== undefined) {
        out.push({ file: open.file, line: open.line, name: open.name, type: open.type });
      }
      open = undefined;
    } else if (tag.startsWith("<testcase")) {
      if (m[4] === "/") continue;
      const a = attrs(m[3] ?? "");
      const line = Number(a.get("line"));
      open = {
        file: normalizeFile(a.get("file") ?? ""),
        line: a.has("line") && Number.isFinite(line) ? line : undefined,
        name: [...suites.slice(1), decodeEntities(a.get("name") ?? "")].join(" > "),
        type: undefined,
      };
    } else if (open !== undefined) {
      open.type = attrs(m[5] ?? "").get("type") ?? "Error";
    }
  }
  return out;
}

interface SuiteBlock {
  readonly file: string;
  readonly text: string;
  readonly counts: Readonly<Record<(typeof COUNTED)[number], number>>;
}

const COUNTED = ["tests", "assertions", "failures", "skipped", "time"] as const;

/** The depth-0 (per-file) `<testsuite>` elements of a report, verbatim. */
function fileSuites(xml: string): SuiteBlock[] {
  const out: SuiteBlock[] = [];
  let depth = 0;
  let start = -1;
  let head = "";
  for (const m of xml.matchAll(/<testsuite\b([^>]*?)(\/?)>|<\/testsuite>/g)) {
    const at = m.index ?? 0;
    const closing = m[0].startsWith("</");
    if (!closing && depth === 0) {
      start = at;
      head = m[1] ?? "";
    }
    const selfClosing = !closing && m[2] === "/";
    if (!closing && !selfClosing) depth += 1;
    if (closing) depth = Math.max(0, depth - 1);
    if (depth === 0 && (closing || selfClosing) && start >= 0) {
      const a = attrs(head);
      const counts = Object.fromEntries(
        COUNTED.map((k) => [k, Number(a.get(k) ?? 0) || 0]),
      ) as Record<(typeof COUNTED)[number], number>;
      out.push({
        file: normalizeFile(a.get("file") ?? a.get("name") ?? ""),
        text: xml.slice(start, at + m[0].length),
        counts,
      });
      start = -1;
    }
  }
  return out;
}

/**
 * Attempt 1's report with every file the retry ran replaced by the retry's suite for it, and the
 * root totals recomputed — the report of record after a targeted retry.
 */
export function mergeJunit(first: string, retry: string): string {
  const retried = fileSuites(retry);
  const replaced = new Set(retried.map((s) => s.file));
  const kept = [...fileSuites(first).filter((s) => !replaced.has(s.file)), ...retried];
  const total = (k: (typeof COUNTED)[number]) => kept.reduce((acc, s) => acc + s.counts[k], 0);
  const root = COUNTED.map(
    (k) => `${k}="${k === "time" ? total(k).toFixed(7) : String(total(k))}"`,
  );
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="bun test" ${root.join(" ")}>`,
    ...kept.map((s) => `  ${s.text}`),
    `</testsuites>`,
    "",
  ].join("\n");
}

// ── Bun's own summary ──────────────────────────────────────────────────────────────────────────

/** ANSI colour codes, in case a run ever prints them; built from the code point, not a literal. */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function lastCount(text: string, word: RegExp): number | undefined {
  const re = new RegExp(String.raw`^\s*(\d+) ${word.source}\s*$`, "gm");
  let found: number | undefined;
  for (const m of text.matchAll(re)) found = Number(m[1]);
  return found;
}

/** The totals Bun prints at the end of a run — or `undefined` when the run never printed them. */
export function parseBunSummary(log: string): BunSummary | undefined {
  const text = log.replaceAll(ANSI_SGR, "");
  let ran: number | undefined;
  for (const m of text.matchAll(/^Ran (\d+) tests? across \d+ files?\./gm)) ran = Number(m[1]);
  if (ran === undefined) return undefined;
  return {
    pass: lastCount(text, /pass/) ?? 0,
    fail: lastCount(text, /fail/) ?? 0,
    errors: lastCount(text, /errors?/) ?? 0,
    ran,
    unhandled: /^# Unhandled error between tests/m.test(text),
  };
}

// ── The retry decision ────────────────────────────────────────────────────────────────────────

/** Targeted only when the JUnit accounts for every failure Bun counted; otherwise a full re-run. */
export function planRetry(
  cases: readonly FailingCase[] | undefined,
  summary: BunSummary | undefined,
): RetryPlan {
  if (summary === undefined) {
    return {
      kind: "full",
      reason: "the run printed no summary — killed by the time cap, crashed or hung",
    };
  }
  if (cases === undefined) {
    return { kind: "full", reason: "no JUnit report to attribute the failures" };
  }
  if (summary.unhandled || summary.errors > 0) {
    return {
      kind: "full",
      reason:
        "an error outside any test (a file that failed to load, or an unhandled error between tests) — the JUnit cannot name it",
    };
  }
  if (cases.length === 0) {
    return { kind: "full", reason: "the run failed but no test failed" };
  }
  if (summary.fail !== cases.length) {
    return {
      kind: "full",
      reason: `Bun counted ${String(summary.fail)} failures but the JUnit names ${String(cases.length)}`,
    };
  }
  return { kind: "targeted", files: [...new Set(cases.map((c) => c.file))].sort() };
}

const DROPPED_WITH_VALUE = new Set(["--shard", "--timings"]);

/**
 * The attempt-1 command with its positional path list replaced by `files` (each `./`-prefixed, so
 * Bun reads it as a path rather than a substring filter), and the flags that must not apply to a
 * handful of re-run files removed: sharding, and reading/writing the per-file timings table.
 */
export function retryArgv(cmd: readonly string[], files: readonly string[]): string[] {
  const rest = cmd.slice(2);
  let i = 0;
  while (i < rest.length && !(rest[i] ?? "").startsWith("-")) i += 1;
  const flags: string[] = [];
  for (let j = i; j < rest.length; j += 1) {
    const f = rest[j] ?? "";
    if (DROPPED_WITH_VALUE.has(f)) {
      j += 1;
      continue;
    }
    if (f === "--update-timings" || f.startsWith("--shard=") || f.startsWith("--timings=")) {
      continue;
    }
    flags.push(f);
  }
  return [...cmd.slice(0, 2), ...files.map((f) => `./${f}`), ...flags];
}

// ── Annotations + summary ─────────────────────────────────────────────────────────────────────

function escapeData(s: string): string {
  return s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(s: string): string {
  return escapeData(s).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function command(
  kind: "warning" | "error",
  props: ReadonlyArray<readonly [string, string | undefined]>,
  message: string,
): string {
  const p = props
    .filter((e): e is readonly [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${k}=${escapeProperty(v)}`)
    .join(",");
  return `::${kind}${p === "" ? "" : ` ${p}`}::${escapeData(message)}`;
}

function caseCommand(kind: "warning" | "error", title: string, c: FailingCase): string {
  const line = c.line === undefined ? undefined : String(c.line);
  return command(
    kind,
    [
      ["file", c.file],
      ["line", line],
      ["title", title],
    ],
    `${c.name} (${c.type})`,
  );
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

function describeAttempt(a: AttemptResult): string {
  if (a.cases !== undefined && a.cases.length > 0) {
    const files = new Set(a.cases.map((c) => c.file)).size;
    return `failed ${plural(a.cases.length, "test")} in ${plural(files, "file")}`;
  }
  return `exited ${String(a.code)} with no failing test named`;
}

function describePlan(plan: RetryPlan): string {
  return plan.kind === "targeted"
    ? `a re-run of only those ${plural(plan.files.length, "file")}`
    : `a full re-run (${plan.reason})`;
}

const caseKey = (c: FailingCase): string => `${c.file}\u0000${c.name}`;

/** At most 10 warnings and 10 errors, the retry summary first. Empty when nothing was retried. */
export function annotationLines(o: Outcome): string[] {
  if (o.plan === undefined || o.final === undefined) return [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const passed = o.final.code === 0;
  warnings.push(
    command(
      "warning",
      [["title", passed ? "Retry masked a failure" : "Retry did not help"]],
      `${o.label}: attempt 1 ${describeAttempt(o.attempt1)}; ${describePlan(o.plan)} ${
        passed ? "passed" : `failed too (exit ${String(o.final.code)})`
      }.`,
    ),
  );
  // A test is flaky only if the retry's report shows it passed. A retry that left no report (killed
  // by the cap, crashed) shows nothing, and naming its attempt-1 failures "Flaky test" would claim
  // otherwise — the nightly flaky-tests report counts exactly these annotations.
  if (o.final.cases !== undefined) {
    const stillFailing = new Set(o.final.cases.map(caseKey));
    for (const c of o.attempt1.cases ?? []) {
      if (!stillFailing.has(caseKey(c))) warnings.push(caseCommand("warning", "Flaky test", c));
    }
  }
  if (!passed) {
    const finalCases = o.final.cases ?? [];
    if (finalCases.length === 0) {
      errors.push(
        command(
          "error",
          [["title", "Test run failed"]],
          `${o.label}: exit ${String(o.final.code)} with no failing test named — a timeout, crash or hang; see the log above.`,
        ),
      );
    }
    for (const c of finalCases) errors.push(caseCommand("error", "Test failed", c));
  }
  return [...warnings.slice(0, MAX_PER_KIND), ...errors.slice(0, MAX_PER_KIND)];
}

/** The step-summary block for a run that needed a retry; empty otherwise. */
export function summaryMarkdown(o: Outcome): string {
  if (o.plan === undefined || o.final === undefined) return "";
  const result = o.final.code === 0 ? "passed" : `failed (exit \`${String(o.final.code)}\`)`;
  const lines = [
    `### ⚠ ${o.label} needed a retry`,
    "",
    `Attempt 1 exited \`${String(o.attempt1.code)}\` — ${describeAttempt(o.attempt1)}. Retry: ${describePlan(o.plan)}. Result: **${result}**.`,
    "",
  ];
  const cases = o.attempt1.cases ?? [];
  if (cases.length > 0) {
    lines.push(
      `<details><summary>Attempt 1 failing tests (${String(cases.length)})</summary>`,
      "",
      "```text",
      ...cases.map((c) => `${c.file} > ${c.name} [${c.type}]`),
      "```",
      "",
      "</details>",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

// ── Running it ────────────────────────────────────────────────────────────────────────────────

interface Options extends Limits {
  readonly label: string;
  readonly reportDir: string;
  readonly finalJunit: string | undefined;
}

function parseOptions(args: readonly string[]): Options | undefined {
  const get = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const positive = (raw: string | undefined): number | undefined => {
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const label = get("label");
  const capSeconds = positive(get("cap-seconds"));
  const silenceRaw = get("silence-seconds");
  const silenceSeconds = positive(silenceRaw);
  const reportDir = get("report-dir")?.replace(/[\\/]+$/, "");
  if (label === undefined || reportDir === undefined || reportDir === "") return undefined;
  if (capSeconds === undefined) return undefined;
  // Given but unusable is a mistake to report, not a watchdog to silently drop.
  if (silenceRaw !== undefined && silenceSeconds === undefined) return undefined;
  return { label, capSeconds, silenceSeconds, reportDir, finalJunit: get("final-junit") };
}

interface Attempt extends AttemptResult {
  readonly xml: string | undefined;
  readonly summary: BunSummary | undefined;
}

async function runAttempt(
  n: number,
  cmd: readonly string[],
  opts: Options,
  deps: Deps,
): Promise<Attempt> {
  // Removed first, so a report left behind by anything earlier can never stand in for this
  // attempt's — a stale report would make an attempt that wrote none look attributable.
  const outfile = `${opts.reportDir}/junit-attempt-${String(n)}.xml`;
  await deps.removeFile(outfile);
  const token = randomUUID().replaceAll("-", "");
  deps.emit(`::stop-commands::${token}`);
  const { code, output } = await deps.run(
    [...cmd, "--reporter=junit", `--reporter-outfile=${outfile}`],
    { capSeconds: opts.capSeconds, silenceSeconds: opts.silenceSeconds },
    `${opts.reportDir}/attempt-${String(n)}.log`,
  );
  deps.emit(`::${token}::`);
  const xml = await deps.readText(outfile);
  return {
    code,
    xml,
    cases: xml === undefined ? undefined : failingCases(xml),
    summary: parseBunSummary(output),
  };
}

function reportOfRecord(plan: RetryPlan, first: Attempt, second: Attempt): string | undefined {
  if (plan.kind === "full") return second.xml;
  if (first.xml !== undefined && second.xml !== undefined) return mergeJunit(first.xml, second.xml);
  return second.xml ?? first.xml;
}

export async function main(argv: readonly string[], deps: Deps = realDeps()): Promise<number> {
  const sep = argv.indexOf("--");
  const opts = sep < 0 ? undefined : parseOptions(argv.slice(0, sep));
  const cmd = sep < 0 ? [] : argv.slice(sep + 1);
  const usable =
    opts !== undefined &&
    cmd[0] === "bun" &&
    cmd[1] === "test" &&
    !cmd.some((a) => a.startsWith("--reporter"));
  if (!usable) {
    console.error(
      "usage: test-with-retry.ts --label=<l> --cap-seconds=<n> --report-dir=<dir> [--silence-seconds=<n>] [--final-junit=<path>] -- bun test <paths…> <flags…> (no --reporter flags: this script owns them)",
    );
    return EXIT_USAGE;
  }

  const first = await runAttempt(1, cmd, opts, deps);
  if (first.code === 0) {
    if (opts.finalJunit !== undefined && first.xml !== undefined) {
      await deps.writeText(opts.finalJunit, first.xml);
    }
    return 0;
  }

  const plan = planRetry(first.cases, first.summary);
  deps.emit(
    `[test-with-retry] ${opts.label}: attempt 1 ${describeAttempt(first)}; retrying with ${describePlan(plan)}.`,
  );
  const second = await runAttempt(
    2,
    plan.kind === "targeted" ? retryArgv(cmd, plan.files) : cmd,
    opts,
    deps,
  );
  const outcome: Outcome = { label: opts.label, attempt1: first, plan, final: second };
  for (const line of annotationLines(outcome)) deps.emit(line);
  await deps.appendSummary(summaryMarkdown(outcome));
  const record = reportOfRecord(plan, first, second);
  if (opts.finalJunit !== undefined && record !== undefined) {
    await deps.writeText(opts.finalJunit, record);
  }
  return second.code;
}

/**
 * Spawns the command, streams its output to ours, and kills it when `killReason` says so (exit
 * 124, like coreutils `timeout`, which the macOS runner lacks). After the child exits, its pipes
 * get a short grace to drain and are then abandoned: a killed `bun test` can leave a worker holding
 * them open, and waiting on that would turn a timeout back into a hang.
 */
async function spawnWithLimits(
  argv: readonly string[],
  limits: Limits,
  logPath: string,
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([...argv], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  const chunks: string[] = [];
  // Structural: Bun's global reader type and node:stream/web's differ, and only cancel() is needed.
  const readers: { cancel: () => Promise<void> }[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lastOutputAt = Date.now();
      process.stdout.write(value);
      chunks.push(decoder.decode(value, { stream: true }));
    }
  };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]).catch(() => undefined);
  let killedFor: "cap" | "silence" | undefined;
  const watch = setInterval(() => {
    const now = Date.now();
    killedFor ??= killReason(now - startedAt, now - lastOutputAt, limits);
    if (killedFor === undefined) return;
    clearInterval(watch);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, WATCH_INTERVAL_MS);
  const exitCode = await child.exited;
  clearInterval(watch);
  await Promise.race([pumps, Bun.sleep(DRAIN_GRACE_MS)]);
  for (const r of readers) r.cancel().catch(() => undefined);
  const output = chunks.join("");
  await mkdir(dirname(logPath), { recursive: true }).catch(() => undefined);
  await writeFile(logPath, output).catch(() => undefined);
  if (killedFor !== undefined) {
    const why =
      killedFor === "cap"
        ? `exceeded ${String(limits.capSeconds)}s`
        : `printed nothing for ${String(limits.silenceSeconds)}s`;
    console.log(`\n[test-with-retry] ${why} — killed (exit ${String(EXIT_TIMEOUT)})`);
    return { code: EXIT_TIMEOUT, output };
  }
  return { code: exitCode, output };
}

function realDeps(): Deps {
  return {
    run: spawnWithLimits,
    readText: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },
    removeFile: async (path) => {
      await rm(path, { force: true });
    },
    appendSummary: async (markdown) => {
      const target = process.env["GITHUB_STEP_SUMMARY"];
      if (markdown !== "" && target !== undefined && target !== "") {
        await appendFile(target, markdown);
      }
    },
    emit: (line) => {
      console.log(line);
    },
  };
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
