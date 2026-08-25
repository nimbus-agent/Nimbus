import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { mapSnowflakeTableToItem } from "./snowflake-data-model-mapping.ts";
import { listConnectorItems } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "snowflake";
const LIST_TOOL_ID = "snowflake_list";

/**
 * Snowflake sync on the unified Wave-7b spawn transport. {@link listConnectorItems} spawns the
 * connector once (personal: service-scoped vault view; team: the I19 localOperator gate), drains the
 * paginated `snowflake_list`, and returns the raw rows — which the connector has already shaped into
 * the lowercase named columns {@link mapSnowflakeTableToItem} expects. Pagination is fully drained in
 * the transport, so the input `cursor` passes through unchanged (`hasMore: false`).
 */
export function createSnowflakeSyncable(): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const raw = await listConnectorItems(ctx, SERVICE_ID, LIST_TOOL_ID);
      const now = Date.now();
      let upserted = 0;
      for (const row of raw) {
        const mapped = mapSnowflakeTableToItem(row, { syncedAt: now });
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
