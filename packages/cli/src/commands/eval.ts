/**
 * `nimbus eval --package <dir>`: run an extension package's eval suites in the sandbox and print
 * the score. Gateway-free: it spawns the gateway executable's `__nimbus-eval` role, which writes
 * exactly ONE JSON document to stdout, and renders that. The CLI never imports gateway source, so
 * the document type is declared here.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { type EvalReport, parseEvalQuality } from "@nimbus-dev/registry-format";
import { type GatewayLaunchPlan, resolveGatewayLaunch } from "../lib/resolve-gateway-launch.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";

import { type PackCall, withTerminalConsentClient } from "./pack.ts";

export const EVAL_ROLE_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
export const EVAL_ROLE_STDERR_KEEP_BYTES = 64 * 1024;
export const EVAL_ROLE_WALL_CLOCK_MS = 12 * 60 * 1000;

export type EvalRoleDocument =
  | { ok: true; extensionId: string; version: string; report: EvalReport }
  | { ok: false; error: { code: string; message: string } };

export interface EvalSpawnResult {
  code: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  timedOut: boolean;
}

export interface EvalCliDeps {
  launch: () => GatewayLaunchPlan;
  spawnRole: (
    cmd: string[],
    cwd: string | undefined,
    timeoutMs: number,
  ) => Promise<EvalSpawnResult>;
  log: (s: string) => void;
  err: (s: string) => void;
  /** `--extension` only; defaults to the real terminal check. */
  isTTY?: () => boolean;
  /** `--extension` only; defaults to the terminal-only consent client. */
  withClient?: <T>(fn: (call: PackCall) => Promise<T>) => Promise<T>;
}

/** One entry of the gateway's `extension.eval` result. Declared here: the CLI reaches it over IPC only. */
export type ExtensionEvalEntry =
  | { id: string; version: string; ok: true; report: EvalReport }
  | { id: string; version: string | null; ok: false; error: { code: string; message: string } };

const USAGE =
  "usage: nimbus eval --package <dir> [--suite <file>] [--json]\n       nimbus eval --extension <id> [--json]";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isResult(v: unknown): boolean {
  return (
    isObject(v) &&
    typeof v["suite"] === "string" &&
    typeof v["case"] === "string" &&
    typeof v["rubric"] === "string" &&
    typeof v["pass"] === "boolean" &&
    (v["reason"] === null || typeof v["reason"] === "string")
  );
}

function parseReport(raw: unknown): EvalReport | null {
  if (!isObject(raw) || !Array.isArray(raw["results"])) return null;
  if (!raw["results"].every(isResult)) return null;
  const { results: _results, ...quality } = raw;
  try {
    parseEvalQuality(quality);
  } catch {
    return null;
  }
  const results = raw["results"] as Record<string, unknown>[];
  if (results.length !== raw["cases"]) return null;
  if (results.filter((r) => r["pass"] === true).length !== raw["passed"]) return null;
  return raw as unknown as EvalReport;
}

/** Validate the role's document; null when it is not one. */
export function parseEvalRoleDocument(text: string): EvalRoleDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  if (raw["ok"] === false) {
    const e = raw["error"];
    if (isObject(e) && typeof e["code"] === "string" && typeof e["message"] === "string") {
      return { ok: false, error: { code: e["code"], message: e["message"] } };
    }
    return null;
  }
  if (raw["ok"] !== true) return null;
  if (typeof raw["extensionId"] !== "string" || typeof raw["version"] !== "string") return null;
  const report = parseReport(raw["report"]);
  if (report === null) return null;
  return { ok: true, extensionId: raw["extensionId"], version: raw["version"], report };
}

const EVAL_ROLE_PIPE_GRACE_MS = 2000;

/** Where a pipe reader puts what it reads; each strategy bounds what it retains. */
export interface ByteKeeper {
  push(chunk: Uint8Array): void;
  /** Bytes currently held. */
  retained(): number;
  overflowed(): boolean;
  bytes(): Uint8Array;
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

/** Keeps the first bytes; calls `onOverflow` once past `max` and retains nothing after that. */
export function firstBytesKeeper(max: number, onOverflow: () => void): ByteKeeper {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  return {
    push(chunk) {
      if (over) return;
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size > max) {
        over = true;
        onOverflow();
      }
    },
    retained: () => size,
    overflowed: () => over,
    bytes: () => concatChunks(chunks, size),
  };
}

/**
 * Keeps a rolling tail of `max` bytes, dropping whole leading chunks as it reads, so it never
 * holds more than `max` plus one chunk however long the stream runs.
 */
export function lastBytesKeeper(max: number): ByteKeeper {
  const chunks: Uint8Array[] = [];
  let size = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.byteLength;
      for (let head = chunks[0]; head !== undefined; head = chunks[0]) {
        if (chunks.length === 1 || size - head.byteLength < max) break;
        chunks.shift();
        size -= head.byteLength;
      }
    },
    retained: () => size,
    overflowed: () => false,
    bytes: () => {
      const all = concatChunks(chunks, size);
      return all.byteLength > max ? all.subarray(all.byteLength - max) : all;
    },
  };
}

/**
 * Reads a pipe into `keeper` to its end, or until `stop` settles (the child has exited and a
 * grandchild may still hold the pipe open), then cancels the reader.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  keeper: ByteKeeper,
  stop: Promise<void>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const stopped = stop.then(() => "stop" as const);
  for (;;) {
    const r = await Promise.race([reader.read(), stopped]);
    if (r === "stop") {
      reader.cancel().catch(() => {});
      break;
    }
    if (r.done) break;
    keeper.push(r.value);
  }
  return keeper.bytes();
}

type RoleProcess = ReturnType<typeof Bun.spawn>;

/** Every timer a spawn arms, cleared together when the spawn returns. */
interface SpawnClock {
  timedOut: boolean;
  readonly timers: ReturnType<typeof setTimeout>[];
}

function startRole(cmd: string[], cwd: string | undefined): RoleProcess | EvalSpawnResult {
  try {
    return Bun.spawn(cmd, {
      ...(cwd === undefined ? {} : { cwd }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (e) {
    const msg = `could not start the gateway: ${e instanceof Error ? e.message : String(e)}`;
    return {
      code: null,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(msg),
      timedOut: false,
    };
  }
}

function arm(clock: SpawnClock, ms: number, fn: () => void): void {
  clock.timers.push(setTimeout(fn, ms));
}

/** SIGKILL, unless the child already exited (a kill after exit could reach a reused pid). */
function hardKill(proc: RoleProcess): void {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill(9);
}

/** On the wall-clock deadline: terminate, then kill hard if the child is still there after the grace. */
function armWallClock(proc: RoleProcess, clock: SpawnClock, timeoutMs: number, graceMs: number) {
  arm(clock, timeoutMs, () => {
    clock.timedOut = true;
    proc.kill();
    arm(clock, graceMs, () => hardKill(proc));
  });
}

/**
 * The child's exit code, or null once a final deadline (past the hard kill and its grace) passes
 * without an exit, so the CLI can never block forever on a child the OS would not reap.
 */
function exitedOrAbandoned(
  proc: RoleProcess,
  clock: SpawnClock,
  finalMs: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    arm(clock, finalMs, () => resolve(null));
    proc.exited.then(resolve, () => resolve(null));
  });
}

/** Once the child has gone, the readers get `graceMs` to drain before they are cancelled. */
function graceAfter(exited: Promise<unknown>, clock: SpawnClock, graceMs: number): Promise<void> {
  return exited.then(() => new Promise<void>((r) => arm(clock, graceMs, r)));
}

export async function spawnEvalRoleWithGrace(
  cmd: string[],
  cwd: string | undefined,
  timeoutMs: number,
  graceMs: number,
): Promise<EvalSpawnResult> {
  const proc = startRole(cmd, cwd);
  if (!("pid" in proc)) return proc;
  const clock: SpawnClock = { timedOut: false, timers: [] };
  try {
    armWallClock(proc, clock, timeoutMs, graceMs);
    const exited = exitedOrAbandoned(proc, clock, timeoutMs + 3 * graceMs);
    // A grandchild may still hold the pipes after the child exits: the readers stop after a grace.
    const stop = graceAfter(exited, clock, graceMs);
    const [stdout, stderr, code] = await Promise.all([
      readCapped(
        proc.stdout as ReadableStream<Uint8Array>,
        firstBytesKeeper(EVAL_ROLE_STDOUT_MAX_BYTES, () => proc.kill()),
        stop,
      ),
      readCapped(
        proc.stderr as ReadableStream<Uint8Array>,
        lastBytesKeeper(EVAL_ROLE_STDERR_KEEP_BYTES),
        stop,
      ),
      exited,
    ]);
    return { code, stdout, stderr, timedOut: clock.timedOut };
  } finally {
    for (const t of clock.timers) clearTimeout(t);
  }
}

export const spawnEvalRole: EvalCliDeps["spawnRole"] = (cmd, cwd, timeoutMs) =>
  spawnEvalRoleWithGrace(cmd, cwd, timeoutMs, EVAL_ROLE_PIPE_GRACE_MS);

const realIsTTY = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;
const realWithClient: NonNullable<EvalCliDeps["withClient"]> = (fn) =>
  withTerminalConsentClient(fn, INTERACTIVE_RPC_TIMEOUT_MS);

function defaultDeps(): EvalCliDeps {
  return {
    launch: () => resolveGatewayLaunch(process.execPath, import.meta.url),
    spawnRole: spawnEvalRole,
    log: (s) => console.log(s),
    err: (s) => console.error(s),
    isTTY: realIsTTY,
    withClient: realWithClient,
  };
}

interface ParsedArgs {
  pkg?: string;
  suite?: string;
  extension?: string;
  yes: boolean;
  json: boolean;
  unavailable?: string;
  bad?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--installed") out.unavailable = a;
    else if (a === "--package" || a === "--suite" || a === "--extension") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith(a === "--extension" ? "-" : "--")) {
        out.bad = `${a} needs a value`;
      } else if (a === "--package") out.pkg = v;
      else if (a === "--extension") out.extension = v;
      else out.suite = v;
      i++;
    } else out.bad = `unknown argument: ${a}`;
  }
  return out;
}

function renderReport(subject: { id: string; version: string; report: EvalReport }): string[] {
  const { report } = subject;
  const lines: string[] = [`${subject.id} ${subject.version}`];
  const bySuite = new Map<string, { passed: number; total: number }>();
  for (const r of report.results) {
    const t = bySuite.get(r.suite) ?? { passed: 0, total: 0 };
    t.total += 1;
    if (r.pass) t.passed += 1;
    bySuite.set(r.suite, t);
  }
  for (const [suite, t] of bySuite) lines.push(`${suite}: ${t.passed}/${t.total}`);
  for (const r of report.results) {
    if (!r.pass) lines.push(`  FAIL ${r.suite} ${r.case}: ${r.reason ?? "failed"}`);
  }
  lines.push(`score ${report.score}/100 (${report.passed} of ${report.cases} cases)`);
  lines.push("measured locally; a registry's published score is measured by its CI");
  return lines;
}

function usageProblem(p: ParsedArgs): string | null {
  if (p.unavailable !== undefined) {
    return `nimbus eval ${p.unavailable} is not available yet; use --package <dir>`;
  }
  if (p.bad !== undefined) return `${p.bad}\n${USAGE}`;
  if (p.extension !== undefined) {
    return p.pkg === undefined && p.suite === undefined
      ? null
      : `--extension cannot be combined with --package or --suite\n${USAGE}`;
  }
  return p.pkg === undefined ? USAGE : null;
}

function isInsidePackage(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/**
 * The role matches a suite by its package-relative POSIX path (`evals/x.eval.json`). Accept what a
 * shell hands over — `evals\x.eval.json`, `./evals/...`, an absolute path inside the package — and
 * pass that form; a path outside the package is passed on unchanged (POSIX) for the role to refuse.
 */
export function packageRelativeSuite(pkgAbs: string, suite: string): string {
  const posixSuite = suite.replaceAll("\\", "/");
  const rel = relative(pkgAbs, resolve(pkgAbs, posixSuite)).replaceAll("\\", "/");
  return isInsidePackage(rel) ? rel : posixSuite;
}

function roleArgsFor(pkgArg: string, suite: string | undefined): string[] {
  const pkg = resolve(pkgArg);
  const out = ["__nimbus-eval", "--package", pkg];
  if (suite !== undefined) out.push("--suite", packageRelativeSuite(pkg, suite));
  return out;
}

/** A failure the CLI itself detected (no role document to print). */
type EvalCliErrorCode =
  | "ERR_EVAL_LAUNCH"
  | "ERR_EVAL_WALL_CLOCK"
  | "ERR_EVAL_OUTPUT_TOO_LARGE"
  | "ERR_EVAL_NO_DOCUMENT"
  | "ERR_EVAL_IPC"
  | "ERR_EVAL_BAD_RESPONSE"
  | "ERR_EXTENSION_EVAL_NOT_APPROVED";

type RoleOutcome =
  | { kind: "document"; doc: EvalRoleDocument; text: string }
  | { kind: "failure"; code: EvalCliErrorCode; message: string };

function noDocumentMessage(code: number | null): string {
  if (code === 0 || code === null) return "the eval role printed no valid document";
  return `the eval role exited ${code} without a document`;
}

function interpretRoleResult(res: EvalSpawnResult): RoleOutcome {
  if (res.timedOut) {
    return {
      kind: "failure",
      code: "ERR_EVAL_WALL_CLOCK",
      message: "the eval run exceeded its 12 minute wall-clock limit",
    };
  }
  if (res.stdout.byteLength > EVAL_ROLE_STDOUT_MAX_BYTES) {
    return {
      kind: "failure",
      code: "ERR_EVAL_OUTPUT_TOO_LARGE",
      message: "the eval output was too large",
    };
  }
  const text = new TextDecoder().decode(res.stdout).trim();
  const doc = parseEvalRoleDocument(text);
  if (doc === null) {
    return { kind: "failure", code: "ERR_EVAL_NO_DOCUMENT", message: noDocumentMessage(res.code) };
  }
  return { kind: "document", doc, text };
}

/**
 * Report an eval error and return 2. With `--json` the error is a JSON document on stdout (the
 * role's own, verbatim, when it wrote one); otherwise prose on stderr. The child's stderr tail
 * goes to stderr either way.
 */
function reportFailure(
  d: EvalCliDeps,
  json: boolean,
  failure: { prose: string; document: string },
  tail: string,
): number {
  if (json) d.log(failure.document);
  else d.err(`eval failed: ${failure.prose}`);
  if (tail.length > 0) d.err(tail);
  return 2;
}

function cliFailure(code: EvalCliErrorCode, message: string): { prose: string; document: string } {
  return { prose: message, document: JSON.stringify({ ok: false, error: { code, message } }) };
}

/** Validate `extension.eval`'s answer for the one requested id; null when it is not one. */
function parseExtensionEntry(raw: unknown, id: string): ExtensionEvalEntry | null {
  if (!isObject(raw) || !Array.isArray(raw["results"]) || raw["results"].length !== 1) return null;
  const e: unknown = raw["results"][0];
  if (!isObject(e) || e["id"] !== id) return null;
  if (e["ok"] === true) {
    const report = parseReport(e["report"]);
    if (typeof e["version"] !== "string" || report === null) return null;
    return { id, version: e["version"], ok: true, report };
  }
  if (e["ok"] !== false) return null;
  const err = e["error"];
  if (!isObject(err) || typeof err["code"] !== "string" || typeof err["message"] !== "string") {
    return null;
  }
  const version = typeof e["version"] === "string" ? e["version"] : null;
  return { id, version, ok: false, error: { code: err["code"], message: err["message"] } };
}

const NOT_APPROVED = "ERR_EXTENSION_EVAL_NOT_APPROVED";

/**
 * `--extension <id>`: the gateway evaluates an installed extension behind ONE owner approval. The
 * approval is terminal-only (no `--yes`, no non-TTY), refused before any connection is made.
 */
async function runInstalledEval(p: ParsedArgs, d: EvalCliDeps): Promise<number> {
  if (p.yes) {
    d.err(
      "nimbus eval --extension has no --yes: the approval must be answered by a person at a terminal.",
    );
    return 2;
  }
  if (!(d.isTTY ?? realIsTTY)()) {
    d.err(
      "Refusing to evaluate an extension in non-TTY mode: the approval must be answered at a terminal.",
    );
    return 2;
  }
  const withClient = d.withClient ?? realWithClient;
  const id = p.extension ?? "";
  let entry: ExtensionEvalEntry | null;
  try {
    const raw = await withClient((call) => call<unknown>("extension.eval", { ids: [id] }));
    entry = parseExtensionEntry(raw, id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = message.includes(NOT_APPROVED) ? NOT_APPROVED : "ERR_EVAL_IPC";
    return reportFailure(d, p.json, cliFailure(code, message), "");
  }
  if (entry === null) {
    const bad = cliFailure("ERR_EVAL_BAD_RESPONSE", "the gateway's answer was not a valid result");
    return reportFailure(d, p.json, bad, "");
  }
  if (!entry.ok) {
    const prose = `${entry.error.code}: ${entry.error.message}`;
    return reportFailure(d, p.json, { prose, document: JSON.stringify(entry) }, "");
  }
  if (p.json) d.log(JSON.stringify(entry));
  else for (const line of renderReport(entry)) d.log(line);
  return 0;
}

/** Returns the process exit code: 0 when the eval ran (any score), 2 on an eval or usage error. */
export async function runEval(args: readonly string[], deps?: EvalCliDeps): Promise<number> {
  const d = deps ?? defaultDeps();
  const p = parseArgs(args);
  const problem = usageProblem(p);
  if (problem === null && p.extension !== undefined) return await runInstalledEval(p, d);
  if (problem !== null || p.pkg === undefined) {
    d.err(problem ?? USAGE);
    return 2;
  }
  const plan = d.launch();
  if (!plan.ok) return reportFailure(d, p.json, cliFailure("ERR_EVAL_LAUNCH", plan.message), "");
  const cmd = [...plan.cmd, ...roleArgsFor(p.pkg, p.suite)];
  const res = await d.spawnRole(cmd, plan.cwd, EVAL_ROLE_WALL_CLOCK_MS);
  const tail = new TextDecoder().decode(res.stderr).trim();
  const outcome = interpretRoleResult(res);
  if (outcome.kind === "failure") {
    return reportFailure(d, p.json, cliFailure(outcome.code, outcome.message), tail);
  }
  const { doc, text } = outcome;
  if (!doc.ok) {
    const prose = `${doc.error.code}: ${doc.error.message}`;
    return reportFailure(d, p.json, { prose, document: text }, tail);
  }
  if (p.json) d.log(text);
  else
    for (const line of renderReport({
      id: doc.extensionId,
      version: doc.version,
      report: doc.report,
    })) {
      d.log(line);
    }
  return 0;
}
