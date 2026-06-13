import { normalizeDataModelKey } from "./data-model-key.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type PowerBiMappedRow = MappedRow<"powerbi", "dashboard">;

export interface PowerBiMappingContext {
  readonly syncedAt: number;
}

const SERVICE = "powerbi" as const;
const TYPE = "dashboard" as const;

/**
 * Maps a raw Power BI report/dashboard API object to a dashboard index item.
 * Returns null when the required reportId or name is missing.
 *
 * `raw.datasetTables` (string[]) provides the dataset's table names for
 * upstream lineage keys: each name is normalized via normalizeDataModelKey
 * and stored in metadata.upstreamDataModelKeys.
 */
export function mapPowerBiReportToItem(
  raw: unknown,
  ctx: PowerBiMappingContext,
): PowerBiMappedRow | null {
  const r = asRecord(raw);
  if (r === undefined) return null;
  const id = stringField(r, "id");
  const name = stringField(r, "name");
  if (id === undefined || id === "" || name === undefined || name === "") return null;
  const workspace = stringField(r, "workspace") ?? null;
  const datasetId = stringField(r, "datasetId") ?? null;
  const rawTables = Array.isArray(r["datasetTables"]) ? r["datasetTables"] : [];
  const upstreamDataModelKeys = rawTables
    .filter((t): t is string => typeof t === "string" && t !== "")
    .map((t) => normalizeDataModelKey(t))
    .filter((k): k is string => k !== null);
  const workspaceSuffix = workspace === null ? "" : ` · ${workspace}`;
  return {
    service: SERVICE,
    type: TYPE,
    externalId: `powerbi:${id}`,
    title: name,
    bodyPreview: `Power BI dashboard${workspaceSuffix}`,
    url: null,
    canonicalUrl: null,
    modifiedAt: ctx.syncedAt,
    metadata: { upstreamDataModelKeys, workspace, datasetId },
    syncedAt: ctx.syncedAt,
  };
}
