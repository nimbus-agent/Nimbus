import type { Syncable } from "../sync/types.ts";
import { mapMonteCarloIncidentToItem } from "./monte-carlo-dq-mapping.ts";
import { createWarehouseListSyncable } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "montecarlo";
const LIST_TOOL_ID = "montecarlo_list";

/**
 * Monte Carlo sync on the unified Wave-7b spawn transport ({@link createWarehouseListSyncable}): it
 * drains the relay-paginated `montecarlo_list`, and the gateway maps each incident node directly via
 * {@link mapMonteCarloIncidentToItem} (which skips non-objects / missing `incidentId`).
 */
export function createMonteCarloSyncable(): Syncable {
  return createWarehouseListSyncable(SERVICE_ID, [
    { listToolId: LIST_TOOL_ID, map: mapMonteCarloIncidentToItem },
  ]);
}
