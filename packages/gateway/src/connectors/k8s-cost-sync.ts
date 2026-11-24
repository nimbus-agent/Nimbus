import { DEFAULT_FINOPS_CONFIG } from "../config/finops-toml.ts";
import { FIRST_WINDOW_DAYS, sanitiseScopeId } from "../finops/cost-item-contract.ts";
import { rollUpCostPointsDetailed, scopeSeriesOf } from "../finops/cost-rollup.ts";
import { itemPrimaryKey } from "../index/item-key.ts";
import type { Syncable, SyncContext } from "../sync/types.ts";
import { createFinopsSyncable } from "./finops-sync-transport.ts";
import {
  type K8sAggregate,
  type K8sCostService,
  k8sCostAllocationItem,
  mapK8sCostRow,
} from "./k8s-cost-mapping.ts";

const HOUR6 = 6 * 60 * 60 * 1000;

/** The page size the connector's tool accepts at most is 20,000; 5,000 keeps one page small. */
export const K8S_COST_PAGE_LIMIT = 5000;

const AGGREGATES: readonly K8sAggregate[] = ["namespace", "controller"];

export interface K8sCostSyncableOptions {
  /** `[finops] max_series`, read per sync; absent means the default (500). */
  readonly maxSeries?: () => number;
}

interface Prepared {
  readonly scopeId: string;
  readonly aggregate: K8sAggregate;
}

/** The series hashes already indexed under `seriesScope` (see `CostAllocationMetadata.scopeSeries`). */
function currentSeriesHashes(ctx: SyncContext, service: K8sCostService, scope: string): string[] {
  const prefix = scopeSeriesOf(scope, "");
  return ctx
    .listIndexedMetadataValues(service, "scopeSeries")
    .filter((v) => v.startsWith(prefix) && v.length === prefix.length + 16)
    .map((v) => v.slice(prefix.length));
}

function seriesScopeOf(p: Prepared): string {
  return `${p.scopeId}|${p.aggregate}`;
}

/** `<service>.aggregate`: absent means namespace; anything but the two offered values is refused. */
function aggregateFrom(service: K8sCostService, raw: string | null): K8sAggregate {
  const value = (raw ?? "").trim();
  if (value === "") {
    return "namespace";
  }
  const found = AGGREGATES.find((a) => a === value);
  if (found === undefined) {
    throw new Error(`${service}: the aggregate setting must be "namespace" or "controller"`);
  }
  return found;
}

/**
 * OpenCost or Kubecost on the FinOps transport: one paged read (`<service>_allocation_list`,
 * `sinceMs`/`untilMs`, 5,000 a page) of the cluster's daily allocation per namespace (or per
 * controller), drained before anything is written. Rows go through the same roll-up as Vantage's
 * (`finops/cost-rollup.ts`), so the named set is capped at `[finops] max_series`; nothing here is
 * ever embedded (type `cost_allocation`). The cursor carries the last successful sync time.
 * `<service>.cluster` (optional) labels the series scope, so one install can tell two clusters
 * apart if the owner points the service at another one and names it.
 */
export function createK8sCostSyncable(
  service: K8sCostService,
  options: K8sCostSyncableOptions = {},
): Syncable {
  const toolId = `${service}_allocation_list`;
  return createFinopsSyncable<Prepared, "allocations">({
    serviceId: service,
    defaultIntervalMs: HOUR6,
    initialSyncDepthDays: FIRST_WINDOW_DAYS,
    cursorPrefix: `nimbus-${service}1:`,
    cursorRowType: "cost_allocation",
    cursorScope: seriesScopeOf,
    async configure(ctx) {
      const aggregate = aggregateFrom(service, await ctx.getSecret("aggregate"));
      const scopeId = sanitiseScopeId((await ctx.getSecret("cluster"))?.trim() ?? null);
      return { scopeId, aggregate };
    },
    drains: (window, prepared) => [
      {
        key: "allocations",
        toolId,
        args: {
          sinceMs: window.sinceMs,
          untilMs: window.untilMs,
          aggregate: prepared.aggregate,
          limit: K8S_COST_PAGE_LIMIT,
        },
      },
    ],
    index(ctx, drained, syncedAt, prepared) {
      const rowsIn = drained.allocations;
      const points = rowsIn.flatMap((raw) => {
        const point = mapK8sCostRow(raw, { service, ...prepared });
        return point === null ? [] : [point];
      });
      if (points.length < rowsIn.length) {
        // A count only: a dropped row's content is never logged.
        ctx.logger.warn(
          { serviceId: service, dropped: rowsIn.length - points.length },
          "kubernetes cost rows skipped (no usable day, key or amount)",
        );
      }
      const scope = seriesScopeOf(prepared);
      const { rows: rolled, staleOtherIds } = rollUpCostPointsDetailed(points, {
        service,
        scopeId: prepared.scopeId,
        maxSeries: options.maxSeries?.() ?? DEFAULT_FINOPS_CONFIG.maxSeries,
        seriesScope: scope,
        // Only the series indexed under THIS cluster label and grouping count against the cap.
        existingSeriesHashes: new Set(currentSeriesHashes(ctx, service, scope)),
        syncedAt,
      });
      const rows = rolled.map((r) => k8sCostAllocationItem(service, r, syncedAt));
      let deleted = 0;
      ctx.writeBatch(() => {
        for (const row of rows) {
          ctx.upsertItem(row);
        }
        // A re-read day that folds nothing now must not keep an earlier sync's `__other__` row.
        for (const id of staleOtherIds) {
          if (!ctx.itemExists(itemPrimaryKey(service, id))) continue;
          ctx.deleteItem(service, id);
          deleted += 1;
        }
      });
      return { written: rows.length, deleted };
    },
  });
}
