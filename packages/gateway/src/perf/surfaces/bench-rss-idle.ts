import { resolve } from "node:path";

import { spawnGatewayForBench } from "../gateway-spawn-bench.ts";
import { sampleRss } from "../rss-sampler.ts";
import type { BenchRunOptions } from "../types.ts";

const READY_MARKER = /\[gateway\] ready/;
const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_INTERVAL_MS = 1_000;

export interface RssIdleRunOptions {
  spawn?: typeof Bun.spawn;
  gatewayEntry?: string;
  durationMs?: number;
  intervalMs?: number;
  pidusage?: (pid: number) => Promise<{ memory: number }>;
}

function defaultGatewayEntry(): string {
  return resolve(import.meta.dir, "..", "..", "index.ts");
}

export async function runRssIdleOnce(
  _opts: BenchRunOptions,
  runOpts: RssIdleRunOptions = {},
): Promise<number[]> {
  const durationMs = runOpts.durationMs ?? DEFAULT_DURATION_MS;
  const intervalMs = runOpts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const entry = runOpts.gatewayEntry ?? defaultGatewayEntry();

  const result = await spawnGatewayForBench<void, { samples: number[] }>({
    cmd: process.execPath,
    args: [entry],
    readyMarker: READY_MARKER,
    ...(runOpts.spawn !== undefined && { spawn: runOpts.spawn }),
    workload: ({ signal }) =>
      new Promise<void>((resolve_) => {
        const t = setTimeout(resolve_, durationMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve_();
          },
          { once: true },
        );
      }),
    sampler: async ({ pid, signal }) =>
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
