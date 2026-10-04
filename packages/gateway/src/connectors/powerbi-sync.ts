import type { Syncable } from "../sync/types.ts";
import { mapPowerBiReportToItem } from "./powerbi-dashboard-mapping.ts";
import { createWarehouseListSyncable } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "powerbi";
const LIST_TOOL_ID = "powerbi_list";

/**
 * Power BI sync on the unified Wave-7b spawn transport ({@link createWarehouseListSyncable}): it
 * drains `powerbi_list`, which is a single fetch returning every report with its dataset-table refs
 * already expanded — so the dataset-table lineage runs under the SAME credential, in-session, and the
 * gateway makes no second credentialed call (review §3). Each report maps directly with the Wave-7a
 * mapper.
 */
export function createPowerBiSyncable(): Syncable {
  return createWarehouseListSyncable(SERVICE_ID, [
    { listToolId: LIST_TOOL_ID, map: mapPowerBiReportToItem },
  ]);
}
