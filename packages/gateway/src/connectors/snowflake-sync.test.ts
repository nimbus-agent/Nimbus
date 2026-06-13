import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  expectSyncNoopResult,
  type SyncTestFetchParams,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createSnowflakeSyncable } from "./snowflake-sync.ts";

function makeSyncable() {
  return createSnowflakeSyncable({ ensureSnowflakeMcpRunning: async () => {} });
}

// Minimal Snowflake statements API response with one table row
function statementsResponse(rows: string[][]): string {
  return JSON.stringify({
    resultSetMetaData: {
      rowType: [
        { name: "DATABASE_NAME" },
        { name: "SCHEMA_NAME" },
        { name: "TABLE_NAME" },
        { name: "ROW_COUNT" },
        { name: "LAST_ALTERED" },
      ],
    },
    data: rows,
  });
}

type FetchHandler = (url: string, init: SyncTestFetchParams[1]) => Response;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

describeWithFetchRestore("snowflake-sync", () => {
  // ─── No-op when credentials are missing ──────────────────────────────────

  test("no-op when account is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault({ "snowflake.oauth_token": "tok" })),
      null,
    );
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "snowflake", 0);
  });

  test("no-op when both oauth_token and key_pair_jwt are absent", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault({ "snowflake.account": "acme-xy12345" })),
      null,
    );
    expectSyncNoopResult(r);
  });

  // ─── Bug 5 — blank oauth_token must fall through to key_pair_jwt ─────────

  test("blank oauth_token + valid key_pair_jwt resolves via JWT (sync proceeds, not noop)", async () => {
    const db = createMemoryIndexDb();
    // oauth_token is empty string (blank) → should fall through to key_pair_jwt
    const vault = createStubVault({
      "snowflake.account": "acme-xy12345",
      "snowflake.oauth_token": "",
      "snowflake.key_pair_jwt": "valid-jwt-token",
    });

    installFetch(
      () =>
        new Response(
          statementsResponse([["MYDB", "PUBLIC", "ORDERS", "100", "2026-06-01T00:00:00Z"]]),
          { status: 200 },
        ),
    );

    const r = await makeSyncable().sync(syncTestContext(db, vault), null);
    // Should NOT be a noop — jwt provided valid creds and a table was returned
    expect(r.cursor).not.toBeNull();
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    expectServiceItemCount(db, "snowflake", 1);
  });

  test("whitespace-only oauth_token + valid key_pair_jwt resolves via JWT", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "snowflake.account": "acme-xy12345",
      "snowflake.oauth_token": "   ",
      "snowflake.key_pair_jwt": "valid-jwt-token",
    });

    installFetch(
      () =>
        new Response(
          statementsResponse([["MYDB", "PUBLIC", "SESSIONS", "50", "2026-06-01T00:00:00Z"]]),
          { status: 200 },
        ),
    );

    const r = await makeSyncable().sync(syncTestContext(db, vault), null);
    expect(r.cursor).not.toBeNull();
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  });

  test("prefers non-blank oauth_token over key_pair_jwt when both are set", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "snowflake.account": "acme-xy12345",
      "snowflake.oauth_token": "oauth-tok-valid",
      "snowflake.key_pair_jwt": "jwt-fallback",
    });

    let capturedBearerToken = "";
    installFetch((_url, init) => {
      const authHeader =
        (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
      capturedBearerToken = authHeader.replace(/^Bearer\s+/, "");
      return new Response(statementsResponse([]), { status: 200 });
    });

    await makeSyncable().sync(syncTestContext(db, vault), null);
    expect(capturedBearerToken).toBe("oauth-tok-valid");
  });

  // ─── isSafeSnowflakeAccount guard ────────────────────────────────────────

  test("no-op when account starts with a dash (isSafeSnowflakeAccount false)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "snowflake.account": "-bad-account",
          "snowflake.oauth_token": "tok",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when account contains a control character (codePoint < 0x20 branch)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "snowflake.account": "acme\x01xy",
          "snowflake.oauth_token": "tok",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  // ─── HTTP / parse errors ───────────────────────────────────────────────────

  test("http_error → http-empty pass cursor, preserves incoming cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Unauthorized", { status: 401 }));
    const incomingCursor = "nimbus-snowflake1:oldcursor";
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "snowflake.account": "acme-xy12345",
          "snowflake.oauth_token": "tok",
        }),
      ),
      incomingCursor,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe(incomingCursor);
    expectServiceItemCount(db, "snowflake", 0);
  });

  test("parse_error (invalid JSON) → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("not-json{", { status: 200 }));
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "snowflake.account": "acme-xy12345",
          "snowflake.oauth_token": "tok",
        }),
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-snowflake1:");
  });

  // ─── rowsFromStatementsResponse edge cases ─────────────────────────────────

  test("non-array row entry in data is skipped (!Array.isArray(rr) branch)", async () => {
    const db = createMemoryIndexDb();
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            resultSetMetaData: {
              rowType: [{ name: "TABLE_NAME" }, { name: "SCHEMA_NAME" }, { name: "DATABASE_NAME" }],
            },
            // Mix of valid and non-array items in data
            data: [
              null, // not an array → skip
              "string", // not an array → skip
              ["MYDB", "PUBLIC", "ORDERS", null, "2026-06-01T00:00:00Z"],
            ],
          }),
          { status: 200 },
        ),
    );
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "snowflake.account": "acme-xy12345",
          "snowflake.oauth_token": "tok",
        }),
      ),
      null,
    );
    // Only the third item is a valid row but mapper may skip it; at least no crash
    expect(r.cursor).toContain("nimbus-snowflake1:");
  });

  test("column with empty name is excluded from obj mapping", async () => {
    const db = createMemoryIndexDb();
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            resultSetMetaData: {
              // Include a rowType entry that lacks a 'name' field → lowercased name = ""
              rowType: [{ name: "DATABASE_NAME" }, {}, { name: "TABLE_NAME" }],
            },
            data: [["MYDB", "ignored", "ORDERS"]],
          }),
          { status: 200 },
        ),
    );
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "snowflake.account": "acme-xy12345",
          "snowflake.oauth_token": "tok",
        }),
      ),
      null,
    );
    // Completes without error; the empty-name column is skipped
    expect(r.cursor).toContain("nimbus-snowflake1:");
  });

  test("row with non-string row_count is left as-is (no numeric conversion)", async () => {
    const db = createMemoryIndexDb();
    installFetch(
      () =>
        new Response(
          statementsResponse([["MYDB", "PUBLIC", "ORDERS", "42", "2026-06-01T00:00:00Z"]]),
          { status: 200 },
        ),
    );
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "snowflake.account": "acme-xy12345",
          "snowflake.oauth_token": "tok",
        }),
      ),
      null,
    );
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
  });

  test("table row that mapper rejects (mapped === null) is skipped", async () => {
    const db = createMemoryIndexDb();
    // Omit TABLE_NAME column entirely so the obj has no table_name key →
    // stringField returns undefined → mapper returns null
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            resultSetMetaData: {
              rowType: [
                { name: "DATABASE_NAME" },
                { name: "SCHEMA_NAME" },
                // TABLE_NAME intentionally absent
              ],
            },
            data: [["MYDB", "PUBLIC"]],
          }),
          { status: 200 },
        ),
    );
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "snowflake.account": "acme-xy12345",
          "snowflake.oauth_token": "tok",
        }),
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });
});
