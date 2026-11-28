// Phase 7 (the Cost Pack, slices 5, 6 and 8): the cost capabilities of a bound SyncContext (static D24,
// `cost-line-confined`). Kept out of `sync-capabilities.ts`, which spreads them in. Each is bound to the
// syncable's own service: the line `source` is the service id and is never a parameter, and only a cost-sync
// service may call them, so a sync can never read, write or re-price another source's lines (a FOCUS import's
// included).
import type { Database } from "bun:sqlite";

import type { CostLine } from "../finops/cost-line.ts";
import type { ReplaceCostLinesResult, RepriceCostLinesResult } from "../finops/cost-line-store.ts";
import type { CostRates } from "../finops/cost-rate-price.ts";
import {
  type CostSyncTarget,
  ingestSyncedCostLines,
  readOwnSyncedCostLines,
  repriceSyncedCostLines,
} from "../finops/cost-sync-intake.ts";
import { loadSchedulerState } from "./scheduler-store.ts";

/** The services that may use the cost capabilities. */
export const COST_SYNC_SERVICES: ReadonlySet<string> = new Set([
  "github_billing",
  "openai_billing",
  "anthropic_billing",
  "gitlab_billing",
  "aws_billing",
  "azure_billing",
]);

export interface CostSyncCapabilities {
  /**
   * Replaces THIS service's cost lines of one (provider, billing account, month). One transaction; a line of any
   * other source, provider, account or month refuses the whole call.
   */
  replaceCostLinesForMonth(
    target: CostSyncTarget,
    lines: readonly CostLine[],
  ): ReplaceCostLinesResult;
  /** THIS service's stored lines of one (provider, billing account, month): what a delta sync builds on. */
  readOwnCostLinesForMonth(target: CostSyncTarget): CostLine[];
  /** Prices THIS service's stored lines again from their quantity and `rate_key` (a changed rate; no API call). */
  repriceOwnCostLines(rates: CostRates): RepriceCostLinesResult;
}

const COST_CAPABILITY_NAMES = [
  "replaceCostLinesForMonth",
  "readOwnCostLinesForMonth",
  "repriceOwnCostLines",
] as const;

export function buildCostSyncCapabilities(db: Database, serviceId: string): CostSyncCapabilities {
  const allowed = (what: string): void => {
    if (!COST_SYNC_SERVICES.has(serviceId)) {
      throw new Error(`${what} is not available to "${serviceId}".`);
    }
  };
  // `connector remove` deletes the scheduler row and the lines: a run that was still fetching must not write
  // them back. Checked at the write (one synchronous step with it), not before the fetch.
  const notRemoved = (): void => {
    if (loadSchedulerState(db, serviceId) === null) {
      throw new Error(`${serviceId} was removed during this sync; its cost lines are not written`);
    }
  };
  return {
    replaceCostLinesForMonth: (target, lines) => {
      allowed("replaceCostLinesForMonth");
      notRemoved();
      return ingestSyncedCostLines(db, serviceId, target, lines, Date.now());
    },
    readOwnCostLinesForMonth: (target) => {
      allowed("readOwnCostLinesForMonth");
      return readOwnSyncedCostLines(db, serviceId, target);
    },
    repriceOwnCostLines: (rates) => {
      allowed("repriceOwnCostLines");
      notRemoved();
      return repriceSyncedCostLines(db, serviceId, rates);
    },
  };
}

/** The three capabilities, each refusing with `refuse` (an unbound or local-only context). */
export function refusingCostSyncCapabilities(
  refuse: (what: string) => never,
): CostSyncCapabilities {
  const out = {} as Record<(typeof COST_CAPABILITY_NAMES)[number], () => never>;
  for (const name of COST_CAPABILITY_NAMES) out[name] = () => refuse(name);
  return out;
}
