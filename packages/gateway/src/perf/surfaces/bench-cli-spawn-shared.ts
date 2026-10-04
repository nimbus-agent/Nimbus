import { resolve } from "node:path";

import {
  type SpawnAndTimeOptions,
  type SpawnMode,
  spawnAndTimeToMarker,
} from "../process-spawn-bench.ts";

/** Injection points shared by the surfaces that time a `nimbus` CLI child (S4, S11-a, S11-b). */
export interface CliSpawnRunOptions {
  spawn?: typeof Bun.spawn;
  cliEntry?: string;
}

/** What a CLI surface spawns, how each spawn is timed, and how many timings it keeps. */
export interface CliSpawnPlan {
  /** CLI arguments after the entry script, e.g. `["help"]`. */
  args: readonly string[];
  mode: SpawnMode;
  marker?: RegExp;
  env?: Record<string, string>;
  timeoutMs: number;
  /** How many timings to return. */
  samples: number;
  /** Spawns run before the first timed sample, their timings discarded. Defaults to 0. */
  warmupRuns?: number;
}

function defaultCliEntry(): string {
  return resolve(import.meta.dir, "..", "..", "..", "..", "cli", "src", "index.ts");
}

/**
 * Spawns the CLI `warmupRuns + samples` times, one spawn at a time, and returns the timings of the
 * last `samples` spawns in order. Any failed spawn, a warm-up included, rejects the whole run.
 */
export async function sampleCliSpawns(
  plan: CliSpawnPlan,
  runOpts: CliSpawnRunOptions,
): Promise<number[]> {
  const entry = runOpts.cliEntry ?? defaultCliEntry();
  // One options object for every spawn, warm-ups included: the spawn only reads it.
  const spawnOpts: SpawnAndTimeOptions = {
    cmd: process.execPath,
    args: [entry, ...plan.args],
    mode: plan.mode,
    timeoutMs: plan.timeoutMs,
    ...(plan.marker !== undefined && { marker: plan.marker }),
    ...(plan.env !== undefined && { env: plan.env }),
    ...(runOpts.spawn !== undefined && { spawn: runOpts.spawn }),
  };
  const warmupRuns = plan.warmupRuns ?? 0;
  const samples: number[] = [];
  for (let i = 0; i < warmupRuns + plan.samples; i += 1) {
    const ms = await spawnAndTimeToMarker(spawnOpts); // NOSONAR S9382: timing samples must not overlap - concurrent CLI spawns contend for CPU and skew each measured time, and a warm-up only warms what runs after it
    if (i >= warmupRuns) samples.push(ms);
  }
  return samples;
}
