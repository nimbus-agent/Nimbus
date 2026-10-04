import type { BenchRunOptions } from "../types.ts";
import { type CliSpawnRunOptions, sampleCliSpawns } from "./bench-cli-spawn-shared.ts";

export const TUI_FIRST_PAINT_SAMPLES_PER_RUN = 5;
const FIRST_FRAME_MARKER = /\[tui\] first-frame/;
const TUI_TIMEOUT_MS = 15_000;

export type RunOptions = CliSpawnRunOptions;

export function runTuiFirstPaintOnce(
  _opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  return sampleCliSpawns(
    {
      args: ["tui"],
      mode: "marker",
      marker: FIRST_FRAME_MARKER,
      env: { NIMBUS_BENCH: "1" },
      timeoutMs: TUI_TIMEOUT_MS,
      samples: TUI_FIRST_PAINT_SAMPLES_PER_RUN,
    },
    runOpts,
  );
}
