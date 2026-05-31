import type { BenchRunOptions, CorpusTier } from "../types.ts";
import { type RunOptions as BaseRunOptions, runQueryLatencyOnce } from "./bench-query-latency.ts";

export const S2B_TIER: CorpusTier = "medium";

export interface RunOptions extends BaseRunOptions {
  overrideTier?: CorpusTier;
}

export async function runQueryLatency100kOnce(
  opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  const tier: CorpusTier = runOpts.overrideTier ?? S2B_TIER;
  const baseOpts: BaseRunOptions = {};
  if (runOpts.cacheDir !== undefined) baseOpts.cacheDir = runOpts.cacheDir;
  return runQueryLatencyOnce({ ...opts, corpus: tier }, baseOpts);
}
