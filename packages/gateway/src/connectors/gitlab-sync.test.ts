import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";
import { createGitlabSyncable } from "./gitlab-sync.ts";

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
  test("gitlab fetchOne indexes a merge request on a self-hosted origin", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t", "https://git.corp.example/api/v4");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(mrPayload()), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(
      ctx,
      "https://git.corp.example/grp/sub/proj/-/merge_requests/7",
    );

    expect(out).toEqual({ status: "indexed", itemId: "gitlab:grp/sub/proj!7" });
    const row = db
      .query("SELECT resolve_key FROM item WHERE id = 'gitlab:grp/sub/proj!7'")
      .get() as { resolve_key: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).not.toBeNull();
    expect(row?.resolve_key).toContain("merge_requests/7");
  });

  test("gitlab fetchOne declines an issue url", async () => {
    const ctx = ctxWithPat(createMemoryIndexDb(), "t");
    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });

    expect(await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/issues/7")).toEqual({
      status: "unsupported_url",
    });
  });

  test("reports not_found for a 404", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/999");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when the PAT is missing", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, null);
    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found" });
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

  test("reports not_found for a malformed (non-JSON) ok response", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found for valid JSON that is not an object", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("[1,2,3]", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when the response body has no iid field", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ title: "No iid field" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/merge_requests/7");

    expect(out).toEqual({ status: "not_found" });
  });

  test("indexes a merge request under a deeply nested namespace path", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "t");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(mrPayload({ iid: 3 })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGitlabSyncable({ ensureGitlabMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(
      ctx,
      "https://gitlab.com/grp/sub1/sub2/proj/-/merge_requests/3",
    );

    expect(out).toEqual({ status: "indexed", itemId: "gitlab:grp/sub1/sub2/proj!3" });
  });
});
