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

  // Regression: the returned itemId must match the row's ACTUAL id — derived from the API
  // response's own `id` field, not the raw regex-captured digit string from the caller's URL. A
  // leading-zero URL is the case where they diverge ("007" vs the API's normalized `7`).
  test("a leading-zero PR number resolves to the API's normalized id, not the raw capture", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            prPayload({
              id: 7,
              links: { html: { href: "https://bitbucket.org/w/r/pull-requests/7" } },
            }),
          ),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/007");

    expect(out).toEqual({ status: "indexed", itemId: "bitbucket:w/r#7" });
    const row = db.query("SELECT id, resolve_key FROM item WHERE id = 'bitbucket:w/r#7'").get() as {
      id: string;
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe("https://bitbucket.org/w/r/pull-requests/7");
  });

  test.each([
    ["workspace is a dot-traversal segment", "https://bitbucket.org/../r/pull-requests/1"],
    ["repo is a dot-traversal segment", "https://bitbucket.org/w/../pull-requests/1"],
  ])("declines when %s", async (_label, url) => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, url);

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports not_found for a malformed (non-JSON) ok response", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found for valid JSON that is not an object", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("[1,2,3]", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when the response body has no id field", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ title: "No id field" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found" });
  });
});
