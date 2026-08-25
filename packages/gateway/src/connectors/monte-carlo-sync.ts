import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { mapMonteCarloIncidentToItem } from "./monte-carlo-dq-mapping.ts";
import { listConnectorItems } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "montecarlo";
const LIST_TOOL_ID = "montecarlo_list";

/**
 * Monte Carlo sync on the unified Wave-7b spawn transport. {@link listConnectorItems} spawns the
 * connector once (personal: service-scoped vault view; team: the I19 localOperator gate) and drains
 * the relay-paginated `montecarlo_list`; the gateway maps each incident node directly via
 * {@link mapMonteCarloIncidentToItem} (which skips non-objects / missing `incidentId`). Pagination is
 * fully drained in the transport, so the input `cursor` passes through unchanged.
 */
export function createMonteCarloSyncable(): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const raw = await listConnectorItems(ctx, SERVICE_ID, LIST_TOOL_ID);
      const now = Date.now();
      let upserted = 0;
      for (const rawIncident of raw) {
        const mapped = mapMonteCarloIncidentToItem(rawIncident, { syncedAt: now });
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
