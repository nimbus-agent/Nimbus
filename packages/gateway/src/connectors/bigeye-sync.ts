import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { mapBigeyeIssueToItem } from "./bigeye-dq-mapping.ts";
import { listConnectorItems } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "bigeye";
const LIST_TOOL_ID = "bigeye_list";

/**
 * Bigeye sync on the unified Wave-7b spawn transport. {@link listConnectorItems} spawns the connector
 * once (personal: service-scoped vault view; team: the I19 localOperator gate) and drains the
 * offset-paginated `bigeye_list`; the gateway maps each issue directly via {@link mapBigeyeIssueToItem}
 * (which skips non-objects / missing `issueId`). Pagination is fully drained in the transport, so the
 * input `cursor` passes through unchanged. The base-URL safety guard now lives in the spawner
 * (`phase3AddBigeyeMcp`), so the gateway no longer interpolates the URL itself.
 */
export function createBigeyeSyncable(): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const raw = await listConnectorItems(ctx, SERVICE_ID, LIST_TOOL_ID);
      const now = Date.now();
      let upserted = 0;
      for (const rawIssue of raw) {
        const mapped = mapBigeyeIssueToItem(rawIssue, { syncedAt: now });
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
