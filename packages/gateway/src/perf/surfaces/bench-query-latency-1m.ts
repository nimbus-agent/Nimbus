import type { BenchRunOptions, CorpusTier } from "../types.ts";
import { type RunOptions as BaseRunOptions, runQueryLatencyOnce } from "./bench-query-latency.ts";

export const S2C_TIER: CorpusTier = "large";

export interface RunOptions extends BaseRunOptions {
  overrideTier?: CorpusTier;
}

export async function runQueryLatency1mOnce(
  opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  const tier: CorpusTier = runOpts.overrideTier ?? S2C_TIER;
  const baseOpts: BaseRunOptions = {};
  if (runOpts.cacheDir !== undefined) baseOpts.cacheDir = runOpts.cacheDir;
  return runQueryLatencyOnce({ ...opts, corpus: tier }, baseOpts);
}
