import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface RampMappingContext {
  readonly syncedAt: number;
}

export type RampMappedRow = MappedRow<"ramp", "transaction">;

const MEMO_MAX = 500;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

export function cardHolderName(raw: unknown): string | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const first = stringField(row, "first_name") ?? "";
  const last = stringField(row, "last_name") ?? "";
  const combined = [first, last].filter((p) => p !== "").join(" ");
  return combined === "" ? null : combined;
}

function cardHolderDepartment(raw: unknown): string | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const dept = stringField(row, "department_name");
  return dept !== undefined && dept !== "" ? dept : null;
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) {
    return "";
  }
  const fixed = amount.toFixed(2);
  return currency !== null && currency !== "" ? `${fixed} ${currency}` : fixed;
}

function deriveTitle(
  merchant: string | null,
  amount: number | null,
  currency: string | null,
): string {
  const money = formatAmount(amount, currency);
  if (merchant !== null && merchant !== "") {
    return money === "" ? merchant : `${merchant} — ${money}`;
  }
  return money === "" ? "Ramp transaction" : `Ramp transaction — ${money}`;
}

export function mapRampTransactionToItem(
  raw: unknown,
  ctx: RampMappingContext,
): RampMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const amount = numberField(row, "amount") ?? null;
  const currency = stringField(row, "currency_code") ?? null;
  const merchant = stringField(row, "merchant_name") ?? null;
  const state = stringField(row, "state") ?? null;
  const category = stringField(row, "sk_category_name") ?? null;
  const rawMemo = stringField(row, "memo") ?? null;
  const userTxnTime = parseIsoMs(row["user_transaction_time"]);

  const holderName = cardHolderName(row["card_holder"]);
  const department = cardHolderDepartment(row["card_holder"]);

  const memo =
    rawMemo !== null && rawMemo.length > MEMO_MAX ? `${rawMemo.slice(0, MEMO_MAX)}…` : rawMemo;

  const title = deriveTitle(merchant, amount, currency);

  const merchantOrTitle = merchant !== null && merchant !== "" ? merchant : title;
  const bodyPreview = memo !== null && memo !== "" ? memo : merchantOrTitle;

  const modifiedAt = userTxnTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    id,
    amount,
    currency_code: currency,
    merchant_name: merchant,
    card_holder_name: holderName,
    department,
    state,
    category,
    user_transaction_time: userTxnTime,
    memo,
  };

  return {
    service: "ramp",
    type: "transaction",
    externalId: id,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
