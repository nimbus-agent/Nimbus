import type { BenchRunOptions } from "../types.ts";
import { type GatewayRssRunOptions, measureGatewayRss } from "./bench-rss-shared.ts";

const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_INTERVAL_MS = 1_000;

export type RssIdleRunOptions = GatewayRssRunOptions;

export function runRssIdleOnce(
  _opts: BenchRunOptions,
  runOpts: RssIdleRunOptions = {},
): Promise<number[]> {
  return measureGatewayRss(runOpts, {
    durationMs: DEFAULT_DURATION_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
  });
}
