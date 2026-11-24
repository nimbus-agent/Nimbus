import type { Syncable } from "../sync/types.ts";
import { createK8sCostSyncable } from "./k8s-cost-sync.ts";
import { createVantageSyncable } from "./vantage-sync.ts";

/**
 * Registers the FinOps syncables (Phase 10): Vantage, then OpenCost and Kubecost. `maxSeries` is
 * `[finops] max_series`, read per sync; absent means the default. Each source runs on its own timer
 * and fails on its own: an unconfigured one is skipped by the scheduler's configured check.
 */
export function registerFinopsSyncables(
  scheduler: { register(syncable: Syncable): void },
  maxSeries: (() => number) | undefined,
): void {
  const options = maxSeries === undefined ? {} : { maxSeries };
  scheduler.register(createVantageSyncable(options));
  scheduler.register(createK8sCostSyncable("opencost", options));
  scheduler.register(createK8sCostSyncable("kubecost", options));
}
