import type { Syncable } from "../sync/types.ts";
import { mapTableauViewToItem } from "./tableau-dashboard-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { createWarehouseListSyncable } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "tableau";
const LIST_TOOL_ID = "tableau_list";

/**
 * Reshape one raw Tableau view (as `tableau_list` emits it) into the record
 * {@link mapTableauViewToItem} consumes — name falls back to the workbook name; author comes from the
 * owner. Tableau's views endpoint carries no upstream-table info, so `dataSourceTables` is empty
 * (the lineage edge is exercised at the mapper/graph level via explicit fixtures, as in Wave 7a).
 */
function shapeTableauView(raw: unknown): Record<string, unknown> {
  const r = asRecord(raw);
  if (r === undefined) return {};
  const name = stringField(r, "name") ?? "";
  const workbook = asRecord(r["workbook"]);
  const workbookName = workbook === undefined ? "" : (stringField(workbook, "name") ?? "");
  const owner = asRecord(r["owner"]);
  const author = owner === undefined ? null : (stringField(owner, "name") ?? null);
  return {
    luid: stringField(r, "luid") ?? "",
    name: name === "" ? workbookName : name,
    author,
    folder: null,
    extractRefreshStatus: null,
    dataSourceTables: [] as string[],
  };
}

/**
 * Tableau sync on the unified Wave-7b spawn transport ({@link createWarehouseListSyncable}): it
 * drains the paginated `tableau_list`, and the gateway reshapes + maps each view.
 */
export function createTableauSyncable(): Syncable {
  return createWarehouseListSyncable(SERVICE_ID, [
    {
      listToolId: LIST_TOOL_ID,
      map: (rawView, mapping) => mapTableauViewToItem(shapeTableauView(rawView), mapping),
    },
  ]);
}
