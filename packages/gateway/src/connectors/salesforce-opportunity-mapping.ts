import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface SalesforceMappingContext {
  readonly syncedAt: number;
}

export type SalesforceMappedRow = MappedRow<"salesforce", "opportunity">;

/**
 * Salesforce timestamps (`LastModifiedDate`, `CreatedDate`) are ISO-8601
 * strings (e.g. `2026-05-20T12:00:00.000+0000`). Parse to epoch-milliseconds;
 * return null when unrecognizable.
 */
function parseIsoMs(v: unknown): number | null {
  if (typeof v !== "string" || v === "") {
    return null;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function boolField(row: Record<string, unknown>, key: string): boolean | null {
  const v = row[key];
  return typeof v === "boolean" ? v : null;
}

function deriveTitle(name: string | null, id: string): string {
  return name !== null && name !== "" ? name : `Salesforce opportunity ${id}`;
}

export function mapSalesforceOpportunityToItem(
  raw: unknown,
  ctx: SalesforceMappingContext,
): SalesforceMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "Id");
  if (id === undefined || id === "") {
    return null;
  }

  const name = stringField(row, "Name") ?? null;
  const stage = stringField(row, "StageName") ?? null;
  const amount = numberField(row, "Amount") ?? null;
  const closeDate = stringField(row, "CloseDate") ?? null;
  const probability = numberField(row, "Probability") ?? null;
  const type = stringField(row, "Type") ?? null;
  const isClosed = boolField(row, "IsClosed");
  const isWon = boolField(row, "IsWon");
  const lastModified = parseIsoMs(row["LastModifiedDate"]);
  const created = parseIsoMs(row["CreatedDate"]);

  const modifiedAt = lastModified ?? ctx.syncedAt;

  const title = deriveTitle(name, id);
  const bodyPreview = stage !== null && stage !== "" ? `${title} — ${stage}` : title;

  const metadata: Record<string, unknown> = {
    id,
    name,
    stage,
    amount,
    closeDate,
    probability,
    type,
    isClosed,
    isWon,
    lastModifiedDate: lastModified,
    createdDate: created,
  };

  return {
    service: "salesforce",
    type: "opportunity",
    externalId: id,
    title,
    bodyPreview,
    // The mapper is pure and side-effect-free; the Lightning record URL requires
    // the per-tenant instance host, which the mapper does not take. Keep url null
    // (mirrors hubspot/prefect) rather than threading instanceUrl through.
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
