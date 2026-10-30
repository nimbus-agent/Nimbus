/**
 * `mode: score` — runs each new extension version's eval suites (eval spec § 4.6, ruling R8).
 *
 * Extension code is untrusted, so it runs ONLY here: a job with no secrets, no environment and a
 * read-only token, never the job that holds the registry root key. For every unsigned candidate
 * that `sign` would consider (validated exactly as `sign` validates it, `candidates.ts`) whose
 * package holds an eval suite (`PublishVerdict.hasEvals`), the package is unpacked again with the
 * same safe extractor into a directory this mode owns, and the gateway's `__nimbus-eval` role —
 * which confines the extension in the platform sandbox with no network — is run over it.
 *
 * The role's ONE stdout document is validated with registry-format's `parseEvalRoleDocument` and
 * must name the candidate's own `<id>@<version>`. Anything else (a timeout, stdout past 8 MiB, a
 * non-zero exit, garbage) is an error entry, never a partial score. `scores.json` is always
 * written, `{}` when nothing was scored, through a temp sibling and a rename. `sign` reads it as
 * untrusted input bound to each candidate's `packageSha256`.
 *
 * The whole run has one time budget (`SCORE_RUN_BUDGET_MS`): each role run gets the role's own
 * deadline or what is left of the budget, whichever is shorter, and once under a minute is left
 * every further evals candidate is an `ERR_EVAL_BUDGET` entry without running. Hanging suites,
 * which a publisher can merge on purpose, therefore cannot turn the job red; a red score job would
 * skip the whole sign run, trust requests (takedowns, key revocations) included. The relief is per
 * run only: no state is kept across runs, and `sign` never signs a version whose eval failed, so
 * every sign run scores that version again, spending its budget, until it scores or is removed.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import {
  type EvalQuality,
  inspectPackage,
  type PublishVerdict,
  parseEvalQuality,
  parseEvalRoleDocument,
  type RegistryExtensionEntry,
  validatePublish,
} from "../../../registry-format/src/index.ts";
import {
  addVersion,
  admitStatements,
  assertSignedIntact,
  extensionDirs,
  type Skipped,
  validateUnsigned,
} from "./candidates.ts";
import * as gitTree from "./git-tree.ts";
import { CONFIG_FILE, PAGES_BRANCH, readConfigAt, readVerifiedIndex } from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";

/** The role's deadline: a whole package's suites, every case, under the sandbox. */
export const ROLE_TIMEOUT_MS = 12 * 60_000;
/** The score run's overall budget, inside the job's 20-minute timeout. */
export const SCORE_RUN_BUDGET_MS = 14 * 60_000;
/** Below this much budget left, no further role run is started. */
export const SCORE_MIN_RUN_MS = 60_000;
/** The most stdout the role may print; past it the role is killed and the eval is an error. */
export const ROLE_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
/** How much of the role's stderr is kept (the end of it), for the step log. */
export const ROLE_STDERR_TAIL_BYTES = 64 * 1024;
/** The longest error message an entry carries. */
const MAX_MESSAGE_CHARS = 1000;

/** One run of the role. */
export interface RoleRun {
  /** The exit code; `null` when it did not exit by itself (killed, or never started). */
  code: number | null;
  stdout: string;
  /** The last `ROLE_STDERR_TAIL_BYTES` of stderr (or why the role could not be started). */
  stderrTail: string;
  timedOut: boolean;
  overflow: boolean;
}

/**
 * Runs `<gateway> __nimbus-eval --package <packageDir> --json`, killed after `timeoutMs`
 * (`ROLE_TIMEOUT_MS` when absent).
 */
export type RunRole = (gateway: string, packageDir: string, timeoutMs?: number) => Promise<RoleRun>;

export interface ScoreDeps {
  validate: typeof validatePublish;
  git: typeof gitTree;
  io: ActionIo;
  /** Where the score mode's own work directory goes. */
  tmpdir: () => string;
  runRole: RunRole;
  /** The clock the run budget is measured with, in milliseconds. */
  now: () => number;
}

export type ScoreError = { code: string; message: string };

/** One `scores.json` entry: a quality, or why there is none. */
export type ScoreEntry =
  | { packageSha256: string; quality: EvalQuality }
  | { packageSha256: string; error: ScoreError };

/** `scores.json`: entries keyed `<id>@<version>`. */
export type ScoresFile = Record<string, ScoreEntry>;

export interface ScoreOptions {
  /** The registry repository's checkout. */
  workspace: string;
  /** The `nimbus-gateway` input: an absolute path to a gateway executable. */
  gateway: string;
  /** Where `scores.json` is written. */
  out: string;
  /** The default branch; asked of `origin` when absent. */
  defaultBranch?: string;
}

/** Removes a directory tree; may throw (a busy file on Windows, say). */
export type RemoveDir = (path: string) => void;

const removeDir: RemoveDir = (path) => rmSync(path, { recursive: true, force: true });

/**
 * Removes a scratch directory and never throws: a directory left behind is litter, not a failed
 * eval, and a throw here would escape a callback (leaving a promise unresolved) or a `finally`.
 */
function removeQuietly(rm: RemoveDir, path: string): void {
  try {
    rm(path);
  } catch {
    // Litter in the runner's temp dir; the job's workspace is discarded with the runner.
  }
}

/** After the role exits, how long its stdout may still drain before the run resolves anyway. */
export const ROLE_DRAIN_GRACE_MS = 2_000;

/**
 * After a kill (the deadline, an overflow), the longest the run waits for the role's exit and
 * stdio before resolving anyway: a role stuck in the kernel, or a kill that failed, cannot hold
 * the run open.
 */
export const ROLE_KILL_BOUND_MS = 5_000;

/** What the role runner needs of a spawned process (a `ChildProcess` satisfies it). */
export interface RoleChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** The options the role is spawned with. */
export interface RoleSpawnOptions {
  env: Record<string, string>;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: boolean;
  /** POSIX: the role leads its own process group, so the deadline can kill everything under it. */
  detached: boolean;
  shell: false;
}

/** Spawns the role (`node:child_process` `spawn` by default). */
export type SpawnLike = (file: string, args: string[], opts: RoleSpawnOptions) => RoleChild;

/** Sends `signal` to `pid` (a negative `pid` is a process group); throws as `process.kill` does. */
export type KillProcess = (pid: number, signal: NodeJS.Signals) => void;

const nodeSpawn: SpawnLike = (file, args, opts) => spawn(file, args, opts);
const killProcess: KillProcess = (pid, signal) => {
  process.kill(pid, signal);
};

const IS_WINDOWS = process.platform === "win32";

/** An error's `code` (`ENOENT`, `ESRCH`), else its message. */
function errCode(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = (e as NodeJS.ErrnoException).code;
  return typeof c === "string" ? c : e.message;
}

/**
 * Kills the role and everything in its process group. On POSIX the group is the role, the
 * sandbox wrapper under it and (through bwrap's `--die-with-parent` and pid namespace) the
 * extension: killing the role alone would leave the wrapper holding the role's stderr open, and
 * the run could never end. Without a group (Windows, or no pid) the role itself is killed.
 */
function killGroup(child: RoleChild, kill: KillProcess): void {
  const pid = child.pid;
  if (!IS_WINDOWS && pid !== undefined) {
    try {
      kill(-pid, "SIGKILL");
      return;
    } catch (e) {
      if (errCode(e) === "ESRCH") return;
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * After the role exits, whatever is left in its group is litter from untrusted code: killed. The
 * kernel never hands out a pid that is still a live group's id, so this cannot reach an unrelated
 * process while a group member lives; with none left it is `ESRCH`, ignored.
 */
function sweepGroup(child: RoleChild, kill: KillProcess): void {
  if (IS_WINDOWS || child.pid === undefined) return;
  try {
    kill(-child.pid, "SIGKILL");
  } catch {
    // Nothing left in the group.
  }
}

const asBuffer = (chunk: Buffer | string): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

/** Collects a stream up to `max` bytes; the first chunk past it calls `onOverflow`, once. */
function collectCapped(stream: Readable | null, max: number, onOverflow: () => void): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  stream?.on("data", (chunk: Buffer | string) => {
    if (over) return;
    const b = asBuffer(chunk);
    if (size + b.length > max) {
      over = true;
      onOverflow();
      return;
    }
    chunks.push(b);
    size += b.length;
  });
  stream?.on("error", () => {});
  return () => Buffer.concat(chunks).toString("utf8");
}

/** Keeps the last `max` bytes of a stream, holding at most `max` bytes plus one chunk. */
function collectTail(stream: Readable | null, max: number): () => Buffer {
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    const b = asBuffer(chunk);
    chunks.push(b);
    size += b.length;
    while (chunks.length > 1 && size - (chunks[0]?.length ?? 0) >= max) {
      size -= chunks.shift()?.length ?? 0;
    }
  });
  stream?.on("error", () => {});
  return () => Buffer.concat(chunks);
}

/** The last `max` bytes of `b`, as text. */
const tailText = (b: Buffer, max: number): string =>
  b.subarray(Math.max(0, b.length - max)).toString("utf8");

/** A run whose role never started. */
const notStarted = (why: string): RoleRun => ({
  code: null,
  stdout: "",
  stderrTail: tailText(Buffer.from(why), ROLE_STDERR_TAIL_BYTES),
  timedOut: false,
  overflow: false,
});

/**
 * Watches one spawned role to its end, in phases: the deadline (kill the group), stdout up to the
 * cap (past it, kill the group), the exit (stop the deadline, sweep the group, give stdout
 * `ROLE_DRAIN_GRACE_MS` to drain; no kill is sent after it, and every kill resolves the run
 * within `ROLE_KILL_BOUND_MS` even when no exit follows), then resolve with what was collected.
 * The run resolves on `close` or at the end of the grace, whichever is first, and exactly once:
 * a process still holding the role's stdio can delay it by the grace at most, never block it.
 */
function watchRole(
  child: RoleChild,
  timeoutMs: number,
  kill: KillProcess,
  done: (r: RoleRun) => void,
): void {
  const run = { code: null as number | null, timedOut: false, overflow: false, why: "" };
  let settled = false;
  let exited = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  // The one place a kill is sent: never after the exit (the pid is reaped; the sweep has run), and
  // every kill bounds the run, so it resolves even when no exit or close follows.
  const killFor = (why: "timedOut" | "overflow"): void => {
    run[why] = true;
    if (exited) return;
    killGroup(child, kill);
    grace ??= setTimeout(settle, ROLE_KILL_BOUND_MS);
  };
  const stdout = collectCapped(child.stdout, ROLE_STDOUT_MAX_BYTES, () => killFor("overflow"));
  const stderr = collectTail(child.stderr, ROLE_STDERR_TAIL_BYTES);
  const deadline = setTimeout(() => killFor("timedOut"), timeoutMs);

  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(grace);
    child.stdout?.destroy();
    child.stderr?.destroy();
    done({
      code: run.code,
      stdout: stdout(),
      stderrTail: tailText(Buffer.concat([stderr(), Buffer.from(run.why)]), ROLE_STDERR_TAIL_BYTES),
      timedOut: run.timedOut,
      overflow: run.overflow,
    });
  };

  child.on("exit", (code) => {
    clearTimeout(deadline);
    run.code = code;
    sweepGroup(child, kill);
    exited = true;
    grace ??= setTimeout(settle, ROLE_DRAIN_GRACE_MS);
  });
  child.on("close", settle);
  child.on("error", (e) => {
    // A started role's later error (a failed kill, say) changes nothing: its exit still comes.
    if (child.pid !== undefined) return;
    run.why = `could not run the gateway: ${errCode(e)}\n`;
    settle();
  });
}

/**
 * The default `runRole`: `spawn` with the absolute gateway path and an argv array (no shell, no
 * `PATH` lookup), `windowsHide`, the deadline and the stdout cap. The environment is minimal —
 * `PATH` and a fresh `HOME` under `tmp()` — so nothing from this process (a token, a key) reaches
 * the role, and the role's sandbox directory, which it derives from `HOME`, is private to this run.
 *
 * On POSIX the role leads its own process group (`detached`), and the deadline or a stdout overflow
 * kills the whole group: the sandbox wrapper under the role inherits the role's stderr, so killing
 * the role alone would leave the run waiting on a pipe the extension keeps open.
 */
export function roleRunner(
  spawnRole: SpawnLike = nodeSpawn,
  tmp: () => string = osTmpdir,
  rm: RemoveDir = removeDir,
  kill: KillProcess = killProcess,
): RunRole {
  return (gateway, packageDir, timeoutMs = ROLE_TIMEOUT_MS) =>
    new Promise((resolve) => {
      const home = mkdtempSync(join(tmp(), "nimbus-eval-home-"));
      const finish = (r: RoleRun): void => {
        removeQuietly(rm, home);
        resolve(r);
      };
      const env = { PATH: process.env["PATH"] ?? "", HOME: home };
      let child: RoleChild;
      try {
        child = spawnRole(gateway, ["__nimbus-eval", "--package", packageDir, "--json"], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: !IS_WINDOWS,
          shell: false,
        });
      } catch (e) {
        finish(
          notStarted(`could not start the gateway: ${e instanceof Error ? e.message : String(e)}`),
        );
        return;
      }
      watchRole(child, timeoutMs, kill, finish);
    });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** A message an entry may carry: flattened and capped. */
const clip = (s: string): string =>
  s.replace(CONTROL_CHARS, " ").trim().slice(0, MAX_MESSAGE_CHARS);

/** The role's own error code when it looks like one; otherwise a fixed one. */
const roleCode = (c: string): string => (/^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : "ERR_EVAL_FAILED");

function lastLine(s: string): string {
  return (
    s
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .at(-1) ?? ""
  );
}

const fail = (code: string, message: string): { error: ScoreError } => ({
  error: { code, message: clip(message) },
});

/** A deadline in words: whole minutes when it is one, else seconds. */
function duration(ms: number): string {
  return ms % 60_000 === 0
    ? `${String(ms / 60_000)} minutes`
    : `${String(Math.ceil(ms / 1000))} seconds`;
}

/** The role's run, judged: a quality for exactly this `<id>@<version>`, or an error. */
export function judgeRoleRun(
  r: RoleRun,
  want: { id: string; version: string },
  timeoutMs: number = ROLE_TIMEOUT_MS,
): { quality: EvalQuality } | { error: ScoreError } {
  if (r.timedOut) {
    // A deadline under the role's own cap was set by the score run's remaining budget: say so,
    // so a maintainer does not blame a suite that earlier, hanging versions starved of time.
    const why =
      timeoutMs < ROLE_TIMEOUT_MS
        ? ` (the score job's remaining time budget; the cap is ${duration(ROLE_TIMEOUT_MS)})`
        : "";
    return fail("ERR_EVAL_TIMEOUT", `the eval did not finish within ${duration(timeoutMs)}${why}`);
  }
  if (r.overflow) {
    return fail(
      "ERR_EVAL_OUTPUT_TOO_LARGE",
      `the eval role printed more than ${String(ROLE_STDOUT_MAX_BYTES)} bytes`,
    );
  }
  if (r.code !== 0) {
    const last = lastLine(r.stderrTail);
    return fail(
      "ERR_EVAL_ROLE_FAILED",
      `the eval role exited ${r.code === null ? "without an exit code" : String(r.code)}${last === "" ? "" : `: ${last}`}`,
    );
  }
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  const doc = lines.length === 1 ? parseEvalRoleDocument(lines[0] ?? "") : null;
  if (doc === null) {
    return fail(
      "ERR_EVAL_BAD_OUTPUT",
      "the eval role's output is not exactly one valid eval document",
    );
  }
  if (!doc.ok) return fail(roleCode(doc.error.code), doc.error.message);
  if (doc.extensionId !== want.id || doc.version !== want.version) {
    return fail(
      "ERR_EVAL_IDENTITY_MISMATCH",
      `the eval role scored ${doc.extensionId}@${doc.version}, not ${want.id}@${want.version}`,
    );
  }
  const { results: _results, ...quality } = doc.report;
  try {
    return { quality: parseEvalQuality(quality) };
  } catch (e) {
    return fail("ERR_EVAL_BAD_OUTPUT", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Score one validated candidate: unpack its package into a fresh directory under `work` with
 * `inspectPackage` (the role is handed exactly `<dir>/x`, where that puts the files), run the role,
 * judge its output. Never throws: every failure is an error entry. The directory is removed after
 * (a failure to remove it is ignored, never thrown).
 */
export async function scoreCandidate(
  c: {
    verdict: Pick<PublishVerdict, "id" | "version" | "packageSha256">;
    packageBytes: Uint8Array;
  },
  at: { gateway: string; work: string; timeoutMs?: number },
  runRole: RunRole,
  log: (line: string) => void = () => {},
  rm: RemoveDir = removeDir,
): Promise<ScoreEntry> {
  const { id, version, packageSha256 } = c.verdict;
  const dir = mkdtempSync(join(at.work, "score-"));
  try {
    const tgz = join(dir, "package.tgz");
    writeFileSync(tgz, c.packageBytes, { flag: "wx" });
    await inspectPackage(tgz, dir);
    const r = await runRole(at.gateway, join(dir, "x"), at.timeoutMs);
    logStderr(log, `${id}@${version}`, r.stderrTail);
    return { packageSha256, ...judgeRoleRun(r, { id, version }, at.timeoutMs) };
  } catch (e) {
    return {
      packageSha256,
      ...fail(
        "ERR_EVAL_ROLE_FAILED",
        `the eval could not be run: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  } finally {
    removeQuietly(rm, dir);
  }
}

/**
 * The role's stderr in the step log, inside a `::stop-commands::` fence: it is the extension's
 * output, and unfenced a line of it could be a workflow command.
 */
function logStderr(log: (line: string) => void, ref: string, stderrTail: string): void {
  if (stderrTail.trim() === "") return;
  const fence = randomUUID().replaceAll("-", "");
  log(`stderr of the eval role for ${ref} (last ${String(ROLE_STDERR_TAIL_BYTES)} bytes):`);
  log(`::stop-commands::${fence}`);
  log(stderrTail);
  log(`::${fence}::`);
}

/** The `nimbus-gateway` input, refused unless it is an absolute path to an existing file. */
export function assertGateway(gateway: string): void {
  let ok = false;
  try {
    ok = isAbsolute(gateway) && existsSync(gateway) && statSync(gateway).isFile();
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `input "nimbus-gateway" must be an absolute path to an existing file; got ${JSON.stringify(gateway)}`,
    );
  }
}

/**
 * Writes `text` to `path` through a temp sibling (exclusive create) and a rename, so a reader never
 * sees a partial file; a failure removes the temp file.
 */
export function writeFileAtomic(
  path: string,
  text: string,
  fs: {
    writeFileSync: (p: string, data: string, opts: { flag: string }) => void;
    renameSync: (from: string, to: string) => void;
  } = { writeFileSync, renameSync },
): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { flag: "wx" });
    fs.renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

const SHARED: ScoreDeps = {
  validate: validatePublish,
  git: gitTree,
  io: GHA_IO,
  tmpdir: osTmpdir,
  runRole: roleRunner(),
  now: Date.now,
};

interface ScoreRun {
  scores: ScoresFile;
  skipped: Skipped[];
}

/** When an unscored version is tried again: no state is kept across runs. */
const RETRY_NOTE =
  "it is scored again on the next sign run (a push to the default branch or a workflow_dispatch)";

/**
 * Why a failed version keeps coming back: `sign` never signs it, so it stays unsigned on the default
 * branch, and every sign run scores it again and spends budget on it until it scores or is removed.
 */
const FAILED_REMEDY =
  "A version whose eval failed is not signed, so it is scored again on every sign run (a push to the default branch or a workflow_dispatch) until it scores or its directory is removed from the default branch; meanwhile each attempt spends time budget that later versions need.";

/** The entry of an evals candidate the run had no budget left for. */
const budgetSpent = (packageSha256: string): ScoreEntry => ({
  packageSha256,
  ...fail(
    "ERR_EVAL_BUDGET",
    `not scored this run: earlier evals spent the score job's time budget; ${RETRY_NOTE}`,
  ),
});

/**
 * Score one candidate within the run's budget: the role gets its own deadline or what is left,
 * whichever is shorter; with under `SCORE_MIN_RUN_MS` left it does not run at all.
 */
function scoreWithinBudget(
  c: { verdict: PublishVerdict; packageBytes: Uint8Array },
  at: { gateway: string; work: string; deadline: number },
  deps: ScoreDeps,
): Promise<ScoreEntry> {
  const left = at.deadline - deps.now();
  if (left < SCORE_MIN_RUN_MS) return Promise.resolve(budgetSpent(c.verdict.packageSha256));
  return scoreCandidate(
    c,
    { gateway: at.gateway, work: at.work, timeoutMs: Math.min(ROLE_TIMEOUT_MS, left) },
    deps.runRole,
    deps.io.log,
  );
}

/** Validate every unsigned candidate as `sign` does and score each one with an eval suite. */
async function scoreAll(
  opts: ScoreOptions & { defaultBranch: string },
  deps: ScoreDeps,
  work: string,
  deadline: number,
): Promise<ScoreRun> {
  const { git } = deps;
  const cwd = opts.workspace;
  const mainRef = `origin/${opts.defaultBranch}`;
  git.fetchRefs([opts.defaultBranch, PAGES_BRANCH], { cwd });
  const index = await readVerifiedIndex(git, cwd);
  const config = readConfigAt(git, mainRef, cwd);
  if (config === undefined) {
    throw new Error(`refusing to score: ${opts.defaultBranch} has no ${CONFIG_FILE}`);
  }
  const { dirs, paths } = extensionDirs(git, mainRef, cwd);
  const signedDirs = assertSignedIntact(git, index, mainRef, paths, cwd, "score");
  const skipped: Skipped[] = [];
  const admission = admitStatements(git, index, mainRef, cwd, skipped);
  const extensions: Record<string, RegistryExtensionEntry> = { ...index.extensions };
  const publishedAt = git.commitTime(mainRef, { cwd });
  // Keys are `<id>@<version>` from validated manifests; a null prototype keeps them inert anyway.
  const scores = Object.create(null) as ScoresFile;
  for await (const o of validateUnsigned({
    git,
    validate: deps.validate,
    ref: mainRef,
    cwd,
    dirs,
    signedDirs,
    config: config.config,
    work,
    bindings: () => ({ ...admission.index, extensions }),
  })) {
    if (o.kind === "skipped") {
      skipped.push({ dir: o.dir, reason: o.reason });
      continue;
    }
    const v = o.verdict;
    if (v.hasEvals) {
      // NOSONAR S9382: sequential by design - one sandboxed eval at a time, inside the validation loop
      const entry = await scoreWithinBudget(
        { verdict: v, packageBytes: o.candidate.packageBytes },
        { gateway: opts.gateway, work, deadline },
        deps,
      );
      scores[`${v.id}@${v.version}`] = entry;
      // `sign` will not sign a version with evals and no score: later candidates must not bind to it.
      if ("error" in entry) continue;
    }
    addVersion(extensions, v, publishedAt);
  }
  return { scores, skipped };
}

function report(io: ActionIo, r: ScoreRun): void {
  const lines = ["## Registry score", ""];
  const entries = Object.entries(r.scores);
  if (entries.length === 0) lines.push("No unsigned version with eval suites to score.");
  const failed: string[] = [];
  for (const [ref, e] of entries) {
    if ("quality" in e) {
      const q = e.quality;
      lines.push(
        `- ${code(ref)}: ${String(q.score)}/100 (${String(q.passed)} of ${String(q.cases)} cases passed)`,
      );
    } else {
      io.annotate(
        "warning",
        `eval of ${ref} failed (${e.error.code}): ${e.error.message}; sign will not sign it. ${FAILED_REMEDY}`,
      );
      lines.push(`- ${code(ref)}: not scored, ${code(e.error.code)} ${code(e.error.message)}`);
      failed.push(ref);
    }
  }
  if (failed.length > 0) {
    lines.push("", "**Not signed** (no score):", "");
    for (const ref of failed) lines.push(`- ${code(ref)}`);
    lines.push("", FAILED_REMEDY);
  }
  if (r.skipped.length > 0) {
    lines.push("", "**Not scored** (fails validation; `sign` skips it too):", "");
    for (const s of r.skipped) lines.push(`- ${code(s.dir)}: ${code(s.reason)}`);
  }
  io.summary(lines.join("\n"));
  io.log(`scored ${String(entries.length)} version(s); ${String(r.skipped.length)} not valid`);
}

/** Run the `score` mode: write `opts.out`. Throws (failing the run) on a refusal. */
export async function runScore(opts: ScoreOptions, deps: ScoreDeps = SHARED): Promise<ScoresFile> {
  const deadline = deps.now() + SCORE_RUN_BUDGET_MS;
  assertGateway(opts.gateway);
  const defaultBranch = opts.defaultBranch ?? deps.git.remoteDefaultBranch({ cwd: opts.workspace });
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-score-"));
  let r: ScoreRun;
  try {
    r = await scoreAll({ ...opts, defaultBranch }, deps, work, deadline);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileAtomic(opts.out, `${JSON.stringify(r.scores, null, 2)}\n`);
  report(deps.io, r);
  return r.scores;
}
