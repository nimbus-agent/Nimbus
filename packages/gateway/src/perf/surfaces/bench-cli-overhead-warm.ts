import type { BenchRunOptions } from "../types.ts";
import { type CliSpawnRunOptions, sampleCliSpawns } from "./bench-cli-spawn-shared.ts";

export const CLI_WARM_SAMPLES_PER_RUN = 20;
const CLI_TIMEOUT_MS = 15_000;

export type RunOptions = CliSpawnRunOptions;

export function runCliOverheadWarmOnce(
  _opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  return sampleCliSpawns(
    {
      args: ["help"],
      mode: "exit",
      timeoutMs: CLI_TIMEOUT_MS,
      samples: CLI_WARM_SAMPLES_PER_RUN,
      // The one unsampled spawn that makes this the warm variant of S11-a.
      warmupRuns: 1,
    },
    runOpts,
  );
}
