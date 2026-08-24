import { expect, test } from "bun:test";

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
import { createFirebaseSyncable } from "./firebase-sync.ts";

const APP_ID = "1:1234567890:android:abc";
const RELEASE_NAME = `projects/1234567890/apps/${APP_ID}/releases/r1`;

function validServiceAccountJson(): string {
  return JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "k" });
}

function fullVault() {
  return createStubVault({
    "firebase.service_account_json": validServiceAccountJson(),
    "firebase.app_ids": APP_ID,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const RELEASES_FIXTURE = {
  releases: [
    {
      name: RELEASE_NAME,
      displayVersion: "1.0.0",
      buildVersion: "100",
      createTime: "2026-05-30T12:00:00Z",
      releaseNotes: { text: "Initial release" },
      firebaseConsoleUri: "https://console.firebase.google.com/x",
      testingUri: "https://appdistribution.firebase.dev/y",
      binaryDownloadUri: "https://firebaseappdistribution.googleapis.com/bin",
    },
    {
      name: `projects/1234567890/apps/${APP_ID}/releases/r2`,
      displayVersion: "1.0.1",
      buildVersion: "101",
      createTime: "2026-05-31T12:00:00Z",
    },
  ],
};

/** Stub fetch to serve the per-app releases list. */
function stubReleases(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlFromFetchInput(input);
    calls.push(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    if (auth !== "Bearer fake-token") {
      throw new Error(`missing/invalid bearer token: ${auth}`);
    }
    if (url.includes("/releases")) {
      return jsonResponse(RELEASES_FIXTURE);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { calls };
}

function syncable() {
  return createFirebaseSyncable({
    ensureFirebaseMcpRunning: async () => {},
    mintToken: async () => "fake-token",
  });
}

describeWithFetchRestore("firebase-sync (fake server)", () => {
  testConnectorSyncNoop(
    "no-op when credentials missing",
    () => createFirebaseSyncable({ ensureFirebaseMcpRunning: async () => {} }),
    EMPTY_NIMBUS_VAULT,
  );

  test("no-op when only the service account is set", async () => {
    const sync = createFirebaseSyncable({ ensureFirebaseMcpRunning: async () => {} });
    const ctxDb = createMemoryIndexDb();
    const ctxVault = createStubVault({
      "firebase.service_account_json": validServiceAccountJson(),
    });
    const ctx = {
      vault: ctxVault,
      db: ctxDb,
      ...silentSyncContextExtras(),
      ...boundTestCapabilities(ctxDb, ctxVault, "firebase"),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBeNull();
  });

  test("no-op when the service account JSON is malformed", async () => {
    const sync = createFirebaseSyncable({ ensureFirebaseMcpRunning: async () => {} });
    const ctxDb = createMemoryIndexDb();
    const ctxVault = createStubVault({
      "firebase.service_account_json": "{not json",
      "firebase.app_ids": APP_ID,
    });
    const ctx = {
      vault: ctxVault,
      db: ctxDb,
      ...silentSyncContextExtras(),
      ...boundTestCapabilities(ctxDb, ctxVault, "firebase"),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBeNull();
  });

  test("returns a pass cursor with zero upserts when the token mint fails", async () => {
    const sync = createFirebaseSyncable({
      ensureFirebaseMcpRunning: async () => {},
      mintToken: async () => null,
    });
    const result = await sync.sync(
      syncTestContext(createMemoryIndexDb(), fullVault(), "firebase"),
      null,
    );
    expect(result.itemsUpserted).toBe(0);
    expect((result.cursor as string).startsWith("nimbus-firebase1:")).toBe(true);
  });

  test("upserts the app's releases", async () => {
    const { calls } = stubReleases();
    const db = createMemoryIndexDb();
    const result = await syncable().sync(syncTestContext(db, fullVault(), "firebase"), null);
    expect(result.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "firebase", 2);
    expect(calls[0]).toContain("firebaseappdistribution.googleapis.com");
    expect(calls[0]).toContain("/releases");
    expect(calls[0]).toContain("pageSize=50");

    const row = db
      .prepare("SELECT title, metadata FROM item WHERE service = ? AND external_id = ?")
      .get("firebase", RELEASE_NAME) as { title: string; metadata: string };
    expect(row.title).toBe("1.0.0 (100)");
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta["app_id"]).toBe(APP_ID);
    expect(meta["create_time"]).toBe(Date.parse("2026-05-30T12:00:00Z"));
  });

  test("advances the pass cursor", async () => {
    stubReleases();
    const result = await syncable().sync(
      syncTestContext(createMemoryIndexDb(), fullVault(), "firebase"),
      null,
    );
    const cursor = result.cursor as string;
    expect(cursor.startsWith("nimbus-firebase1:")).toBe(true);
    const decoded = Buffer.from(cursor.slice("nimbus-firebase1:".length), "base64url").toString(
      "utf8",
    );
    expect(JSON.parse(decoded)).toEqual({ pass: 1 });
  });

  test("http error on releases preserves a pass cursor with zero upserts", async () => {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) =>
      new Response("nope", { status: 500 })) as typeof fetch;
    const db = createMemoryIndexDb();
    const result = await syncable().sync(syncTestContext(db, fullVault(), "firebase"), null);
    expect(result.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "firebase", 0);
    expect((result.cursor as string).startsWith("nimbus-firebase1:")).toBe(true);
  });

  test("skips an app id with no derivable project number", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(urlFromFetchInput(input));
      return jsonResponse(RELEASES_FIXTURE);
    }) as typeof fetch;
    const db = createMemoryIndexDb();
    const sync = createFirebaseSyncable({
      ensureFirebaseMcpRunning: async () => {},
      mintToken: async () => "fake-token",
    });
    const ctx = syncTestContext(
      db,
      createStubVault({
        "firebase.service_account_json": validServiceAccountJson(),
        "firebase.app_ids": "nocolons",
      }),
      "firebase",
    );
    const result = await sync.sync(ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
