import { computePercentiles } from "./percentiles.ts";

export interface SampleRssOptions {
  pid: number;
  durationMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  pidusage?: (pid: number) => Promise<{ memory: number }>;
  /**
   * Monotonic clock, injected only by tests. Defaults to `performance.now`.
   *
   * The sample COUNT is a function of how many interval boundaries fit inside
   * `durationMs`, so asserting on it against a real clock asserts on the
   * scheduler's punctuality. A loaded CI runner overshoots each `setTimeout`,
   * the overshoot accumulates against the deadline, and a run that should
   * produce 5 samples produces 3 — which is exactly how this flaked.
   */
  now?: () => number;
  /**
   * Sleep, injected only by tests. Defaults to a real `setTimeout` that also
   * resolves early on abort.
   *
   * `now` and `sleep` are injected TOGETHER or not at all: a virtual clock left
   * racing a real timer is its own hang (a lesson this repo has already paid
   * for), so the default below keeps the production path exactly as it was.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The real sleep: a timer that also resolves early when the signal aborts.
 *
 * Both exits go through one `finish`, which detaches the abort listener. The
 * naive shape leaks: `{ once: true }` only detaches after the event FIRES, so
 * every sleep that ends normally leaves its listener attached for the lifetime
 * of the signal. A default 1000 ms interval over a 60 s bench accumulates 60 of
 * them on one signal — past Node's 11-listener warning threshold, and holding a
 * closure each.
 */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    // An already-aborted signal never fires `abort` again, so without this the
    // caller would wait out the full timeout after it had asked to stop.
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(t);
      finish();
    };
    const t = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SampleRssResult {
  samples: number[];
  p95: number;
  intervalsMissed: number;
}

let cachedPidusage: ((pid: number) => Promise<{ memory: number }>) | undefined;

async function realPidusage(pid: number): Promise<{ memory: number }> {
  if (cachedPidusage === undefined) {
    const mod = await import("pidusage");
    cachedPidusage = mod.default;
  }
  return cachedPidusage(pid);
}

export async function sampleRss(opts: SampleRssOptions): Promise<SampleRssResult> {
  // The paired-hook rule is enforced here rather than only described above,
  // because half-injection hangs rather than failing. A frozen custom `now`
  // with the default `realSleep` advances the real clock while the loop reads a
  // clock that never moves, so the deadline is never reached and `sampleRss`
  // never returns. A comment cannot stop that; a throw can.
  if ((opts.now === undefined) !== (opts.sleep === undefined)) {
    throw new Error(
      "sampleRss: `now` and `sleep` must be provided together — injecting one leaves a virtual clock racing a real timer, which hangs rather than fails",
    );
  }
  const intervalMs = opts.intervalMs ?? 1000;
  const sampler = opts.pidusage ?? realPidusage;
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? realSleep;
  const samples: number[] = [];
  let intervalsMissed = 0;
  const start = now();
  const deadline = start + opts.durationMs;
  let tickIdx = 0;

  while (now() < deadline) {
    if (opts.signal?.aborted === true) break;
    try {
      const { memory } = await sampler(opts.pid);
      samples.push(memory);
    } catch {
      intervalsMissed += 1;
    }
    tickIdx += 1;
    const nextTickAt = start + tickIdx * intervalMs;
    const wait = Math.max(0, Math.min(nextTickAt - now(), deadline - now()));
    if (wait <= 0) continue;
    await sleep(wait, opts.signal);
  }

  if (samples.length === 0) {
    return { samples, p95: 0, intervalsMissed };
  }
  const p = computePercentiles(samples);
  return { samples, p95: p.p95 ?? 0, intervalsMissed };
}
