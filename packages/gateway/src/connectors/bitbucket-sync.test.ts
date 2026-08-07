import { expect, test } from "bun:test";
import { resolveItemByUrl } from "../index/resolve-by-url.ts";
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

  // IMPORTANT 3: a DNS/TLS/connect failure must report not_found, not throw.
  test("reports not_found when fetch itself throws (DNS/TLS/connect failure)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.bitbucket.org");
    }) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found" });
  });

  // CRITICAL 3: `links.html.href` is REMOTE-supplied and must never become the `resolve_key` —
  // the existing tests above pass only because their fixture's href happens to equal the caller
  // URL, which is precisely why this survived. A genuinely DIVERGENT fixture proves the fix.
  test.each([
    ["points at a renamed repo", "https://bitbucket.org/w2/r2/pull-requests/42"],
    ["points at a completely different host", "https://evil.example/w/r/pull-requests/42"],
  ])("ignores a response links.html.href that %s", async (_label, responseHref) => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    const callerUrl = "https://bitbucket.org/w/r/pull-requests/42";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(prPayload({ links: { html: { href: responseHref } } })), {
          status: 200,
        }),
      )) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "bitbucket:w/r#42" });
    const row = db
      .query("SELECT resolve_key, url FROM item WHERE id = 'bitbucket:w/r#42'")
      .get() as {
      resolve_key: string | null;
      url: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
    expect(row?.url).toBe(callerUrl);
  });

  // Round-trip: caller URL -> fetchOne -> stored resolve_key -> resolveItemByUrl(callerUrl) must
  // be an exact hit, even when the API response's own href diverges from the caller's URL.
  test("round-trips through resolveItemByUrl even when links.html.href diverges", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    const callerUrl = "https://bitbucket.org/w/r/pull-requests/42";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            prPayload({
              links: { html: { href: "https://bitbucket.org/w2/r2/pull-requests/42" } },
            }),
          ),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);
    expect(out).toEqual({ status: "indexed", itemId: "bitbucket:w/r#42" });

    const resolved = resolveItemByUrl(db, callerUrl);
    expect(resolved).toMatchObject({ found: true, matchKind: "exact" });
  });

  // Regression: the returned itemId must match the row's ACTUAL id — derived from the API
  // response's own `id` field, not the raw regex-captured digit string from the caller's URL. A
  // leading-zero URL is the case where they diverge ("007" vs the API's normalized `7`).
  // `resolve_key` stays the CALLER's literal URL ("...pull-requests/007"), never the
  // API-normalized "...pull-requests/7" — see the equivalent github-sync.test.ts comment for why.
  test("a leading-zero PR number resolves to the API's normalized id, not the raw capture", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    const callerUrl = "https://bitbucket.org/w/r/pull-requests/007";
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
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "bitbucket:w/r#7" });
    const row = db.query("SELECT id, resolve_key FROM item WHERE id = 'bitbucket:w/r#7'").get() as {
      id: string;
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
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
