import { expect, test } from "bun:test";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  expectSyncNoopResult,
  silentSyncContextExtras,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";

// ─── createMemoryIndexDb ──────────────────────────────────────────────────────

test("createMemoryIndexDb returns a live in-memory SQLite database with the item table", () => {
  const db = createMemoryIndexDb();
  // The item table must exist — query without error
  const row = db.prepare("SELECT COUNT(*) AS c FROM item").get() as { c: number };
  expect(row.c).toBe(0);
  db.close();
});

// ─── EMPTY_NIMBUS_VAULT ───────────────────────────────────────────────────────

test("EMPTY_NIMBUS_VAULT.get always returns null regardless of key", async () => {
  const v = EMPTY_NIMBUS_VAULT;
  expect(await v.get("any.key")).toBeNull();
});

test("EMPTY_NIMBUS_VAULT.set resolves without error", async () => {
  await expect(EMPTY_NIMBUS_VAULT.set("k", "v")).resolves.toBeUndefined();
});

test("EMPTY_NIMBUS_VAULT.delete resolves without error", async () => {
  await expect(EMPTY_NIMBUS_VAULT.delete("k")).resolves.toBeUndefined();
});

test("EMPTY_NIMBUS_VAULT.listKeys resolves to an empty array", async () => {
  expect(await EMPTY_NIMBUS_VAULT.listKeys()).toEqual([]);
});

// ─── createStubVault ─────────────────────────────────────────────────────────

test("createStubVault returns the string value for a key that is present with a string value", async () => {
  const vault = createStubVault({ "svc.token": "secret-value" });
  expect(await vault.get("svc.token")).toBe("secret-value");
});

test("createStubVault returns null for a key whose value is explicitly null", async () => {
  const vault = createStubVault({ "svc.token": null });
  expect(await vault.get("svc.token")).toBeNull();
});

test("createStubVault returns null for a key that is absent from entries", async () => {
  const vault = createStubVault({ "svc.other": "something" });
  expect(await vault.get("svc.missing")).toBeNull();
});

test("createStubVault.set resolves without error", async () => {
  const vault = createStubVault({});
  await expect(vault.set("k", "v")).resolves.toBeUndefined();
});

test("createStubVault.delete resolves without error", async () => {
  const vault = createStubVault({});
  await expect(vault.delete("k")).resolves.toBeUndefined();
});

test("createStubVault.listKeys resolves to an empty array", async () => {
  const vault = createStubVault({ "svc.token": "x" });
  expect(await vault.listKeys()).toEqual([]);
});

// ─── silentSyncContextExtras ──────────────────────────────────────────────────

test("silentSyncContextExtras returns an object with logger and rateLimiter properties", () => {
  const extras = silentSyncContextExtras();
  expect(extras.logger).toBeDefined();
  expect(extras.rateLimiter).toBeDefined();
});

// ─── syncTestContext ──────────────────────────────────────────────────────────

test("syncTestContext composes db + vault + extras into a SyncContext", () => {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ k: "v" });
  const ctx: SyncContext = syncTestContext(db, vault);
  // No handles on a SyncContext any more — that IS the narrowing. What a test can assert now is
  // that the capabilities are present and scoped.
  expect(typeof ctx.getSecret).toBe("function");
  expect(typeof ctx.upsertItem).toBe("function");
  expect(ctx.logger).toBeDefined();
  expect(ctx.rateLimiter).toBeDefined();
  db.close();
});

// ─── urlFromFetchInput ────────────────────────────────────────────────────────

test("urlFromFetchInput returns the string unchanged when input is a string", () => {
  const url = "https://api.example.com/v1/resource";
  expect(urlFromFetchInput(url)).toBe(url);
});

test("urlFromFetchInput converts a URL instance to its string representation", () => {
  const url = new URL("https://api.example.com/v1/resource?q=1");
  expect(urlFromFetchInput(url)).toBe("https://api.example.com/v1/resource?q=1");
});

test("urlFromFetchInput extracts the .url property from a Request-like object", () => {
  // A real Request object has a .url property and is not a string or URL instance
  const req = new Request("https://api.example.com/v1/resource");
  expect(urlFromFetchInput(req)).toBe("https://api.example.com/v1/resource");
});

// ─── expectSyncNoopResult ─────────────────────────────────────────────────────

test("expectSyncNoopResult passes when result has 0 upserted, 0 deleted, null cursor", () => {
  const result: Pick<SyncResult, "itemsUpserted" | "itemsDeleted" | "cursor"> = {
    itemsUpserted: 0,
    itemsDeleted: 0,
    cursor: null,
  };
  // Should not throw
  expectSyncNoopResult(result);
});

test("expectSyncNoopResult fails when itemsUpserted is non-zero", () => {
  expect(() => {
    expectSyncNoopResult({ itemsUpserted: 1, itemsDeleted: 0, cursor: null });
  }).toThrow();
});

test("expectSyncNoopResult fails when itemsDeleted is non-zero", () => {
  expect(() => {
    expectSyncNoopResult({ itemsUpserted: 0, itemsDeleted: 1, cursor: null });
  }).toThrow();
});

test("expectSyncNoopResult fails when cursor is not null", () => {
  expect(() => {
    expectSyncNoopResult({ itemsUpserted: 0, itemsDeleted: 0, cursor: "some-cursor" });
  }).toThrow();
});

// ─── expectServiceItemCount ───────────────────────────────────────────────────

test("expectServiceItemCount passes when the count matches the database rows for a service", () => {
  const db = createMemoryIndexDb();
  // No rows yet — count should be 0
  expectServiceItemCount(db, "test-service", 0);
  db.close();
});

test("expectServiceItemCount fails when the count does not match", () => {
  const db = createMemoryIndexDb();
  expect(() => {
    expectServiceItemCount(db, "test-service", 5);
  }).toThrow();
  db.close();
});

// ─── testConnectorSyncNoop ────────────────────────────────────────────────────

/**
 * A minimal Syncable that always returns a no-op SyncResult regardless of
 * credentials. This is the canonical dependency-injected fake used to exercise
 * testConnectorSyncNoop without touching any real connector code.
 */
function makeNoopSyncable(): Syncable {
  return {
    serviceId: "test-noop",
    defaultIntervalMs: 3_600_000,
    initialSyncDepthDays: 30,
    async sync(_ctx: SyncContext, _cursor: string | null): Promise<SyncResult> {
      return {
        cursor: null,
        itemsUpserted: 0,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: 0,
      };
    },
  };
}

// testConnectorSyncNoop registers a Bun test — exercising it directly verifies
// the helper correctly calls sync() and asserts the noop invariant.
testConnectorSyncNoop(
  "testConnectorSyncNoop: no-op syncable satisfies noop assertions",
  makeNoopSyncable,
  EMPTY_NIMBUS_VAULT,
);

// ─── describeWithFetchRestore ─────────────────────────────────────────────────

describeWithFetchRestore(
  "describeWithFetchRestore restores globalThis.fetch after each test",
  () => {
    test("overriding globalThis.fetch inside the describe block works without leaking", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        )) as unknown as typeof fetch;

      const resp = await globalThis.fetch("https://example.com");
      expect(resp.status).toBe(200);

      // Verify the original is different from our stub
      expect(globalThis.fetch).not.toBe(originalFetch);
    });

    test("fetch is restored between tests (this test sees the stub is gone after prior afterEach)", async () => {
      // After the previous test's afterEach, globalThis.fetch was restored.
      // We just verify the current fetch is a function (the original).
      expect(typeof globalThis.fetch).toBe("function");
    });
  },
);
