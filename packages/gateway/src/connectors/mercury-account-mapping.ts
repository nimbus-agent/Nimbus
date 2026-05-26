/**
 * Pure mapping from a Mercury `GET /api/v1/accounts` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `mercury-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "mercury", type = "account"` rows — a single item type.
 * `external_id = <account id>` (verbatim). The conceptual item identity is
 * `mercury:account`; the `item.id` ends up `mercury:<accountId>`. The `account`
 * type is sparse/structured (id, name, status, balances), so it stays on local
 * MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 *
 * IMPORTANT: Mercury's `createdAt` is an ISO-8601 STRING (e.g.
 * `"2024-03-01T12:00:00.000Z"`), like Netlify's timestamps and UNLIKE the
 * epoch-ms / epoch-seconds number APIs. Parse it to epoch-ms with
 * {@link parseIsoMs} — never pass the ISO string through verbatim, and never
 * treat it as epoch seconds.
 *
 * SENSITIVE: the full `accountNumber` is NEVER stored. Only the last 4 digits
 * are surfaced as `account_number_last4` via {@link last4}. Balances
 * (`availableBalance`, `currentBalance`) are USD MAJOR units — Mercury returns
 * dollars as a number, NOT cents — and are passed through verbatim.
 *
 * Mercury accounts have no stable per-account public URL (same as the Flux "no
 * web UI" pattern), so `canonical_url` / `url` are always null.
 */

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

/**
 * Last 4 characters of an account number, or null when absent. Mercury account
 * numbers are sensitive — only the last 4 digits are ever stored.
 */
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

  // Mercury accounts have no stable per-account public URL — canonical/url null.
  const canonicalUrl: string | null = null;

  // title: account `name`; fall back to `Account <id>`.
  const title = name !== null && name !== "" ? name : `Account ${id}`;

  // bodyPreview: `<kind||type> — <currentBalance> USD` when a balance is
  // present, else just the kind/type label, else the title.
  const label = kind ?? type ?? "";
  const bodyPreview =
    currentBalance !== null
      ? label === ""
        ? `${currentBalance} USD`
        : `${label} — ${currentBalance} USD`
      : label !== ""
        ? label
        : title;

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
