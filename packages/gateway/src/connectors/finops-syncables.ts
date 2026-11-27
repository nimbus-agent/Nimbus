import type { Syncable } from "../sync/types.ts";
import { createGithubBillingCostSyncable } from "./github-billing-cost-sync.ts";
import { createK8sCostSyncable } from "./k8s-cost-sync.ts";
import { createVantageSyncable } from "./vantage-sync.ts";

/** What the FinOps syncables read per sync; an absent member means its default. */
export type FinopsSyncOptions = {
  /** `[finops] max_series`. */
  readonly maxSeries?: () => number;
  /** `[cost.github] orgs` (Phase 7 slice 5); absent or empty means no GitHub billing sync. */
  readonly githubOrgs?: () => readonly string[];
};

/**
 * Registers the FinOps syncables: Vantage, then OpenCost and Kubecost (Phase 10), then GitHub billing usage
 * (Phase 7 slice 5). Each source runs on its own timer and fails on its own: an unconfigured one is skipped by
 * the scheduler's configured check.
 */
export function registerFinopsSyncables(
  scheduler: { register(syncable: Syncable): void },
  finops: FinopsSyncOptions | undefined,
): void {
  const maxSeries = finops?.maxSeries;
  const options = maxSeries === undefined ? {} : { maxSeries };
  scheduler.register(createVantageSyncable(options));
  scheduler.register(createK8sCostSyncable("opencost", options));
  scheduler.register(createK8sCostSyncable("kubecost", options));
  scheduler.register(
    createGithubBillingCostSyncable({ githubOrgs: finops?.githubOrgs ?? (() => []) }),
  );
}
