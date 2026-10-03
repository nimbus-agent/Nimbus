import type { BenchRunOptions } from "../types.ts";
import { type CliSpawnRunOptions, sampleCliSpawns } from "./bench-cli-spawn-shared.ts";

export const CLI_COLD_SAMPLES_PER_RUN = 10;
const CLI_TIMEOUT_MS = 15_000;

export type RunOptions = CliSpawnRunOptions;

export function runCliOverheadColdOnce(
  _opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  return sampleCliSpawns(
    { args: ["help"], mode: "exit", timeoutMs: CLI_TIMEOUT_MS, samples: CLI_COLD_SAMPLES_PER_RUN },
    runOpts,
  );
}
