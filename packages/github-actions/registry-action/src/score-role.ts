/**
 * The process half of the score modes: the one place the gateway's `__nimbus-eval` role is spawned
 * and watched (deadline, stdout cap, process-group kill, minimal environment), and the helpers that
 * turn its output into a bounded message. Split out of `score.ts` so the suite run and the baseline
 * run share it without importing each other. Runs under the runner's Node: no ES2024+ runtime API.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

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
export const MAX_MESSAGE_CHARS = 1000;

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

/** Removes a directory tree; may throw (a busy file on Windows, say). */
export type RemoveDir = (path: string) => void;

export const removeDir: RemoveDir = (path) => rmSync(path, { recursive: true, force: true });

/**
 * Removes a scratch directory and never throws: a directory left behind is litter, not a failed
 * eval, and a throw here would escape a callback (leaving a promise unresolved) or a `finally`.
 */
export function removeQuietly(rm: RemoveDir, path: string): void {
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
 * The role's argv: the same for every run but for `extra` (`--baseline` for the baseline run), so
 * the suite runner and the baseline runner cannot drift apart.
 */
export function roleArgs(packageDir: string, extra: readonly string[] = []): string[] {
  return ["__nimbus-eval", "--package", packageDir, ...extra, "--json"];
}

/**
 * `spawn` with the absolute gateway path and an argv array (no shell, no `PATH` lookup),
 * `windowsHide`, the deadline and the stdout cap. The environment is minimal — `PATH` and a fresh
 * `HOME` under `tmp()` — so nothing from this process (a token, a key) reaches the role, and the
 * role's sandbox directory, which it derives from `HOME`, is private to this run.
 *
 * On POSIX the role leads its own process group (`detached`), and the deadline or a stdout overflow
 * kills the whole group: the sandbox wrapper under the role inherits the role's stderr, so killing
 * the role alone would leave the run waiting on a pipe the extension keeps open.
 */
export function makeRoleRunner(
  extra: readonly string[],
  defaultTimeoutMs: number,
  spawnRole: SpawnLike = nodeSpawn,
  tmp: () => string = osTmpdir,
  rm: RemoveDir = removeDir,
  kill: KillProcess = killProcess,
): RunRole {
  return (gateway, packageDir, timeoutMs = defaultTimeoutMs) =>
    new Promise((resolve) => {
      const home = mkdtempSync(join(tmp(), "nimbus-eval-home-"));
      const finish = (r: RoleRun): void => {
        removeQuietly(rm, home);
        resolve(r);
      };
      const env = { PATH: process.env["PATH"] ?? "", HOME: home };
      let child: RoleChild;
      try {
        child = spawnRole(gateway, roleArgs(packageDir, extra), {
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

/** The default `runRole` for a suite run: `<gateway> __nimbus-eval --package <dir> --json`. */
export function roleRunner(
  spawnRole: SpawnLike = nodeSpawn,
  tmp: () => string = osTmpdir,
  rm: RemoveDir = removeDir,
  kill: KillProcess = killProcess,
): RunRole {
  return makeRoleRunner([], ROLE_TIMEOUT_MS, spawnRole, tmp, rm, kill);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** An eval error entry: a code and a bounded message. */
export type ScoreError = { code: string; message: string };

/** A message an entry may carry: flattened and capped. */
export const clip = (s: string): string =>
  s.replace(CONTROL_CHARS, " ").trim().slice(0, MAX_MESSAGE_CHARS);

/** The role's own error code when it looks like one; otherwise a fixed one. */
export const roleCode = (c: string): string =>
  /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : "ERR_EVAL_FAILED";

export function lastLine(s: string): string {
  return s.split(/\r?\n/).findLast((l) => l.trim() !== "") ?? "";
}

export const fail = (code: string, message: string): { error: ScoreError } => ({
  error: { code, message: clip(message) },
});

/** A deadline in words: whole minutes when it is one, else seconds. */
export function duration(ms: number): string {
  return ms % 60_000 === 0
    ? `${String(ms / 60_000)} minutes`
    : `${String(Math.ceil(ms / 1000))} seconds`;
}
