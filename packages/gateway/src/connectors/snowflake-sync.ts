import type { Syncable } from "../sync/types.ts";
import { mapSnowflakeTableToItem } from "./snowflake-data-model-mapping.ts";
import { createWarehouseListSyncable } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "snowflake";
const LIST_TOOL_ID = "snowflake_list";

/**
 * Snowflake sync on the unified Wave-7b spawn transport ({@link createWarehouseListSyncable}): it
 * drains the paginated `snowflake_list`, whose raw rows the connector has already shaped into the
 * lowercase named columns {@link mapSnowflakeTableToItem} expects.
 */
export function createSnowflakeSyncable(): Syncable {
  return createWarehouseListSyncable(SERVICE_ID, [
    { listToolId: LIST_TOOL_ID, map: mapSnowflakeTableToItem },
  ]);
}
