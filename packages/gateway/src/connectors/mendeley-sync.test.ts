import { describe, expect, test } from "bun:test";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createMendeleySyncable, formatCursorDate } from "./mendeley-sync.ts";

// `syncTestContext`/`createStubVault` (connector-sync-test-helpers.ts) build a
// real, fully-typed `SyncContext` -- no `any` cast needed at any `sync()`
// call site below, and no missing required field can hide behind one either.
function makeCtx(hasSecret: boolean): SyncContext {
  const secret = hasSecret
    ? JSON.stringify({
        accessToken: "tok-abc",
        refreshToken: "ref",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["all"],
      })
    : null;
  return syncTestContext(
    createMemoryIndexDb(),
    createStubVault({ "mendeley.oauth": secret }),
    "mendeley",
  );
}

function makeCtxWithSecret(secret: string): SyncContext {
  return syncTestContext(
    createMemoryIndexDb(),
    createStubVault({ "mendeley.oauth": secret }),
    "mendeley",
  );
}

function jsonResponse(body: unknown, link?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (link !== undefined) headers.set("link", link);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("formatCursorDate", () => {
  test("strips milliseconds", () => {
    expect(formatCursorDate(new Date("2024-03-02T08:00:00.123Z"))).toBe("2024-03-02T08:00:00Z");
  });
});

describe("createMendeleySyncable", () => {
  test("no-ops when the OAuth secret is absent", async () => {
    const ctx = makeCtx(false);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} });
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("follows Link rel=next across pages and counts upserts", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("marker=PAGE2")) {
        return jsonResponse([{ id: "d2", title: "Second" }]);
      }
      return jsonResponse(
        [{ id: "d1", title: "First" }],
        '<https://api.mendeley.com/documents?marker=PAGE2>; rel="next"',
      );
    }) as unknown as typeof fetch;
    const ctx = makeCtx(true);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/documents?view=all&limit=100");
    expect(calls[0]).not.toContain("modified_since");
  });

  test("resolves a relative rel=next href against the current page URL", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("marker=REL2")) {
        return jsonResponse([{ id: "d2", title: "Second" }]);
      }
      // Relative next href (RFC 5988 permits it) — must be resolved to absolute.
      return jsonResponse([{ id: "d1", title: "First" }], '</documents?marker=REL2>; rel="next"');
    }) as unknown as typeof fetch;
    const ctx = makeCtx(true);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(2);
    expect(calls[1]).toBe("https://api.mendeley.com/documents?marker=REL2");
  });

  test("follows rel=next even when it is not the first link parameter", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("marker=ORD2")) {
        return jsonResponse([{ id: "d2", title: "Second" }]);
      }
      // `rel` LAST, not first — the old regex required it first and would have
      // treated this as "no next page", silently truncating the sync.
      return jsonResponse(
        [{ id: "d1", title: "First" }],
        '<https://api.mendeley.com/documents?marker=ORD2>; type="application/json"; rel="next"',
      );
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeCtxWithSecret(
      JSON.stringify({
        accessToken: "tok-abc",
        refreshToken: "ref",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["all"],
      }),
    );
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const r = await syncable.sync(ctx, null);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("https://api.mendeley.com/documents?marker=ORD2");
    expect(r.itemsUpserted).toBe(2);
  });

  test("emits modified_since (seconds precision) on an incremental cycle", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const ctx = makeCtx(true);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const cursor = `nimbus-mendeley1:${Buffer.from(
      JSON.stringify({ since: "2024-03-02T08:00:00Z" }),
      "utf8",
    ).toString("base64url")}`;
    await syncable.sync(ctx, cursor);
    expect(calls[0]).toContain("modified_since=2024-03-02T08%3A00%3A00Z");
  });

  test("first-page HTTP error returns an empty pass result", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const ctx = makeCtx(true);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("no-ops when the OAuth token cannot be resolved (malformed secret)", async () => {
    // Secret present but not valid JSON → getValidMendeleyAccessToken throws → catch arm noop.
    const fetchFn = (async () => {
      throw new Error("fetch should never run when the token cannot be resolved");
    }) as unknown as typeof fetch;
    const ctx = makeCtxWithSecret("not-json");
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("a wrong-prefix cursor is ignored (no modified_since)", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const ctx = makeCtx(true);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    await syncable.sync(ctx, "nimbus-other:whatever");
    expect(calls[0]).not.toContain("modified_since");
  });

  test("a later-page error breaks the loop but still returns the earlier upserts", async () => {
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("marker=PAGE2")) {
        return new Response("boom", { status: 500 });
      }
      return jsonResponse(
        [{ id: "d1", title: "First" }],
        '<https://api.mendeley.com/documents?marker=PAGE2>; rel="next"',
      );
    }) as unknown as typeof fetch;
    const ctx = makeCtx(true);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
  });

  test("first-page parse error returns an empty pass result", async () => {
    const fetchFn = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const ctx = makeCtx(true);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
  });
});
