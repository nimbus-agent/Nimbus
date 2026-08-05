import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createMemoryIndexDb } from "./connector-sync-test-helpers.ts";
import { createMendeleySyncable, formatCursorDate } from "./mendeley-sync.ts";

function makeCtx(hasSecret: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "mendeley-sync-"));
  return {
    vault: {
      get: async (k: string) =>
        hasSecret && k === "mendeley.oauth"
          ? JSON.stringify({
              accessToken: "tok-abc",
              refreshToken: "ref",
              expiresAt: Date.now() + 3_600_000,
              scopes: ["all"],
            })
          : null,
      set: async () => {},
      delete: async () => {},
      listKeys: async () => [],
    },
    db: createMemoryIndexDb(),
    logger: pino({ level: "silent" }),
    rateLimiter: { acquire: async () => {} },
    sandboxCwd: dir,
    credentialFor: () => ({ credential: "personal" as const }),
    runTeamList: async () => [],
    depth: "full" as const,
  };
}

function makeCtxWithSecret(secret: string) {
  const dir = mkdtempSync(join(tmpdir(), "mendeley-sync-"));
  return {
    vault: {
      get: async (k: string) => (k === "mendeley.oauth" ? secret : null),
      set: async () => {},
      delete: async () => {},
      listKeys: async () => [],
    },
    db: createMemoryIndexDb(),
    logger: pino({ level: "silent" }),
    rateLimiter: { acquire: async () => {} },
    sandboxCwd: dir,
    credentialFor: () => ({ credential: "personal" as const }),
    runTeamList: async () => [],
    depth: "full" as const,
  };
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(2);
    expect(calls[1]).toBe("https://api.mendeley.com/documents?marker=REL2");
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    await syncable.sync(ctx as any, cursor);
    expect(calls[0]).toContain("modified_since=2024-03-02T08%3A00%3A00Z");
  });

  test("first-page HTTP error returns an empty pass result", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const ctx = makeCtx(true);
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("no-ops when the OAuth token cannot be resolved (malformed secret)", async () => {
    // Secret present but not valid JSON → getValidMendeleyAccessToken throws → catch arm noop.
    const fetchFn = (async () => {
      throw new Error("fetch should never run when the token cannot be resolved");
    }) as unknown as typeof fetch;
    const ctx = makeCtxWithSecret("not-json");
    const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    await syncable.sync(ctx as any, "nimbus-other:whatever");
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(0);
  });
});
