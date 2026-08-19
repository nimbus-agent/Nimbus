import { expect, test } from "bun:test";
import { resolveItemByUrl } from "../index/resolve-by-url.ts";
import {
  bitbucketDiffstatHasMore,
  createBitbucketSyncable,
  prDiffstatUrl,
} from "./bitbucket-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  type SyncTestFetchParams,
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

  // Five upstream status codes, one shape: mock the status, assert the mapped
  // result. The mapping is the whole point — a 403 must read as `unauthorized`
  // and NOT as `absent`, or a permissions problem looks like a deleted PR.
  // `credential` varies only to keep the expired-token narrative on the 401 row.
  test.each([
    [404, "app-pass", { status: "not_found", reason: "absent" }],
    [401, "expired-app-pass", { status: "not_found", reason: "unauthorized" }],
    [403, "app-pass", { status: "not_found", reason: "unauthorized" }],
    [429, "app-pass", { status: "rate_limited" }],
    [500, "app-pass", { status: "not_found", reason: "upstream_error" }],
  ] as const)(
    "maps upstream %i to the right fetchOne result",
    async (code, credential, expected) => {
      const db = createMemoryIndexDb();
      const ctx = ctxWithCreds(db, "user", credential);
      globalThis.fetch = ((): Promise<Response> =>
        Promise.resolve(new Response("body", { status: code }))) as unknown as typeof fetch;

      const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
      const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

      expect(out).toEqual(expected);
    },
  );

  test("reports no_credential when credentials are missing", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, null, null);
    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found", reason: "no_credential" });
  });

  // IMPORTANT 3: a DNS/TLS/connect failure must report not_found, not throw.
  test("reports unreachable when fetch itself throws (DNS/TLS/connect failure)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.bitbucket.org");
    }) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found", reason: "unreachable" });
    expect(JSON.stringify(out)).not.toContain("api.bitbucket.org");
  });

  // A stalled/aborted upstream request must report not_found rather than hang the caller
  // (`POST /v1/items/fetch`) indefinitely — and the outbound request must actually carry a bounded
  // abort signal, not merely happen to survive an unrelated rejection.
  test("reports unreachable and passes an abort signal when the request is aborted (timeout)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: unknown, init?: SyncTestFetchParams[1]): Promise<Response> => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.reject(
        Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
      );
    }) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found", reason: "unreachable" });
    expect(capturedSignal).toBeDefined();
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

  test("reports upstream_error for a malformed (non-JSON) ok response", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  test("reports upstream_error for valid JSON that is not an object", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("[1,2,3]", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  test("reports upstream_error when the response body has no id field", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithCreds(db, "user", "app-pass");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ title: "No id field" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://bitbucket.org/w/r/pull-requests/42");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });
});

test("prDiffstatUrl requests the diffstat endpoint, a page number, and the page-size parameter", () => {
  const u = prDiffstatUrl("w/r", 42, 2);
  expect(u).toBe(
    "https://api.bitbucket.org/2.0/repositories/w/r/pullrequests/42/diffstat?pagelen=100&page=2",
  );
});

test("bitbucketDiffstatHasMore reads the next-URL, not page length", () => {
  expect(bitbucketDiffstatHasMore({ next: "https://api.bitbucket.org/2.0/...", values: [] })).toBe(
    true,
  );
  expect(bitbucketDiffstatHasMore({ values: [] })).toBe(false);
  // A `next` field of the wrong type must not be treated as "there is a next page".
  expect(bitbucketDiffstatHasMore({ next: 123, values: [] })).toBe(false);
  expect(bitbucketDiffstatHasMore(null)).toBe(false);
  // An EMPTY `next` is the same "no next page" as an absent one, and is read that way for the PR
  // list itself elsewhere in this file. A bare `typeof === "string"` says true here, which keeps
  // the driver paging to `MAX_PAGES_PER_PR` and records a fully-stored PR as `truncated` —
  // permanently excluding it from negation.
  expect(bitbucketDiffstatHasMore({ next: "", values: [] })).toBe(false);
});
