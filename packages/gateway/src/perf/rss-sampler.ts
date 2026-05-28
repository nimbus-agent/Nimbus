import { computePercentiles } from "./percentiles.ts";

export interface SampleRssOptions {
  pid: number;
  durationMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  pidusage?: (pid: number) => Promise<{ memory: number }>;
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
    cachedPidusage = mod.default as (pid: number) => Promise<{ memory: number }>;
  }
  return cachedPidusage(pid);
}

export async function sampleRss(opts: SampleRssOptions): Promise<SampleRssResult> {
  const intervalMs = opts.intervalMs ?? 1000;
  const sampler = opts.pidusage ?? realPidusage;
  const samples: number[] = [];
  let intervalsMissed = 0;
  const start = performance.now();
  const deadline = start + opts.durationMs;
  let tickIdx = 0;

  while (performance.now() < deadline) {
    if (opts.signal?.aborted === true) break;
    try {
      const { memory } = await sampler(opts.pid);
      samples.push(memory);
    } catch {
      intervalsMissed += 1;
    }
    tickIdx += 1;
    const nextTickAt = start + tickIdx * intervalMs;
    const wait = Math.max(
      0,
      Math.min(nextTickAt - performance.now(), deadline - performance.now()),
    );
    if (wait <= 0) continue;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  if (samples.length === 0) {
    return { samples, p95: 0, intervalsMissed };
  }
  const p = computePercentiles(samples);
  return { samples, p95: p.p95 ?? 0, intervalsMissed };
}
