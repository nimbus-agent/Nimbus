/**
 * Await a promise that only an `unref()`'d handle can settle, without hanging `bun test` when the
 * file runs on its own on Windows.
 *
 * Some production timers are unref'd on purpose so a pending wait never holds the gateway's event
 * loop open — `federation/consent-broker.ts`'s TTL safety-net and `federation/preflight-runner.ts`'s
 * kill timer are two. In the gateway that is harmless: the IPC server keeps the loop alive, so those
 * timers fire on time. A test that awaits such a promise has nothing else ref'd, and there Bun
 * 1.3.14 parts ways by platform (measured with zero-import probe tests):
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
 * Holding ONE ref'd handle for exactly the duration of the await keeps the loop alive, so the
 * production timer — still unref'd, still the only thing that settles the promise — fires on
 * schedule. The hold is released the moment the promise settles, on either path, so it cannot leak
 * into the next test; while it is held, a regression that never settles the promise fails at the
 * per-test timeout instead of hanging.
 *
 * Such a test still passes in the whole-repo run, on Windows too, only because an EARLIER file's
 * leaked ref'd handle (a pending ref'd timer, an unstopped server) happens to keep the loop alive —
 * a change in file order or in someone else's cleanup could hang that run as well.
 */

/** Any ref'd period works — the hold only has to exist; it never needs to fire to help. */
const HOLD_PERIOD_MS = 1_000;

export async function awaitHoldingEventLoop<T>(promise: Promise<T>): Promise<T> {
  const hold = setInterval(() => {}, HOLD_PERIOD_MS);
  try {
    return await promise;
  } finally {
    clearInterval(hold);
  }
}
