import { resolve } from "node:path";

import { spawnAndTimeToMarker } from "../process-spawn-bench.ts";
import type { BenchRunOptions } from "../types.ts";

export const TUI_FIRST_PAINT_SAMPLES_PER_RUN = 5;
const FIRST_FRAME_MARKER = /\[tui\] first-frame/;
const TUI_TIMEOUT_MS = 15_000;

export interface RunOptions {
  spawn?: typeof Bun.spawn;
  cliEntry?: string;
}

function defaultCliEntry(): string {
  return resolve(import.meta.dir, "..", "..", "..", "..", "cli", "src", "index.ts");
}

export async function runTuiFirstPaintOnce(
  _opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  const samples: number[] = [];
  const entry = runOpts.cliEntry ?? defaultCliEntry();
  for (let i = 0; i < TUI_FIRST_PAINT_SAMPLES_PER_RUN; i += 1) {
    const ms = await spawnAndTimeToMarker({
      cmd: process.execPath,
      args: [entry, "tui"],
      mode: "marker",
      marker: FIRST_FRAME_MARKER,
      timeoutMs: TUI_TIMEOUT_MS,
      env: { NIMBUS_BENCH: "1" },
      ...(runOpts.spawn !== undefined && { spawn: runOpts.spawn }),
    });
    samples.push(ms);
  }
  return samples;
}
