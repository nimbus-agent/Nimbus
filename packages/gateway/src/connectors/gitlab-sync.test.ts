import { expect, test } from "bun:test";

import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  type SyncTestFetchParams,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";
import { createGitlabSyncable, mrDiffsUrl } from "./gitlab-sync.ts";

function ctxWithPat(
  db: ReturnType<typeof createMemoryIndexDb>,
  pat: string | null,
  apiBase?: string,
) {
  return {
    db,
    vault: createStubVault({
      "gitlab.pat": pat,
      ...(apiBase !== undefined ? { "gitlab.api_base": apiBase } : {}),
    }),
    ...silentSyncContextExtras(),
    ...boundTestCapabilities(
      db,
      createStubVault({
        "gitlab.pat": pat,
        ...(apiBase !== undefined ? { "gitlab.api_base": apiBase } : {}),
      }),
      "gitlab",
    ),
  };
}

function mrPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 7,
    title: "Fix the retry loop",
    state: "opened",
    updated_at: "2026-08-01T00:00:00Z",
    created_at: "2026-07-30T00:00:00Z",
    author: { username: "alice", name: "Alice" },
    ...overrides,
  };
}

describeWithFetchRestore("gitlab-sync fetchOne", () => {
  test("gitlab fetchOne indexes a merge request on a self-hosted origin, and it resolves", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t", "https://git.corp.example/api/v4");
    const callerUrl = "https://git.corp.example/grp/sub/proj/-/merge_requests/7";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(mrPayload({ web_url: callerUrl })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "gitlab:grp/sub/proj!7" });
    // The row must be RESOLVABLE: `resolve_key` exactly equal to the plain caller URL, not an
    // `encodeURIComponent`-mangled variant (see `_lib/gitlab/events.ts`'s `canonicalUrl`
    // fallback) — that byte-difference is exactly what made GitLab MRs unresolvable before this
    // fix (fetch-on-miss would loop forever).
    const row = db
      .query("SELECT resolve_key FROM item WHERE id = 'gitlab:grp/sub/proj!7'")
      .get() as { resolve_key: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
  });

  test("gitlab fetchOne resolves even when the response has no web_url at all", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    const callerUrl = "https://gitlab.com/g/p/-/merge_requests/7";
    // No `web_url` field on the mocked response — the caller URL is used regardless; this
    // connector never reads a remote-supplied URL into `resolve_key`.
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(mrPayload()), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "gitlab:g/p!7" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'gitlab:g/p!7'").get() as {
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
  });

  // Regression: a REMOTE-supplied `web_url` must never become the `resolve_key`. An empty
  // string is non-nullish (so a naive `?? url` fallback would keep it), and GitLab redirects
  // (e.g. a renamed project) make a differing `web_url` a realistic, non-malicious case — not
  // just an adversarial one. Either way the row must resolve under the CALLER's URL.
  test.each([
    ["is an empty string", ""],
    [
      "points at a different project entirely (a GitLab redirect)",
      "https://gitlab.com/g/renamed-p/-/merge_requests/7",
    ],
    ["points at a completely different host", "https://evil.example/g/p/-/merge_requests/7"],
  ])("gitlab fetchOne ignores a response web_url that %s", async (_label, responseWebUrl) => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    const callerUrl = "https://gitlab.com/g/p/-/merge_requests/7";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(mrPayload({ web_url: responseWebUrl })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "gitlab:g/p!7" });
    const row = db.query("SELECT resolve_key, url FROM item WHERE id = 'gitlab:g/p!7'").get() as {
      resolve_key: string | null;
      url: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
    expect(row?.url).toBe(callerUrl);
  });

  test("gitlab fetchOne declines an issue url", async () => {
    const ctx = ctxWithPat(createMemoryIndexDb(), "t");
    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });

    expect(await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/issues/7")).toEqual({
      status: "unsupported_url",
    });
  });

  // Five upstream status codes, one shape: mock the status, assert the mapped
  // result. The mapping is the whole point — a 403 must read as `unauthorized`
  // and NOT as `absent`, or a permissions problem looks like a deleted MR.
  // `pat` varies only to keep the expired-token narrative on the 401 row.
  test.each([
    [404, "t", { status: "not_found", reason: "absent" }],
    [401, "expired-pat", { status: "not_found", reason: "unauthorized" }],
    [403, "t", { status: "not_found", reason: "unauthorized" }],
    [429, "t", { status: "rate_limited" }],
    [500, "t", { status: "not_found", reason: "upstream_error" }],
  ] as const)("maps upstream %i to the right fetchOne result", async (code, pat, expected) => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, pat);
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("body", { status: code }))) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual(expected);
  });

  test("reports unreachable when fetch itself throws (DNS/TLS/connect failure)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND git.corp.example");
    }) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found", reason: "unreachable" });
    expect(JSON.stringify(out)).not.toContain("git.corp.example");
  });

  test("reports no_credential when the PAT is missing", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, null);
    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found", reason: "no_credential" });
  });

  // A stalled/aborted upstream request must report not_found rather than hang the caller
  // (`POST /v1/items/fetch`) indefinitely — and the outbound request must actually carry a bounded
  // abort signal, not merely happen to survive an unrelated rejection. This fetch call is NOT
  // shared with the periodic sync (`_lib/gitlab/events.ts` / `_lib/gitlab/pipelines.ts` each make
  // their own separate fetch calls), so adding the signal here cannot affect a scheduled sync.
  test("reports unreachable and passes an abort signal when the request is aborted (timeout)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: unknown, init?: SyncTestFetchParams[1]): Promise<Response> => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.reject(
        Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
      );
    }) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found", reason: "unreachable" });
    expect(capturedSignal).toBeDefined();
  });

  // Regression: the returned itemId must match the row's ACTUAL id — derived from the API
  // response's own `iid` field, not the raw regex-captured digit string from the caller's URL. A
  // leading-zero URL is the case where they diverge ("007" vs the API's normalized `7`).
  test("a leading-zero iid resolves to the API's normalized id, not the raw capture", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(mrPayload({ iid: 7 })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/007");

    expect(out).toEqual({ status: "indexed", itemId: "gitlab:g/p!7" });
    const row = db.query("SELECT id FROM item WHERE id = 'gitlab:g/p!7'").get() as {
      id: string;
    } | null;
    expect(row).not.toBeNull();
  });

  test("declines when the namespace path is a dot-traversal segment", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/../-/merge_requests/1");

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports upstream_error for a malformed (non-JSON) ok response", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  test("reports upstream_error for valid JSON that is not an object", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("[1,2,3]", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  test("reports upstream_error when the response body has no iid field", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ title: "No iid field" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  test("indexes a merge request under a deeply nested namespace path, and it resolves", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    const callerUrl = "https://gitlab.com/grp/sub1/sub2/proj/-/merge_requests/3";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(mrPayload({ iid: 3, web_url: callerUrl })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "gitlab:grp/sub1/sub2/proj!3" });
    const row = db
      .query("SELECT resolve_key FROM item WHERE id = 'gitlab:grp/sub1/sub2/proj!3'")
      .get() as { resolve_key: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
  });
});

test("mrDiffsUrl requests the diffs endpoint, a page number, and the page-size parameter", () => {
  const u = mrDiffsUrl("https://gitlab.example.com/api/v4", "grp/sub/proj", 7, 2);
  expect(u).toBe(
    "https://gitlab.example.com/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/diffs?page=2&per_page=100",
  );
});
