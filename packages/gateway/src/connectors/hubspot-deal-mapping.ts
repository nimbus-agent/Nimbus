import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface HubspotMappingContext {
  readonly syncedAt: number;
}

export type HubspotMappedRow = MappedRow<"hubspot", "deal">;

/**
 * HubSpot date properties (`closedate`, `createdate`, `hs_lastmodifieddate`) and
 * the envelope `createdAt`/`updatedAt` can arrive as either an ISO-8601 string
 * or a string/number of epoch-milliseconds. Parse both shapes; return null when
 * unrecognizable.
 */
function parseHubspotMs(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v !== "string" || v === "") {
    return null;
  }
  // All-digit strings are epoch-ms (HubSpot's native property encoding).
  if (/^\d+$/.test(v)) {
    const ms = Number.parseInt(v, 10);
    return Number.isFinite(ms) ? ms : null;
  }
  const iso = Date.parse(v);
  return Number.isFinite(iso) ? iso : null;
}

function deriveTitle(dealName: string | null, id: string): string {
  return dealName !== null && dealName !== "" ? dealName : `HubSpot deal ${id}`;
}

export function mapHubspotDealToItem(
  raw: unknown,
  ctx: HubspotMappingContext,
): HubspotMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const props = asRecord(row["properties"]) ?? {};
  const dealName = stringField(props, "dealname") ?? null;
  const amount = stringField(props, "amount") ?? null;
  const dealStage = stringField(props, "dealstage") ?? null;
  const pipeline = stringField(props, "pipeline") ?? null;
  const closeDate = parseHubspotMs(props["closedate"]);
  const createDate = parseHubspotMs(props["createdate"]);
  const lastModified = parseHubspotMs(props["hs_lastmodifieddate"]);

  const envelopeUpdated = parseHubspotMs(row["updatedAt"]);
  const modifiedAt = lastModified ?? envelopeUpdated ?? ctx.syncedAt;

  const title = deriveTitle(dealName, id);
  const bodyPreview = dealStage !== null && dealStage !== "" ? `${title} — ${dealStage}` : title;

  const metadata: Record<string, unknown> = {
    id,
    dealname: dealName,
    amount,
    dealstage: dealStage,
    pipeline,
    closedate: closeDate,
    createdate: createDate,
    hs_lastmodifieddate: lastModified,
  };

  return {
    service: "hubspot",
    type: "deal",
    externalId: id,
    title,
    bodyPreview,
    // HubSpot deal URLs require a portal id the API does not return generically.
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
