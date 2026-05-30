import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface MercuryMappingContext {
  readonly syncedAt: number;
}

export interface MercuryMappedRow {
  readonly service: "mercury";
  readonly type: "account";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

export function last4(accountNumber: string | null): string | null {
  if (accountNumber === null || accountNumber === "") {
    return null;
  }
  return accountNumber.slice(-4);
}

export function mapMercuryAccountToItem(
  raw: unknown,
  ctx: MercuryMappingContext,
): MercuryMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const name = stringField(row, "name") ?? null;
  const status = stringField(row, "status") ?? null;
  const type = stringField(row, "type") ?? null;
  const kind = stringField(row, "kind") ?? null;
  const accountNumber = stringField(row, "accountNumber") ?? null;
  const routingNumber = stringField(row, "routingNumber") ?? null;
  const availableBalance = numberField(row, "availableBalance") ?? null;
  const currentBalance = numberField(row, "currentBalance") ?? null;
  const legalBusinessName = stringField(row, "legalBusinessName") ?? null;

  const createdAt = parseIsoMs(row["createdAt"]);

  const canonicalUrl: string | null = null;

  const title = name !== null && name !== "" ? name : `Account ${id}`;

  const label = kind ?? type ?? "";
  let bodyPreview: string;
  if (currentBalance !== null) {
    bodyPreview = label === "" ? `${currentBalance} USD` : `${label} — ${currentBalance} USD`;
  } else {
    bodyPreview = label !== "" ? label : title;
  }

  const modifiedAt = createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    account_id: id,
    name,
    status,
    type,
    kind,
    account_number_last4: last4(accountNumber),
    routing_number: routingNumber,
    available_balance: availableBalance,
    current_balance: currentBalance,
    legal_business_name: legalBusinessName,
    created_at: createdAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "mercury",
    type: "account",
    externalId: id,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
