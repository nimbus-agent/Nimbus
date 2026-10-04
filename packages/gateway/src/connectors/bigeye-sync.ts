import type { Syncable } from "../sync/types.ts";
import { mapBigeyeIssueToItem } from "./bigeye-dq-mapping.ts";
import { createWarehouseListSyncable } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "bigeye";
const LIST_TOOL_ID = "bigeye_list";

/**
 * Bigeye sync on the unified Wave-7b spawn transport ({@link createWarehouseListSyncable}): it drains
 * the offset-paginated `bigeye_list`, and the gateway maps each issue directly via
 * {@link mapBigeyeIssueToItem} (which skips non-objects / missing `issueId`). The base-URL safety
 * guard now lives in the spawner (`phase3AddBigeyeMcp`), so the gateway no longer interpolates the
 * URL itself.
 */
export function createBigeyeSyncable(): Syncable {
  return createWarehouseListSyncable(SERVICE_ID, [
    { listToolId: LIST_TOOL_ID, map: mapBigeyeIssueToItem },
  ]);
}
