import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  silentSyncContextExtras,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createTestflightSyncable } from "./testflight-sync.ts";

function generateP8Pem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function fullVault() {
  return createStubVault({
    "testflight.issuer_id": "issuer-123",
    "testflight.key_id": "KEY456",
    "testflight.private_key": generateP8Pem(),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const APPS_FIXTURE = {
  data: [
    { type: "apps", id: "6448001234", attributes: { name: "Acme", bundleId: "com.acme.app" } },
  ],
};

const BUILDS_FIXTURE = {
  data: [
    {
      type: "builds",
      id: "10009999",
      attributes: {
        version: "204",
        processingState: "VALID",
        expired: false,
        uploadedDate: "2026-05-30T12:00:00Z",
        minOsVersion: "16.0",
        usesNonExemptEncryption: false,
      },
    },
    {
      type: "builds",
      id: "10009998",
      attributes: {
        version: "203",
        processingState: "PROCESSING",
        uploadedDate: "2026-05-29T12:00:00Z",
      },
    },
  ],
};

/** Stub fetch to serve the apps list, then the per-app builds list. */
function stubAppStore(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlFromFetchInput(input);
    calls.push(url);
    // The signer must have produced a real Bearer token.
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth)) {
      throw new Error(`missing/invalid bearer token: ${auth}`);
    }
    if (url.startsWith("https://api.appstoreconnect.apple.com/v1/apps")) {
      return jsonResponse(APPS_FIXTURE);
    }
    if (url.startsWith("https://api.appstoreconnect.apple.com/v1/builds")) {
      return jsonResponse(BUILDS_FIXTURE);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { calls };
}

describeWithFetchRestore("testflight-sync (fake server)", () => {
  testConnectorSyncNoop(
    "no-op when credentials missing",
    () => createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} }),
    EMPTY_NIMBUS_VAULT,
  );

  test("no-op when only some credentials are set", async () => {
    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const ctxDb = createMemoryIndexDb();
    const ctxVault = createStubVault({ "testflight.issuer_id": "i", "testflight.key_id": "k" });
    const ctx = {
      vault: ctxVault,
      db: ctxDb,
      ...silentSyncContextExtras(),
      ...boundTestCapabilities(ctxDb, ctxVault, "testflight"),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBeNull();
  });

  test("upserts the app and its builds (signer runs for real)", async () => {
    const { calls } = stubAppStore();
    const db = createMemoryIndexDb();
    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const result = await sync.sync(syncTestContext(db, fullVault(), "testflight"), null);

    expect(result.itemsUpserted).toBe(3); // 1 app + 2 builds
    expectServiceItemCount(db, "testflight", 3);
    expect(calls[0]).toContain("/v1/apps");
    expect(calls[1]).toContain("/v1/builds?filter[app]=6448001234");
    expect(calls[1]).toContain("sort=-uploadedDate");

    const buildRow = db
      .prepare("SELECT title, metadata FROM item WHERE service = ? AND external_id = ?")
      .get("testflight", "10009999") as { title: string; metadata: string };
    expect(buildRow.title).toBe("Acme #204 (VALID)");
    const meta = JSON.parse(buildRow.metadata) as Record<string, unknown>;
    expect(meta["processing_state"]).toBe("VALID");
    expect(meta["uploaded_date"]).toBe(Date.parse("2026-05-30T12:00:00Z"));
  });

  test("advances the pass cursor", async () => {
    stubAppStore();
    const db: Database = createMemoryIndexDb();
    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const result = await sync.sync(syncTestContext(db, fullVault(), "testflight"), null);
    expect(result.cursor).not.toBeNull();
    const cursor = result.cursor as string;
    expect(cursor.startsWith("nimbus-testflight1:")).toBe(true);
    const decoded = Buffer.from(cursor.slice("nimbus-testflight1:".length), "base64url").toString(
      "utf8",
    );
    expect(JSON.parse(decoded)).toEqual({ pass: 1 });
  });

  test("http error on /v1/apps preserves cursor with zero upserts", async () => {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const db = createMemoryIndexDb();
    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const result = await sync.sync(syncTestContext(db, fullVault(), "testflight"), null);
    expect(result.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "testflight", 0);
  });

  test("builds fetch failure still upserts the app", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/v1/apps")) {
        return jsonResponse(APPS_FIXTURE);
      }
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const db = createMemoryIndexDb();
    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const result = await sync.sync(syncTestContext(db, fullVault(), "testflight"), null);
    expect(result.itemsUpserted).toBe(1); // just the app
    expectServiceItemCount(db, "testflight", 1);
  });
});
