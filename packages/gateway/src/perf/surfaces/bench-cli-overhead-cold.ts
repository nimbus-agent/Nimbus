import { resolve } from "node:path";

import { spawnAndTimeToMarker } from "../process-spawn-bench.ts";
import type { BenchRunOptions } from "../types.ts";

export const CLI_COLD_SAMPLES_PER_RUN = 10;
const CLI_TIMEOUT_MS = 15_000;

export interface RunOptions {
  spawn?: typeof Bun.spawn;
  cliEntry?: string;
}

function defaultCliEntry(): string {
  return resolve(import.meta.dir, "..", "..", "..", "..", "cli", "src", "index.ts");
}

export async function runCliOverheadColdOnce(
  _opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  const samples: number[] = [];
  const entry = runOpts.cliEntry ?? defaultCliEntry();
  for (let i = 0; i < CLI_COLD_SAMPLES_PER_RUN; i += 1) {
    const ms = await spawnAndTimeToMarker({
      cmd: process.execPath,
      args: [entry, "help"],
      mode: "exit",
      timeoutMs: CLI_TIMEOUT_MS,
      ...(runOpts.spawn !== undefined && { spawn: runOpts.spawn }),
    });
    samples.push(ms);
  }
  return samples;
}
