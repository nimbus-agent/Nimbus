import { rmSync } from "node:fs";

/** The errors Windows raises while a just-exited process still holds a handle under the dir. */
const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export interface RmDirWithRetryOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  /** Injected for tests; defaults to a recursive, forced `rmSync`. */
  readonly rm?: (path: string) => void;
  /** Injected for tests; defaults to `Bun.sleepSync`. */
  readonly sleep?: (ms: number) => void;
}

/**
 * Removes `path` recursively, retrying while Windows still holds a handle under it. `nimbus demo`
 * re-roots by deleting the demo directory right after stopping the previous demo gateway, and that
 * process releases its SQLite and log handles a moment after it exits.
 *
 * The loop is ours because Bun's recursive `rmSync` IGNORES `maxRetries` / `retryDelay`: with them
 * set it still fails EBUSY in about 1 ms (measured on Windows, Bun 1.3.14), which made a second
 * `nimbus demo` exit 1 intermittently on the Windows CI leg. Any other error, or the last failed
 * attempt, is rethrown unchanged. The gateway's test tree carries the same loop
 * (`packages/gateway/test/helpers/rm-dir-with-retry.ts`); the CLI cannot import gateway code.
 */
export function rmDirWithRetry(path: string, opts: RmDirWithRetryOptions = {}): void {
  const attempts = opts.attempts ?? 20;
  const delayMs = opts.delayMs ?? 100;
  const rm = opts.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  for (let attempt = 1; ; attempt++) {
    try {
      rm(path);
      return;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code !== "string" || !RETRYABLE.has(code) || attempt >= attempts) throw e;
      sleep(delayMs);
    }
  }
}
