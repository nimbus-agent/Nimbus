import { describe, expect, test } from "bun:test";

import { last4, mapMercuryAccountToItem } from "../../../src/connectors/mercury-account-mapping.ts";

const CREATED_ISO = "2024-03-01T12:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_ISO);

function makeAccount(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acct_1A2b3C",
    name: "Mercury Checking",
    status: "active",
    type: "mercury",
    kind: "checking",
    accountNumber: "9876543210",
    routingNumber: "021000021",
    availableBalance: 12345.67,
    currentBalance: 12300.0,
    legalBusinessName: "ACME Corp",
    createdAt: CREATED_ISO,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapMercuryAccountToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapMercuryAccountToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapMercuryAccountToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapMercuryAccountToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    const noId = makeAccount();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapMercuryAccountToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapMercuryAccountToItem(makeAccount({ id: "" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the verbatim account id", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("mercury");
    expect(row.type).toBe("account");
    expect(row.externalId).toBe("acct_1A2b3C");
  });

  test("title is the account name", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Mercury Checking");
  });

  test("title falls back to `Account <id>` when name missing", () => {
    const noName = makeAccount();
    delete (noName as Record<string, unknown>)["name"];
    const row = mapMercuryAccountToItem(noName, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Account acct_1A2b3C");
  });

  test("bodyPreview is `<kind> — <currentBalance> USD`", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("checking — 12300 USD");
  });

  test("bodyPreview falls back to type when kind missing", () => {
    const noKind = makeAccount();
    delete (noKind as Record<string, unknown>)["kind"];
    const row = mapMercuryAccountToItem(noKind, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("mercury — 12300 USD");
  });

  test("bodyPreview is balance-only when both kind and type missing", () => {
    const bare = makeAccount();
    delete (bare as Record<string, unknown>)["kind"];
    delete (bare as Record<string, unknown>)["type"];
    const row = mapMercuryAccountToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("12300 USD");
  });

  test("bodyPreview is the kind label when no balance present", () => {
    const noBalance = makeAccount();
    delete (noBalance as Record<string, unknown>)["currentBalance"];
    const row = mapMercuryAccountToItem(noBalance, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("checking");
  });

  test("bodyPreview falls back to the title when neither balance nor label present", () => {
    const bare = makeAccount();
    delete (bare as Record<string, unknown>)["currentBalance"];
    delete (bare as Record<string, unknown>)["kind"];
    delete (bare as Record<string, unknown>)["type"];
    const row = mapMercuryAccountToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Mercury Checking");
  });

  test("ISO-8601 createdAt → epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["created_at"]).toBe(Date.parse(CREATED_ISO));
  });

  test("modifiedAt is created (ms); falls back to syncedAt when createdAt missing", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(CREATED_MS);

    const noCreated = makeAccount();
    delete (noCreated as Record<string, unknown>)["createdAt"];
    const fallback = mapMercuryAccountToItem(noCreated, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
  });

  test("canonicalUrl and url are always null (no per-account public URL)", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
    expect(row.url).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();
  });

  test("account number is reduced to the last 4 digits; the full number is never stored", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["account_number_last4"]).toBe("3210");
    expect(JSON.stringify(row)).not.toContain("9876543210");
  });

  test("missing account number → account_number_last4 is null", () => {
    const noNum = makeAccount();
    delete (noNum as Record<string, unknown>)["accountNumber"];
    const row = mapMercuryAccountToItem(noNum, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["account_number_last4"]).toBeNull();
  });

  test("balances are USD major units passed through verbatim", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["available_balance"]).toBe(12345.67);
    expect(meta(row)["current_balance"]).toBe(12300.0);
  });

  test("missing balances are null-passthrough in metadata", () => {
    const sparse = makeAccount();
    delete (sparse as Record<string, unknown>)["availableBalance"];
    delete (sparse as Record<string, unknown>)["currentBalance"];
    const row = mapMercuryAccountToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["available_balance"]).toBeNull();
    expect(meta(row)["current_balance"]).toBeNull();
  });

  test("full metadata flows through", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["account_id"]).toBe("acct_1A2b3C");
    expect(m["name"]).toBe("Mercury Checking");
    expect(m["status"]).toBe("active");
    expect(m["type"]).toBe("mercury");
    expect(m["kind"]).toBe("checking");
    expect(m["routing_number"]).toBe("021000021");
    expect(m["legal_business_name"]).toBe("ACME Corp");
  });

  test("missing string fields are null-passthrough in metadata", () => {
    const sparse = makeAccount();
    delete (sparse as Record<string, unknown>)["status"];
    delete (sparse as Record<string, unknown>)["routingNumber"];
    delete (sparse as Record<string, unknown>)["legalBusinessName"];
    const row = mapMercuryAccountToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["status"]).toBeNull();
    expect(meta(row)["routing_number"]).toBeNull();
    expect(meta(row)["legal_business_name"]).toBeNull();
  });

  test("syncedAt propagates", () => {
    const row = mapMercuryAccountToItem(makeAccount(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("last4", () => {
  test("returns the last 4 characters", () => {
    expect(last4("9876543210")).toBe("3210");
    expect(last4("1234")).toBe("1234");
    expect(last4("12")).toBe("12");
  });

  test("returns null for null / empty", () => {
    expect(last4(null)).toBeNull();
    expect(last4("")).toBeNull();
  });
});
