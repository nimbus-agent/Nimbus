import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import { normalizeDataModelKey } from "./data-model-key.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type MonteCarloMappedRow = MappedRow<"montecarlo", "data_quality_test">;

export interface MonteCarloMappingContext {
  readonly syncedAt: number;
}

/**
 * Pure mapper: one Monte Carlo incident raw object → a `data_quality_test`
 * IndexedItem. The `monitoredDataModelKeys` metadata field carries the
 * normalized table key so the graph populator auto-emits a
 * `data_quality_test --monitors--> data_model` edge.
 *
 * Returns null when the required `incidentId` field is missing.
 */
export function mapMonteCarloIncidentToItem(
  raw: unknown,
  ctx: MonteCarloMappingContext,
): MonteCarloMappedRow | null {
  const r = asRecord(raw);
  if (r === undefined) return null;

  const incidentId = stringField(r, "incidentId");
  if (incidentId === undefined || incidentId === "") return null;

  const monitoredTable = stringField(r, "monitoredTable") ?? null;
  const status = stringField(r, "status") ?? null;
  const severity = stringField(r, "severity") ?? null;
  const firstSeenAt = stringField(r, "firstSeenAt") ?? null;

  const normalizedKey = monitoredTable !== null ? normalizeDataModelKey(monitoredTable) : null;
  const monitoredDataModelKeys: string[] = normalizedKey !== null ? [normalizedKey] : [];

  const statusSuffix = status !== null ? ` [${status}]` : "";
  const title = clampSyncTitle(`Monte Carlo incident ${incidentId}${statusSuffix}`);
  const bodyPreview = clampSyncTitle(
    `Incident ${incidentId}` +
      (severity !== null ? ` · severity=${severity}` : "") +
      (monitoredTable !== null ? ` · table=${monitoredTable}` : ""),
  );

  const parsedAt = firstSeenAt !== null ? Date.parse(firstSeenAt) : Number.NaN;
  const modifiedAt = Number.isNaN(parsedAt) ? ctx.syncedAt : parsedAt;

  return {
    service: "montecarlo",
    type: "data_quality_test",
    externalId: `montecarlo:${incidentId}`,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata: {
      monitoredDataModelKeys,
      status,
      severity,
      firstSeenAt,
    },
    syncedAt: ctx.syncedAt,
  };
}
