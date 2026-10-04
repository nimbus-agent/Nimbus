/**
 * Await a promise that only an `unref()`'d handle can settle, without hanging `bun test` when the
 * file runs on its own on Windows.
 *
 * Some production timers are unref'd. `federation/consent-broker.ts`'s TTL safety-net is, on
 * purpose, so a pending consent never holds the gateway's event loop open;
 * `federation/preflight-runner.ts`'s kill timer is too, though there the child process it guards
 * is itself a ref'd handle until it exits. In production something ref'd is always alive while
 * such a timer is pending — the IPC server, that child — so the timer fires on time. A test that
 * awaits such a promise, with fakes standing in for those handles, has nothing ref'd at all, and
 * there Bun 1.3.14 parts ways by platform (measured with zero-import probe tests):
 *
 *  - Linux: the promise wait keeps servicing the timer heap, unref'd timers included, so the timer
 *    fires and the test passes in milliseconds.
 *  - Windows: the wait spins one core at 100% and never services the timer heap. The unref'd timer
 *    never fires, and neither does `bun test`'s own per-test timeout, so the file HANGS rather than
 *    fails. It is the runtime's promise wait, not the test runner: a top-level `await` under
 *    `bun run` spins the same way, and an `AbortSignal.timeout()` abort is just as unreachable.
 *
 * Windows drives every JS timer through ONE libuv timer that is ref'd only while some ref'd JS timer
 * exists, and its promise wait does not drain due timers itself the way the POSIX loop does after
 * every tick, so with nothing ref'd each pass of libuv's loop returns before its timer phase
 * (https://github.com/oven-sh/bun/issues/34158 analyses the same alive-guard). Bun 1.4.2 no longer
 * hangs here (checked on Windows) — most likely https://github.com/oven-sh/bun/pull/34478, first
 * released in 1.4.0 — but CI pins Bun 1.3, so the hold is needed until the repo moves to 1.4.
 *
 * Holding ONE ref'd handle while the await is pending keeps the loop alive, so the production
 * timer — still unref'd, still the only thing that settles the promise — fires on schedule. The
 * hold is released the moment the promise settles, on either path, and at the latest when the test
 * that took it finishes. That second release is for a promise that never settles, which never
 * reaches the `finally`: the timed-out path. Without it the hold would outlive that test and keep
 * the loop alive for every later test in the process, which is exactly what lets a bare await of an
 * unref'd timer pass on Windows, so a leaked hold would hide the very hang it exists to work around.
 * While the hold is in place, a regression that never settles the promise fails at the per-test
 * timeout instead of hanging.
 *
 * Call it from inside a test or a hook: `onTestFinished` throws at module scope and in a `describe`
 * body, and the hold is released before that error reaches the caller.
 *
 * Such a test still passes in the whole-repo run, on Windows too, only because an EARLIER file's
 * leaked ref'd handle (a pending ref'd timer, an unstopped server) happens to keep the loop alive —
 * a change in file order or in someone else's cleanup could hang that run as well. A timer left
 * pending does not stop `bun test` from exiting, ref'd or not (measured on Windows and Linux, Bun
 * 1.3.14), so such a leak is invisible at teardown: its only effect is the loop it keeps alive for
 * the tests that run after it.
 */
import { onTestFinished } from "bun:test";

/** Any ref'd period works — the hold only has to exist; it never needs to fire to help. */
const HOLD_PERIOD_MS = 1_000;

export async function awaitHoldingEventLoop<T>(promise: Promise<T>): Promise<T> {
  const hold = setInterval(() => {}, HOLD_PERIOD_MS);
  const release = (): void => clearInterval(hold);
  try {
    onTestFinished(release);
    return await promise;
  } finally {
    release();
  }
}
