import { describe, expect, test } from "bun:test";

import { mapMercuryTransactionToItem } from "../../../src/connectors/mercury-transaction-mapping.ts";

const CREATED_ISO = "2024-03-01T12:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_ISO);
const POSTED_ISO = "2024-03-02T08:00:00.000Z";
const POSTED_MS = Date.parse(POSTED_ISO);

const ACCOUNT_ID = "acct_1A2b3C";
const NOW = 1_700_009_999_999;
const CTX = { syncedAt: NOW, accountId: ACCOUNT_ID } as const;

/**
 * A Mercury transaction as returned by `GET /api/v1/account/{id}/transactions`.
 * `details` / `attachments` are populated on purpose: the mapper must NEVER
 * carry counterparty bank credentials, card digits or receipt links into the
 * local index.
 */
function makeTxn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_9f8e7d",
    accountId: ACCOUNT_ID,
    amount: -4212.55,
    status: "sent",
    kind: "externalTransfer",
    counterpartyId: "cp_00112233",
    counterpartyName: "Amazon Web Services",
    counterpartyNickname: "AWS",
    bankDescription: "AWS EMEA SARL",
    mercuryCategory: "Software",
    note: "Monthly AWS production bill",
    externalMemo: "invoice 4471",
    createdAt: CREATED_ISO,
    postedAt: POSTED_ISO,
    dashboardLink: "https://mercury.com/transactions/txn_9f8e7d",
    details: {
      electronicRoutingInfo: {
        accountNumber: "9876543210",
        routingNumber: "021000021",
        bankName: "Big Bank NA",
      },
      address: {
        address1: "1 Infinite Loop",
        city: "Cupertino",
        region: "CA",
        postalCode: "95014",
      },
      debitCardInfo: { lastFourDigits: "4242" },
    },
    attachments: [
      { fileName: "receipt-secret.pdf", url: "https://files.mercury.com/receipt-secret.pdf" },
    ],
    ...over,
  };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapMercuryTransactionToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapMercuryTransactionToItem(null, CTX)).toBeNull();
    expect(mapMercuryTransactionToItem("nope", CTX)).toBeNull();
    expect(mapMercuryTransactionToItem(42, CTX)).toBeNull();
    expect(mapMercuryTransactionToItem([], CTX)).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    const noId = makeTxn();
    delete noId["id"];
    expect(mapMercuryTransactionToItem(noId, CTX)).toBeNull();
    expect(mapMercuryTransactionToItem(makeTxn({ id: "" }), CTX)).toBeNull();
  });

  test("service/type fixed; externalId is the verbatim transaction id", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("mercury");
    expect(row.type).toBe("transaction");
    expect(row.externalId).toBe("txn_9f8e7d");
  });

  test("title is `<counterparty> — <amount> USD`", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Amazon Web Services — -4212.55 USD");
  });

  test("title falls back to bankDescription when counterpartyName is absent", () => {
    const noCounterparty = makeTxn();
    delete noCounterparty["counterpartyName"];
    const row = mapMercuryTransactionToItem(noCounterparty, CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("AWS EMEA SARL — -4212.55 USD");
  });

  test("title falls back to `Mercury transaction — <amount> USD` with no label", () => {
    const noLabel = makeTxn();
    delete noLabel["counterpartyName"];
    delete noLabel["bankDescription"];
    const row = mapMercuryTransactionToItem(noLabel, CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Mercury transaction — -4212.55 USD");
  });

  test("title is bare `Mercury transaction` when label and amount are both absent", () => {
    const bare = makeTxn();
    delete bare["counterpartyName"];
    delete bare["bankDescription"];
    delete bare["amount"];
    const row = mapMercuryTransactionToItem(bare, CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Mercury transaction");
  });

  test("title keeps the label alone when the amount is absent", () => {
    const noAmount = makeTxn();
    delete noAmount["amount"];
    const row = mapMercuryTransactionToItem(noAmount, CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Amazon Web Services");
  });

  test("amount is rendered with 2 decimals and the sign preserved", () => {
    const round = mapMercuryTransactionToItem(makeTxn({ amount: 100 }), CTX);
    if (round === null) throw new Error("expected mapping to succeed");
    expect(round.title).toBe("Amazon Web Services — 100.00 USD");
  });

  test("bodyPreview is the note, then externalMemo, then the label, then the title", () => {
    const withNote = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (withNote === null) throw new Error("expected mapping to succeed");
    expect(withNote.bodyPreview).toBe("Monthly AWS production bill");

    const noNote = makeTxn();
    delete noNote["note"];
    const memoRow = mapMercuryTransactionToItem(noNote, CTX);
    if (memoRow === null) throw new Error("expected mapping to succeed");
    expect(memoRow.bodyPreview).toBe("invoice 4471");

    const noMemos = makeTxn();
    delete noMemos["note"];
    delete noMemos["externalMemo"];
    const labelRow = mapMercuryTransactionToItem(noMemos, CTX);
    if (labelRow === null) throw new Error("expected mapping to succeed");
    expect(labelRow.bodyPreview).toBe("Amazon Web Services");

    const nothing = makeTxn();
    delete nothing["note"];
    delete nothing["externalMemo"];
    delete nothing["counterpartyName"];
    delete nothing["bankDescription"];
    const titleRow = mapMercuryTransactionToItem(nothing, CTX);
    if (titleRow === null) throw new Error("expected mapping to succeed");
    expect(titleRow.bodyPreview).toBe(titleRow.title);
  });

  test("note and externalMemo are truncated to 500 chars + ellipsis", () => {
    const long = "a".repeat(800);
    const row = mapMercuryTransactionToItem(makeTxn({ note: long, externalMemo: long }), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["note"]).toBe(`${"a".repeat(500)}…`);
    expect(meta(row)["external_memo"]).toBe(`${"a".repeat(500)}…`);
    expect(row.bodyPreview).toBe(`${"a".repeat(500)}…`);
  });

  test("ISO-8601 createdAt/postedAt → epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["posted_at"]).toBe(POSTED_MS);
  });

  test("modifiedAt prefers postedAt, then createdAt, then syncedAt", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(POSTED_MS);

    const noPosted = makeTxn();
    delete noPosted["postedAt"];
    const created = mapMercuryTransactionToItem(noPosted, CTX);
    if (created === null) throw new Error("expected mapping to succeed");
    expect(created.modifiedAt).toBe(CREATED_MS);
    expect(meta(created)["posted_at"]).toBeNull();

    const noTimes = makeTxn();
    delete noTimes["postedAt"];
    delete noTimes["createdAt"];
    const fallback = mapMercuryTransactionToItem(noTimes, CTX);
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
  });

  test("dashboardLink becomes url + canonicalUrl + metadata.canonical_url", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.url).toBe("https://mercury.com/transactions/txn_9f8e7d");
    expect(row.canonicalUrl).toBe("https://mercury.com/transactions/txn_9f8e7d");
    expect(meta(row)["canonical_url"]).toBe("https://mercury.com/transactions/txn_9f8e7d");
  });

  test("absent/empty dashboardLink leaves url + canonicalUrl null", () => {
    const noLink = makeTxn();
    delete noLink["dashboardLink"];
    const row = mapMercuryTransactionToItem(noLink, CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();

    const emptyLink = mapMercuryTransactionToItem(makeTxn({ dashboardLink: "" }), CTX);
    if (emptyLink === null) throw new Error("expected mapping to succeed");
    expect(emptyLink.url).toBeNull();
  });

  test("account_id prefers the row's accountId and falls back to the context account", () => {
    const row = mapMercuryTransactionToItem(makeTxn({ accountId: "acct_other" }), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["account_id"]).toBe("acct_other");

    const noAccount = makeTxn();
    delete noAccount["accountId"];
    const fallback = mapMercuryTransactionToItem(noAccount, CTX);
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(meta(fallback)["account_id"]).toBe(ACCOUNT_ID);
  });

  test("full metadata flows through", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["transaction_id"]).toBe("txn_9f8e7d");
    expect(m["account_id"]).toBe(ACCOUNT_ID);
    expect(m["amount"]).toBe(-4212.55);
    expect(m["status"]).toBe("sent");
    expect(m["kind"]).toBe("externalTransfer");
    expect(m["counterparty_name"]).toBe("Amazon Web Services");
    expect(m["bank_description"]).toBe("AWS EMEA SARL");
    expect(m["mercury_category"]).toBe("Software");
    expect(m["note"]).toBe("Monthly AWS production bill");
    expect(m["external_memo"]).toBe("invoice 4471");
  });

  test("missing optional fields are null-passthrough in metadata", () => {
    const sparse = makeTxn();
    for (const k of [
      "amount",
      "status",
      "kind",
      "counterpartyName",
      "bankDescription",
      "mercuryCategory",
      "note",
      "externalMemo",
    ]) {
      delete sparse[k];
    }
    const row = mapMercuryTransactionToItem(sparse, CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["amount"]).toBeNull();
    expect(m["status"]).toBeNull();
    expect(m["kind"]).toBeNull();
    expect(m["counterparty_name"]).toBeNull();
    expect(m["bank_description"]).toBeNull();
    expect(m["mercury_category"]).toBeNull();
    expect(m["note"]).toBeNull();
    expect(m["external_memo"]).toBeNull();
  });

  test("syncedAt propagates", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });

  // ---------------------------------------------------------------------------
  // The finance-connector guard. The account mapper already refuses to store a
  // full account number; the transaction mapper carries the same obligation for
  // the counterparty's payment credentials, which live under `details`.
  // ---------------------------------------------------------------------------
  test("counterparty payment credentials under `details` are NEVER indexed", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    const serialized = JSON.stringify(row);
    // Counterparty bank account + routing number.
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("021000021");
    expect(serialized).not.toContain("Big Bank NA");
    // Counterparty postal address.
    expect(serialized).not.toContain("1 Infinite Loop");
    expect(serialized).not.toContain("95014");
    // Card digits.
    expect(serialized).not.toContain("4242");
    // The `details` object itself never reaches metadata.
    expect(meta(row)["details"]).toBeUndefined();
  });

  test("receipt attachments are NEVER indexed", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("receipt-secret.pdf");
    expect(meta(row)["attachments"]).toBeUndefined();
  });

  test("metadata carries exactly the agreed key set — nothing wider", () => {
    const row = mapMercuryTransactionToItem(makeTxn(), CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    expect(Object.keys(meta(row)).sort()).toEqual([
      "account_id",
      "amount",
      "bank_description",
      "canonical_url",
      "counterparty_name",
      "created_at",
      "external_memo",
      "kind",
      "mercury_category",
      "note",
      "posted_at",
      "status",
      "transaction_id",
    ]);
  });
});
