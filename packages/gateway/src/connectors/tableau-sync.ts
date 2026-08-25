import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { mapTableauViewToItem } from "./tableau-dashboard-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { listConnectorItems } from "./warehouse-sync-transport.ts";

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
 * Tableau sync on the unified Wave-7b spawn transport. {@link listConnectorItems} spawns the
 * connector once (personal: service-scoped vault view; team: the I19 localOperator gate) and drains
 * the paginated `tableau_list`; the gateway reshapes + maps each view. Pagination is fully drained in
 * the transport, so the input `cursor` passes through unchanged.
 */
export function createTableauSyncable(): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const raw = await listConnectorItems(ctx, SERVICE_ID, LIST_TOOL_ID);
      const now = Date.now();
      let upserted = 0;
      for (const rawView of raw) {
        const mapped = mapTableauViewToItem(shapeTableauView(rawView), { syncedAt: now });
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
