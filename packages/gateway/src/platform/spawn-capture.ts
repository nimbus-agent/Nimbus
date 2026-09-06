import { spawn } from "node:child_process";

/**
 * Spawn a CLI, capture stdout, and — on Windows — do it WITHOUT flashing a console window.
 *
 * ## Why this exists
 *
 * Every connector that shells out to a vendor CLI (`aws`, `gcloud`, `az`, `bq`, `kubectl`) used
 * `Bun.spawn` directly. On Windows that pops a visible console window for the lifetime of the
 * child, because the Gateway runs DETACHED: a parent with no console of its own gets a brand-new
 * console — and a `conhost.exe` to host it — allocated for each console-subsystem child.
 *
 * The user-visible result was console windows opening and closing continuously on an otherwise
 * idle machine. It is not cosmetic at the rate the syncs produce it: `cloudwatch` and `sagemaker`
 * spawn one CLI process PER INDEXED ITEM through `runAwsCliPaginatedWalk`'s `processEntry`, and
 * `aws` re-lists Lambda functions every 120 s, so a burst of dozens of windows arrives on every
 * sync tick.
 *
 * ## Why `node:child_process` rather than `Bun.spawn`
 *
 * `windowsHide` sets `CREATE_NO_WINDOW` on the child, which is what suppresses the window.
 *
 * The ORIGINAL reason for reaching for `node:child_process` here — that `windowsHide` "appears
 * nowhere in `@types/bun`", so passing it to `Bun.spawn` would need a cast and might be a no-op —
 * is no longer true and must not be repeated: `bun-types@1.3.14` declares it on Bun's spawn
 * options, and Bun honours it. Measured on Windows 11 / Bun 1.3.14, console-less parent, 8
 * children, counting VISIBLE `ConsoleWindowClass` windows: `Bun.spawn` without the flag 8/8,
 * with `windowsHide: true` 0/8 — identical to `node:child_process`. Note that counting
 * `conhost.exe` cannot measure this: `CREATE_NO_WINDOW` still allocates a console and still
 * spawns a conhost, it is only invisible, so both modes give the same conhost count.
 *
 * What remains true is the shape of this helper: it captures a bounded amount of stdout, never
 * rejects, and optionally times out. Spawns that need to stream, hold an `AbortSignal`, or keep a
 * long-lived child pass `windowsHide: true` to `Bun.spawn` directly instead — `audit:windows-console`
 * is what keeps them honest.
 *
 * ## What this does NOT do
 *
 * It does not scope the environment — that is invariant I1's job, and callers still pass an env
 * they built with `extensionProcessEnv()`. This helper only spawns, hides, and captures.
 */
/**
 * The indirection point tests spy on.
 *
 * A module-scope `import { spawn }` binding cannot be replaced after load, and this repo prefers
 * dependency injection over `mock.module` (which is process-global and leaks across files in the
 * combined CI run). An exported object property is spy-able with `spyOn` and costs one property
 * read per spawn.
 */
export const spawnCaptureInternals = { spawn };

export type SpawnCaptureOptions = {
  /** Full child environment. Callers scope it with `extensionProcessEnv()` (I1) before passing. */
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  /**
   * Kill the child after this many ms. A vendor CLI that hangs on a network read would otherwise
   * pin a sync forever; every existing caller was already unbounded, so this is a strict
   * improvement, but it stays OPTIONAL so no current behaviour changes silently.
   */
  readonly timeoutMs?: number;
};

export type SpawnCaptureResult = {
  /** Exit code was 0. */
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** `null` when the child was killed by a signal or by `timeoutMs`. */
  readonly code: number | null;
};

/**
 * Never rejects: a missing executable, a non-zero exit and a timeout all resolve to
 * `ok: false`. Every call site this replaced already degraded on `!ok` rather than catching, so
 * throwing here would turn a handled no-op into an unhandled sync failure.
 */
export function spawnCapture(
  argv: readonly string[],
  options: SpawnCaptureOptions = {},
): Promise<SpawnCaptureResult> {
  const [cmd, ...args] = argv;
  if (cmd === undefined) {
    return Promise.resolve({ ok: false, stdout: "", stderr: "", code: null });
  }

  return new Promise<SpawnCaptureResult>((resolve) => {
    // Declared BEFORE `done`, which reads it: the synchronous-throw path calls `done` from the
    // `catch` below, i.e. before a `let` declared further down has initialized. That is a
    // ReferenceError in the temporal dead zone, not an undefined read.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (r: SpawnCaptureResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnCaptureInternals.spawn(cmd, args, {
        // The whole point of the module. Ignored on non-Windows platforms.
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch {
      // `spawn` can throw synchronously on a malformed command.
      return done({ ok: false, stdout: "", stderr: "", code: null });
    }

    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill();
        done({ ok: false, stdout: out, stderr: err, code: null });
      }, options.timeoutMs);
      // NOT unref'd. An unref'd timer does not hold the event loop open, so when the child is
      // hung and nothing else has work queued the timeout can fail to fire at all — defeating it
      // in precisely the case it exists for. It cannot leak: `done()` always clears it, and
      // `done()` runs on every exit path.
    }

    // ENOENT (CLI not installed) arrives as an `error` event, not a non-zero exit.
    child.on("error", () => {
      done({ ok: false, stdout: out, stderr: err, code: null });
    });
    child.on("close", (code) => {
      done({ ok: code === 0, stdout: out, stderr: err, code });
    });
  });
}
