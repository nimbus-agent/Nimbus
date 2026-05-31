import { describe, expect, test } from "bun:test";

import {
  cardHolderName,
  mapRampTransactionToItem,
} from "../../../src/connectors/ramp-transaction-mapping.ts";

const TXN_ISO = "2024-03-02T08:00:00Z";
const TXN_MS = Date.parse(TXN_ISO);

function makeTxn(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { card_holder: holderOver, ...rootOver } = over;
  return {
    id: "txn_abc123",
    amount: 4212.55,
    currency_code: "USD",
    merchant_name: "Amazon Web Services",
    state: "CLEARED",
    sk_category_name: "Cloud Computing",
    memo: "Monthly AWS production bill",
    user_transaction_time: TXN_ISO,
    ...rootOver,
    card_holder: {
      first_name: "Ada",
      last_name: "Lovelace",
      department_name: "Engineering",
      ...((holderOver as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapRampTransactionToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapRampTransactionToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapRampTransactionToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapRampTransactionToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing/empty", () => {
    const noId = makeTxn();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapRampTransactionToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapRampTransactionToItem(makeTxn({ id: "" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the transaction id", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("ramp");
    expect(row.type).toBe("transaction");
    expect(row.externalId).toBe("txn_abc123");
  });

  test("title is `<merchant> — <amount> <currency>`", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Amazon Web Services — 4212.55 USD");
  });

  test("title falls back to `Ramp transaction — <amount>` when merchant missing", () => {
    const noMerchant = makeTxn();
    delete (noMerchant as Record<string, unknown>)["merchant_name"];
    const row = mapRampTransactionToItem(noMerchant, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Ramp transaction — 4212.55 USD");
  });

  test("title is bare `Ramp transaction` when amount + merchant both missing", () => {
    const bare = makeTxn();
    delete (bare as Record<string, unknown>)["merchant_name"];
    delete (bare as Record<string, unknown>)["amount"];
    const row = mapRampTransactionToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Ramp transaction");
  });

  test("bodyPreview is the (truncated) memo when present", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Monthly AWS production bill");
  });

  test("memo is truncated to 500 chars + ellipsis in metadata + bodyPreview", () => {
    const long = "a".repeat(800);
    const row = mapRampTransactionToItem(makeTxn({ memo: long }), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["memo"]).toBe(`${"a".repeat(500)}…`);
    expect(row.bodyPreview).toBe(`${"a".repeat(500)}…`);
  });

  test("bodyPreview falls back to merchant then title when memo missing", () => {
    const noMemo = makeTxn();
    delete (noMemo as Record<string, unknown>)["memo"];
    const row = mapRampTransactionToItem(noMemo, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Amazon Web Services");

    const noMemoNoMerchant = makeTxn();
    delete (noMemoNoMerchant as Record<string, unknown>)["memo"];
    delete (noMemoNoMerchant as Record<string, unknown>)["merchant_name"];
    const row2 = mapRampTransactionToItem(noMemoNoMerchant, { syncedAt: NOW });
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(row2.bodyPreview).toBe(row2.title);
  });

  test("ISO-8601 user_transaction_time → epoch ms in metadata; null when missing", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["user_transaction_time"]).toBe(TXN_MS);

    const noTime = makeTxn();
    delete (noTime as Record<string, unknown>)["user_transaction_time"];
    const row2 = mapRampTransactionToItem(noTime, { syncedAt: NOW });
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["user_transaction_time"]).toBeNull();
  });

  test("modifiedAt prefers user_transaction_time, then syncedAt", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(TXN_MS);

    const noTime = makeTxn();
    delete (noTime as Record<string, unknown>)["user_transaction_time"];
    const fallback = mapRampTransactionToItem(noTime, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
  });

  test("url + canonicalUrl are always null (Ramp API surfaces no permalink)", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
  });

  test("card holder name + department flow into metadata", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["card_holder_name"]).toBe("Ada Lovelace");
    expect(meta(row)["department"]).toBe("Engineering");
  });

  test("full metadata flows through", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["id"]).toBe("txn_abc123");
    expect(m["amount"]).toBe(4212.55);
    expect(m["currency_code"]).toBe("USD");
    expect(m["merchant_name"]).toBe("Amazon Web Services");
    expect(m["state"]).toBe("CLEARED");
    expect(m["category"]).toBe("Cloud Computing");
  });

  test("missing optional fields are null-passthrough in metadata", () => {
    const sparse = makeTxn();
    delete (sparse as Record<string, unknown>)["amount"];
    delete (sparse as Record<string, unknown>)["currency_code"];
    delete (sparse as Record<string, unknown>)["merchant_name"];
    delete (sparse as Record<string, unknown>)["state"];
    delete (sparse as Record<string, unknown>)["sk_category_name"];
    delete (sparse as Record<string, unknown>)["memo"];
    delete (sparse as Record<string, unknown>)["card_holder"];
    const row = mapRampTransactionToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["amount"]).toBeNull();
    expect(m["currency_code"]).toBeNull();
    expect(m["merchant_name"]).toBeNull();
    expect(m["state"]).toBeNull();
    expect(m["category"]).toBeNull();
    expect(m["memo"]).toBeNull();
    expect(m["card_holder_name"]).toBeNull();
    expect(m["department"]).toBeNull();
  });

  test("syncedAt propagates", () => {
    const row = mapRampTransactionToItem(makeTxn(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("cardHolderName", () => {
  test("combines first + last name", () => {
    expect(cardHolderName({ first_name: "Ada", last_name: "Lovelace" })).toBe("Ada Lovelace");
  });

  test("tolerates a single name part", () => {
    expect(cardHolderName({ last_name: "Knuth" })).toBe("Knuth");
    expect(cardHolderName({ first_name: "Grace" })).toBe("Grace");
  });

  test("returns null for non-object, empty, or nameless holders", () => {
    expect(cardHolderName(undefined)).toBeNull();
    expect(cardHolderName("nope")).toBeNull();
    expect(cardHolderName({})).toBeNull();
    expect(cardHolderName({ first_name: "", last_name: "" })).toBeNull();
  });
});
