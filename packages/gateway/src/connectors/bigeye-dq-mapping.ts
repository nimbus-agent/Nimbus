import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import { normalizeDataModelKey } from "./data-model-key.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type BigeyeMappedRow = MappedRow<"bigeye", "data_quality_test">;

export interface BigeyeMappingContext {
  readonly syncedAt: number;
}

/**
 * Pure mapper: one Bigeye issue raw object → a `data_quality_test` IndexedItem.
 * The `monitoredDataModelKeys` metadata field carries the normalized table key
 * so the graph populator auto-emits a `data_quality_test --monitors--> data_model`
 * edge.
 *
 * Returns null when the required `issueId` field is missing.
 */
export function mapBigeyeIssueToItem(
  raw: unknown,
  ctx: BigeyeMappingContext,
): BigeyeMappedRow | null {
  const r = asRecord(raw);
  if (r === undefined) return null;

  const issueId = stringField(r, "issueId");
  if (issueId === undefined || issueId === "") return null;

  const monitoredTable = stringField(r, "monitoredTable") ?? null;
  const slaStatus = stringField(r, "slaStatus") ?? null;
  const anomaly = stringField(r, "anomaly") ?? null;

  const normalizedKey = monitoredTable !== null ? normalizeDataModelKey(monitoredTable) : null;
  const monitoredDataModelKeys: string[] = normalizedKey !== null ? [normalizedKey] : [];

  const slaStatusSuffix = slaStatus !== null ? ` [${slaStatus}]` : "";
  const title = clampSyncTitle(`Bigeye issue ${issueId}${slaStatusSuffix}`);
  const bodyPreview = clampSyncTitle(
    `Issue ${issueId}` +
      (slaStatus !== null ? ` · slaStatus=${slaStatus}` : "") +
      (monitoredTable !== null ? ` · table=${monitoredTable}` : ""),
  );

  return {
    service: "bigeye",
    type: "data_quality_test",
    externalId: `bigeye:${issueId}`,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt: ctx.syncedAt,
    metadata: {
      monitoredDataModelKeys,
      slaStatus,
      anomaly,
    },
    syncedAt: ctx.syncedAt,
  };
}
