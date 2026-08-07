import { expect, test } from "bun:test";
import { createBitbucketSyncable } from "./bitbucket-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";

function ctxWithCreds(
  db: ReturnType<typeof createMemoryIndexDb>,
  user: string | null,
  pass: string | null,
) {
  return {
    db,
    vault: createStubVault({ "bitbucket.username": user, "bitbucket.app_password": pass }),
    ...silentSyncContextExtras(),
  };
}

function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    title: "Fix the retry loop",
    description: "Body text",
    state: "OPEN",
    updated_on: "2026-08-01T00:00:00Z",
    links: { html: { href: "https://bitbucket.org/w/r/pull-requests/42" } },
    ...overrides,
  };
}

describeWithFetchRestore("bitbucket-sync fetchOne", () => {
  test("indexes a PR url and makes it resolvable", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(prPayload()), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "indexed", itemId: "bitbucket:w/r#42" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'bitbucket:w/r#42'").get() as {
      resolve_key: string | null;
    };
    expect(row.resolve_key).toBe("https://bitbucket.org/w/r/pull-requests/42");
  });

  test("declines a non-PR bitbucket url", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/src/main/README.md");

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports not_found for a 404", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/999");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when credentials are missing", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, null, null);
    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found" });
  });
});
