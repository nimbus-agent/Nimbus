import { DEFAULT_FINOPS_CONFIG } from "../config/finops-toml.ts";
import { FIRST_WINDOW_DAYS } from "../finops/cost-item-contract.ts";
import { rollUpCostPointsDetailed } from "../finops/cost-rollup.ts";
import type { Syncable } from "../sync/types.ts";
import { createFinopsSyncable } from "./finops-sync-transport.ts";
import {
  costAllocationItem,
  mapVantageCostRow,
  mapVantageRecommendationToItem,
} from "./vantage-cost-mapping.ts";

const SERVICE_ID = "vantage";
const COST_LIST_TOOL_ID = "vantage_cost_list";
const RECOMMENDATION_LIST_TOOL_ID = "vantage_recommendation_list";
const HOUR6 = 6 * 60 * 60 * 1000;

/** The documented page maxima of the two tools (their zod schemas refuse a larger `limit`). */
export const VANTAGE_COST_PAGE_LIMIT = 5000;
export const VANTAGE_RECOMMENDATION_PAGE_LIMIT = 1000;

export interface VantageSyncableOptions {
  /** `[finops] max_series`, read per sync; absent means the default (500). */
  readonly maxSeries?: () => number;
}

interface Prepared {
  readonly scopeId: string;
  readonly groupBy: readonly string[];
  readonly workspace: string;
}

/** The grouping the connector sends when neither a saved report nor `vantage.group_by` names one. */
const DEFAULT_GROUP_BY: readonly string[] = ["provider", "service", "account_id"];

function parseGroupBy(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Vantage on the FinOps transport: costs by day (`vantage_cost_list`, `sinceMs`/`untilMs`, 5000 a
 * page) and the active recommendations (`vantage_recommendation_list`, 1000 a page, no window), both
 * drained before anything is written. Cost rows are rolled up to the named series set and
 * `__other__` (`finops/cost-rollup.ts`); the cursor carries the last successful sync time.
 */
export function createVantageSyncable(options: VantageSyncableOptions = {}): Syncable {
  return createFinopsSyncable<Prepared, "costs" | "recommendations">({
    serviceId: SERVICE_ID,
    defaultIntervalMs: HOUR6,
    initialSyncDepthDays: FIRST_WINDOW_DAYS,
    cursorPrefix: "nimbus-vantage1:",
    cursorRowType: "cost_allocation",
    cursorScope: (p) => `${p.scopeId}|${p.workspace}|${p.groupBy.join(",")}`,
    async configure(ctx) {
      const groupBy = parseGroupBy(await ctx.getSecret("group_by"));
      if (groupBy.some((name) => name.startsWith("tag:"))) {
        // Where Vantage returns the value of a tag grouping is not documented (spec R2): refuse
        // rather than index a series whose dimension we cannot read.
        throw new Error(
          "vantage.group_by: a tag: grouping is not supported yet; use provider, service, account_id or another named field",
        );
      }
      const scope = (await ctx.getSecret("cost_report_token"))?.trim() ?? "";
      const workspace = (await ctx.getSecret("workspace_token"))?.trim() ?? "";
      // With a saved report the report's own groupings apply and the mapper orders by name; without
      // one the connector's documented default grouping applies, in this order.
      const effective = groupBy.length === 0 && scope === "" ? DEFAULT_GROUP_BY : groupBy;
      return { scopeId: scope === "" ? "default" : scope, groupBy: effective, workspace };
    },
    drains: (window) => [
      {
        key: "costs",
        toolId: COST_LIST_TOOL_ID,
        args: { sinceMs: window.sinceMs, untilMs: window.untilMs, limit: VANTAGE_COST_PAGE_LIMIT },
      },
      {
        key: "recommendations",
        toolId: RECOMMENDATION_LIST_TOOL_ID,
        args: { limit: VANTAGE_RECOMMENDATION_PAGE_LIMIT },
      },
    ],
    index(ctx, drained, syncedAt, prepared, fresh) {
      const costRows = drained.costs;
      const points = costRows.flatMap((raw) => {
        const point = mapVantageCostRow(raw, prepared);
        return point === null ? [] : [point];
      });
      if (points.length < costRows.length) {
        // A count only: a dropped row's content is never logged.
        ctx.logger.warn(
          { serviceId: SERVICE_ID, dropped: costRows.length - points.length },
          "vantage cost rows skipped (no usable day or amount)",
        );
      }
      const { rows: rolled, mixedCurrencyBuckets } = rollUpCostPointsDetailed(points, {
        service: SERVICE_ID,
        scopeId: prepared.scopeId,
        maxSeries: options.maxSeries?.() ?? DEFAULT_FINOPS_CONFIG.maxSeries,
        // A changed configuration (fresh) does not inherit the old configuration's named set.
        existingSeriesHashes: new Set(
          fresh ? [] : ctx.listIndexedMetadataValues(SERVICE_ID, "seriesHash"),
        ),
        syncedAt,
      });
      if (mixedCurrencyBuckets > 0) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, mixedCurrencyBuckets },
          "vantage series-days in more than one currency were not indexed",
        );
      }
      const rows = [
        ...rolled.map((r) => costAllocationItem(r, syncedAt)),
        ...drained.recommendations.flatMap((raw) => {
          const item = mapVantageRecommendationToItem(raw, { syncedAt });
          return item === null ? [] : [item];
        }),
      ];
      // ONE transaction for the whole sync: the cost rows and the recommendations land together.
      const recommendations = rows.filter((r) => r.type === "cost_recommendation");
      let deleted = 0;
      ctx.writeBatch(() => {
        for (const row of rows) {
          ctx.upsertItem(row);
        }
        // The recommendation drain has no window: it is the whole active set, so a row Vantage no
        // longer lists is stale and goes.
        deleted = ctx.replaceItemSet(
          "cost_recommendation",
          recommendations.map((r) => r.externalId),
        );
      });
      return { written: rows.length, deleted };
    },
  });
}
