import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";
import { createGithubSyncable } from "./github-sync.ts";

function ctxWithPat(db: ReturnType<typeof createMemoryIndexDb>, pat: string | null) {
  return {
    db,
    vault: createStubVault({ "github.pat": pat }),
    ...silentSyncContextExtras(),
  };
}

function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: "Fix the retry loop",
    body: "Body text",
    html_url: "https://github.com/o/r/pull/42",
    state: "open",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describeWithFetchRestore("github-sync fetchOne", () => {
  test("indexes a PR url and makes it resolvable", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(prPayload()), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "indexed", itemId: "github:o/r#42" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'github:o/r#42'").get() as {
      resolve_key: string | null;
    };
    expect(row.resolve_key).toBe("https://github.com/o/r/pull/42");
  });

  test("declines a non-PR github url", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/actions/runs/1");

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports not_found for a 404", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/999");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when the PAT is missing", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, null);
    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "not_found" });
  });
});
