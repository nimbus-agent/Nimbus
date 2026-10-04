import type { Syncable } from "../sync/types.ts";
import { mapLookerDashboardToItem, mapLookerViewToItem } from "./looker-content-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { createWarehouseListSyncable } from "./warehouse-sync-transport.ts";

const SERVICE_ID = "looker";
const DASHBOARDS_TOOL_ID = "looker_list";
const MODELS_TOOL_ID = "looker_models_list";

function dashboardsFromResponse(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of parsed) {
    const r = asRecord(item);
    if (r !== undefined) out.push(r);
  }
  return out;
}

function viewsFromExplore(
  explore: Record<string, unknown>,
  modelName: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const views = Array.isArray(explore["views"]) ? explore["views"] : [];
  for (const viewItem of views) {
    const view = asRecord(viewItem);
    if (view !== undefined) {
      out.push({ ...view, model: modelName });
    }
  }
  return out;
}

function viewsFromModel(modelItem: unknown): Record<string, unknown>[] {
  const model = asRecord(modelItem);
  if (model === undefined) return [];
  const modelName = stringField(model, "name");
  if (modelName === undefined || modelName === "") return [];
  const explores = Array.isArray(model["explores"]) ? model["explores"] : [];
  const out: Record<string, unknown>[] = [];
  for (const exploreItem of explores) {
    const explore = asRecord(exploreItem);
    if (explore !== undefined) {
      out.push(...viewsFromExplore(explore, modelName));
    }
  }
  return out;
}

function viewsFromModelsResponse(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) return [];
  const out: Record<string, unknown>[] = [];
  for (const modelItem of parsed) {
    out.push(...viewsFromModel(modelItem));
  }
  return out;
}

/**
 * Looker sync on the unified Wave-7b spawn transport. BOTH lists — dashboards (`looker_list`) and
 * LookML models (`looker_models_list`, the dashboard→table lineage source) — are drained through
 * {@link createWarehouseListSyncable} under the SAME `credentialFor("looker")` result, so a
 * team-credentialed sync produces full lineage with no personal-credential dependency (review §3).
 * The gateway flattens each model's explores→views and maps both, exactly as in Wave 7a.
 */
export function createLookerSyncable(): Syncable {
  return createWarehouseListSyncable(SERVICE_ID, [
    { listToolId: DASHBOARDS_TOOL_ID, rows: dashboardsFromResponse, map: mapLookerDashboardToItem },
    { listToolId: MODELS_TOOL_ID, rows: viewsFromModelsResponse, map: mapLookerViewToItem },
  ]);
}
