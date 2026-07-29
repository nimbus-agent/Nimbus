import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface MercuryTransactionMappingContext {
  readonly syncedAt: number;
  /**
   * The Mercury account the page was fetched under
   * (`GET /api/v1/account/{accountId}/transactions`). Used only as the fallback
   * for a row that omits its own `accountId`.
   */
  readonly accountId: string;
}

export type MercuryTransactionMappedRow = MappedRow<"mercury", "transaction">;

/** Ramp's `MEMO_MAX`: user-authored memo text is clipped before it is indexed. */
const MEMO_MAX = 500;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function nonEmptyString(row: Record<string, unknown>, key: string): string | null {
  const v = stringField(row, key);
  return v !== undefined && v !== "" ? v : null;
}

function clipMemo(v: string | null): string | null {
  if (v === null) {
    return null;
  }
  return v.length > MEMO_MAX ? `${v.slice(0, MEMO_MAX)}…` : v;
}

/**
 * Mercury accounts are USD-denominated and the transaction payload carries no
 * currency field of its own (`currencyExchangeInfo`, which only appears on
 * international wires, is deliberately not indexed). The "USD" suffix therefore
 * mirrors `mapMercuryAccountToItem`, which formats balances the same way.
 */
function formatAmount(amount: number | null): string {
  return amount === null ? "" : `${amount.toFixed(2)} USD`;
}

function deriveTitle(label: string | null, amount: number | null): string {
  const money = formatAmount(amount);
  if (label !== null) {
    return money === "" ? label : `${label} — ${money}`;
  }
  return money === "" ? "Mercury transaction" : `Mercury transaction — ${money}`;
}

/**
 * Map one Mercury transaction (`GET /api/v1/account/{id}/transactions`, the
 * `{ total, transactions: [...] }` envelope) to a `mercury:transaction` item.
 *
 * **What is deliberately NOT indexed.** Mercury returns far more per
 * transaction than belongs in a local search index, and this is a finance
 * connector, so the omissions are load-bearing rather than incidental:
 *
 * - `details` — the whole object. It carries the COUNTERPARTY's payment
 *   credentials: `electronicRoutingInfo` / `domesticWireRoutingInfo` /
 *   `internationalWireRoutingInfo` (account + routing numbers), `address`
 *   (a postal address), and `debitCardInfo` / `creditCardInfo` (card digits).
 *   `mapMercuryAccountToItem` already refuses to store the owner's own full
 *   account number; a counterparty's is no less sensitive.
 * - `attachments` — receipt file names and download links.
 * - `glAllocations`, `relatedTransactions`, `merchant`, `categoryData`,
 *   `currencyExchangeInfo` — nested accounting/FX structures with no search
 *   value at this depth.
 * - `checkNumber`, `trackingNumber`, `feeId`, `requestId`,
 *   `creditAccountPeriodId`, `counterpartyId`, `counterpartyNickname`,
 *   `failedAt`, `reasonForFailure`, `compliantWithReceiptPolicy`,
 *   `hasGeneratedReceipt` — out of scope for v1 (`status` already carries the
 *   failure signal).
 *
 * A row without a stable vendor `id` is skipped: `external_id` must be the
 * vendor's own id so upserts converge across syncs.
 */
export function mapMercuryTransactionToItem(
  raw: unknown,
  ctx: MercuryTransactionMappingContext,
): MercuryTransactionMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const accountId = nonEmptyString(row, "accountId") ?? ctx.accountId;
  const amount = numberField(row, "amount") ?? null;
  const status = nonEmptyString(row, "status");
  const kind = nonEmptyString(row, "kind");
  const counterpartyName = nonEmptyString(row, "counterpartyName");
  const bankDescription = nonEmptyString(row, "bankDescription");
  const mercuryCategory = nonEmptyString(row, "mercuryCategory");
  const note = clipMemo(nonEmptyString(row, "note"));
  const externalMemo = clipMemo(nonEmptyString(row, "externalMemo"));

  const createdAt = parseIsoMs(row["createdAt"]);
  const postedAt = parseIsoMs(row["postedAt"]);

  // Mercury DOES surface a per-transaction permalink, unlike the account
  // payload (whose canonical_url stays null).
  const canonicalUrl = nonEmptyString(row, "dashboardLink");

  const label = counterpartyName ?? bankDescription;
  const title = deriveTitle(label, amount);
  const bodyPreview = note ?? externalMemo ?? label ?? title;

  const modifiedAt = postedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    transaction_id: id,
    account_id: accountId,
    amount,
    status,
    kind,
    counterparty_name: counterpartyName,
    bank_description: bankDescription,
    mercury_category: mercuryCategory,
    note,
    external_memo: externalMemo,
    created_at: createdAt,
    posted_at: postedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "mercury",
    type: "transaction",
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
