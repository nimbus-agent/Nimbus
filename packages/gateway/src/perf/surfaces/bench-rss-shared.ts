import { resolve } from "node:path";

import { spawnGatewayForBench } from "../gateway-spawn-bench.ts";
import { sampleRss } from "../rss-sampler.ts";

const READY_MARKER = /\[gateway\] ready/;

/** Injection points shared by the gateway RSS surfaces (S7-a idle, S7-b heavy sync). */
export interface GatewayRssRunOptions {
  spawn?: typeof Bun.spawn;
  gatewayEntry?: string;
  durationMs?: number;
  intervalMs?: number;
  pidusage?: (pid: number) => Promise<{ memory: number }>;
}

/** A surface's own measuring window and sample interval, used when the run does not set them. */
export interface RssWindowDefaults {
  durationMs: number;
  intervalMs: number;
}

function defaultGatewayEntry(): string {
  return resolve(import.meta.dir, "..", "..", "index.ts");
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function idleFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        done();
      },
      { once: true },
    );
  });
}

/**
 * Boots a gateway and samples its RSS while it works: once it reports ready, the workload runs
 * `beforeIdle` (when given, with the run's abort signal) and then idles for the window's duration.
 * Returns the RSS samples in bytes.
 */
export async function measureGatewayRss(
  runOpts: GatewayRssRunOptions,
  defaults: RssWindowDefaults,
  beforeIdle?: (signal: AbortSignal) => Promise<void>,
): Promise<number[]> {
  const durationMs = runOpts.durationMs ?? defaults.durationMs;
  const intervalMs = runOpts.intervalMs ?? defaults.intervalMs;
  const entry = runOpts.gatewayEntry ?? defaultGatewayEntry();

  const result = await spawnGatewayForBench<void, { samples: number[] }>({
    cmd: process.execPath,
    args: [entry],
    readyMarker: READY_MARKER,
    ...(runOpts.spawn !== undefined && { spawn: runOpts.spawn }),
    workload: async ({ signal }) => {
      if (beforeIdle !== undefined) await beforeIdle(signal);
      await idleFor(durationMs, signal);
    },
    sampler: ({ pid, signal }) =>
      sampleRss({
        pid,
        durationMs,
        intervalMs,
        signal,
        ...(runOpts.pidusage !== undefined && { pidusage: runOpts.pidusage }),
      }),
  });
  return result.samplerResult?.samples ?? [];
}
