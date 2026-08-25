import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { mapPowerBiReportToItem } from "./powerbi-dashboard-mapping.ts";
import { listConnectorItems } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "powerbi";
const LIST_TOOL_ID = "powerbi_list";

/**
 * Power BI sync on the unified Wave-7b spawn transport. {@link listConnectorItems} spawns the
 * connector once (personal: service-scoped vault view; team: the I19 localOperator gate) and drains
 * `powerbi_list`, which is a single fetch returning every report with its dataset-table refs already
 * expanded — so the dataset-table lineage runs under the SAME credential, in-session, and the gateway
 * makes no second credentialed call (review §3). Each report maps directly with the Wave-7a mapper.
 */
export function createPowerBiSyncable(): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const raw = await listConnectorItems(ctx, SERVICE_ID, LIST_TOOL_ID);
      const now = Date.now();
      let upserted = 0;
      for (const report of raw) {
        const mapped = mapPowerBiReportToItem(report, { syncedAt: now });
        if (mapped !== null) {
          ctx.upsertItem(mapped);
          upserted += 1;
        }
      }
      return {
        cursor,
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}
