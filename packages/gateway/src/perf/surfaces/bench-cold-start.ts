import { resolve } from "node:path";

import { spawnAndTimeToMarker } from "../process-spawn-bench.ts";
import type { BenchRunOptions } from "../types.ts";

export const COLD_START_SAMPLES_PER_RUN = 5;
const READY_MARKER = /\[gateway\] ready/;
const COLD_START_TIMEOUT_MS = 30_000;

export interface RunOptions {
  spawn?: typeof Bun.spawn;
  gatewayEntry?: string;
}

function defaultGatewayEntry(): string {
  return resolve(import.meta.dir, "..", "..", "index.ts");
}

export async function runColdStartOnce(
  _opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  const samples: number[] = [];
  const entry = runOpts.gatewayEntry ?? defaultGatewayEntry();

  for (let i = 0; i < COLD_START_SAMPLES_PER_RUN; i += 1) {
    const ms = await spawnAndTimeToMarker({
      cmd: process.execPath,
      args: [entry],
      mode: "marker",
      marker: READY_MARKER,
      timeoutMs: COLD_START_TIMEOUT_MS,
      ...(runOpts.spawn !== undefined && { spawn: runOpts.spawn }),
    });
    samples.push(ms);
  }
  return samples;
}
