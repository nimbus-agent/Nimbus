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

/** The real sleep: a timer that also resolves early when the signal aborts. */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
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
