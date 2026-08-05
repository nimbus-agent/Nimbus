import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { LocalIndex } from "../../index/local-index.ts";
import { ProviderRateLimiter } from "../../sync/rate-limiter.ts";
import type { SyncContext } from "../../sync/types.ts";
import { createMockVault } from "../../vault/mock.ts";
import { type PerAppPollSpec, runPerAppPollSync } from "./per-app-poll-sync.ts";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function makeCtx(): { ctx: SyncContext; db: Database; cleanup: () => void } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const ctx = {
    vault: createMockVault(),
    db,
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({}),
    sandboxCwd: "/tmp",
    credentialFor: () => ({ credential: "personal" as const }),
    runTeamList: async () => [],
    depth: "full",
  } as unknown as SyncContext;
  return { ctx, db, cleanup: () => db.close() };
}

/** Minimal mapped-row factory that satisfies upsertIndexedItemForSync. */
function row(id: string) {
  return {
    service: "demo",
    type: "reference" as const,
    externalId: id,
    title: `Item ${id}`,
    modifiedAt: 1_700_000_000_000,
    syncedAt: 1_700_000_000_000,
  };
}

function countItems(db: Database): number {
  const r = db.prepare("SELECT COUNT(*) AS c FROM item").get() as { c: number };
  return r.c;
}

// ---------------------------------------------------------------------------
// Spec builder helpers
// ---------------------------------------------------------------------------

type SimpleCreds = { token: string };

/** Build a minimal valid spec with overridable parts. */
function makeSpec(
  overrides: Partial<PerAppPollSpec<SimpleCreds>> = {},
): PerAppPollSpec<SimpleCreds> {
  return {
    serviceId: "bitrise",
    ensureRunning: async () => {},
    loadCreds: async () => ({ token: "tok" }),
    pass1Cursor: () => "nimbus-test1:pass1",
    appsUrl: () => "https://api.example.com/apps",
    makeHeaders: (c) => ({ Authorization: c.token }),
    extractApps: (parsed) => {
      const root = parsed as Record<string, unknown>;
      return Array.isArray(root["apps"]) ? (root["apps"] as Record<string, unknown>[]) : [];
    },
    getAppId: (row) => (typeof row["id"] === "string" && row["id"] !== "" ? row["id"] : undefined),
    buildsUrl: (id) => `https://api.example.com/builds?appId=${id}`,
    extractBuilds: (parsed) => {
      const root = parsed as Record<string, unknown>;
      return Array.isArray(root["builds"]) ? (root["builds"] as Record<string, unknown>[]) : [];
    },
    mapApp: (appRow, _now) => {
      const id = appRow["id"];
      if (typeof id !== "string" || id === "") return null;
      return row(`app:${id}`);
    },
    mapBuild: (buildRow, _appRow, appId, _now) => {
      const id = buildRow["bid"];
      if (typeof id !== "string" || id === "") return null;
      return row(`build:${appId}/${id}`);
    },
    ...overrides,
  };
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Install a fetch stub and return a restore function. */
function stubFetch(fn: FetchFn): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPerAppPollSync", () => {
  let cleanup: (() => void) | undefined;
  let fetchRestore: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    fetchRestore?.();
    fetchRestore = undefined;
  });

  // --- noop when loadCreds returns null ---
  test("returns noop result when loadCreds returns null", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    const spec = makeSpec({ loadCreds: async () => null });
    const r = await runPerAppPollSync(h.ctx, null, spec);
    expect(r.itemsUpserted).toBe(0);
    expect(r.itemsDeleted).toBe(0);
    expect(r.cursor).toBeNull();
    expect(countItems(h.db)).toBe(0);
  });

  // --- http_error on apps fetch: returns pass cursor, preserves incoming cursor ---
  test("returns pass cursor (incoming) on apps HTTP error", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    fetchRestore = stubFetch(async () => new Response("bad", { status: 503 }));
    const incomingCursor = "nimbus-test1:old";
    const r = await runPerAppPollSync(h.ctx, incomingCursor, makeSpec());
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe(incomingCursor);
    expect(countItems(h.db)).toBe(0);
  });

  // --- http_error on apps fetch with null cursor: returns pass1Cursor ---
  test("returns pass1Cursor when apps HTTP error and cursor is null", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    fetchRestore = stubFetch(async () => new Response("bad", { status: 500 }));
    const r = await runPerAppPollSync(h.ctx, null, makeSpec());
    expect(r.cursor).toBe("nimbus-test1:pass1");
  });

  // --- parse_error on apps fetch ---
  test("returns parse-empty pass cursor on apps parse error", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    fetchRestore = stubFetch(async () => new Response("not-json{{", { status: 200 }));
    const r = await runPerAppPollSync(h.ctx, null, makeSpec());
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe("nimbus-test1:pass1");
    expect(countItems(h.db)).toBe(0);
  });

  // --- apps with empty extractApps result ---
  test("returns success with 0 upserts when extractApps yields no rows", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    fetchRestore = stubFetch(async () => jsonResponse({ apps: [] }));
    const r = await runPerAppPollSync(h.ctx, null, makeSpec());
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe("nimbus-test1:pass1");
  });

  // --- mapApp returns null (no app upserted) but builds still fetched for valid id ---
  test("skips upsert when mapApp returns null but still fetches builds if id is present", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    let buildFetched = false;
    fetchRestore = stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/apps")) {
        return jsonResponse({ apps: [{ id: "app1" }] });
      }
      buildFetched = true;
      return jsonResponse({ builds: [{ bid: "b1" }] });
    });
    const spec = makeSpec({ mapApp: () => null });
    const r = await runPerAppPollSync(h.ctx, null, spec);
    // app not upserted, but build was fetched and upserted
    expect(buildFetched).toBe(true);
    expect(r.itemsUpserted).toBe(1);
    expect(countItems(h.db)).toBe(1);
  });

  // --- getAppId returns undefined → builds fetch skipped ---
  test("skips builds fetch when getAppId returns undefined", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    let buildFetched = false;
    fetchRestore = stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/builds")) {
        buildFetched = true;
        return jsonResponse({ builds: [] });
      }
      return jsonResponse({ apps: [{ id: "" }] }); // empty id → getAppId returns undefined
    });
    const r = await runPerAppPollSync(h.ctx, null, makeSpec());
    expect(buildFetched).toBe(false);
    expect(r.itemsUpserted).toBe(0);
  });

  // --- builds http_error → continue (app still upserted) ---
  test("continues past app when builds fetch returns HTTP error", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    fetchRestore = stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/apps")) {
        return jsonResponse({ apps: [{ id: "app1" }] });
      }
      return new Response("Server Error", { status: 500 });
    });
    const r = await runPerAppPollSync(h.ctx, null, makeSpec());
    // app upserted; builds skipped
    expect(r.itemsUpserted).toBe(1);
    expect(countItems(h.db)).toBe(1);
  });

  // --- builds parse_error → continue ---
  test("continues past app when builds fetch returns non-JSON", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    fetchRestore = stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/apps")) {
        return jsonResponse({ apps: [{ id: "app2" }] });
      }
      return new Response("not-json{{", { status: 200 });
    });
    const r = await runPerAppPollSync(h.ctx, null, makeSpec());
    expect(r.itemsUpserted).toBe(1);
  });

  // --- mapBuild returns null → build skipped ---
  test("skips build rows where mapBuild returns null", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    fetchRestore = stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/apps")) {
        return jsonResponse({ apps: [{ id: "app3" }] });
      }
      // one unmappable (no bid), one valid
      return jsonResponse({ builds: [{ bid: "" }, { bid: "b1" }] });
    });
    const r = await runPerAppPollSync(h.ctx, null, makeSpec());
    // 1 app + 1 valid build
    expect(r.itemsUpserted).toBe(2);
    expect(countItems(h.db)).toBe(2);
  });

  // --- happy path: multiple apps with builds ---
  test("indexes multiple apps and their builds, returns pass1 cursor", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    fetchRestore = stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/apps")) {
        return jsonResponse({ apps: [{ id: "app-a" }, { id: "app-b" }] });
      }
      if (url.includes("appId=app-a")) {
        return jsonResponse({ builds: [{ bid: "b1" }, { bid: "b2" }] });
      }
      return jsonResponse({ builds: [{ bid: "b3" }] });
    });
    const r = await runPerAppPollSync(h.ctx, null, makeSpec());
    // 2 apps + 3 builds = 5
    expect(r.itemsUpserted).toBe(5);
    expect(r.cursor).toBe("nimbus-test1:pass1");
    expect(countItems(h.db)).toBe(5);
  });

  // --- mapBuild receives appRow for context extraction ---
  test("passes appRow to mapBuild so connectors can read app-level fields", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    const capturedAppRows: Record<string, unknown>[] = [];
    fetchRestore = stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/apps")) {
        return jsonResponse({ apps: [{ id: "app-x", name: "MyApp" }] });
      }
      return jsonResponse({ builds: [{ bid: "bx" }] });
    });
    const spec = makeSpec({
      mapBuild: (buildRow, appRow, appId, _now) => {
        capturedAppRows.push(appRow);
        const id = buildRow["bid"];
        if (typeof id !== "string" || id === "") return null;
        return row(`build:${appId}/${id}`);
      },
    });
    await runPerAppPollSync(h.ctx, null, spec);
    expect(capturedAppRows).toHaveLength(1);
    expect(capturedAppRows[0]?.["name"]).toBe("MyApp");
  });

  // --- makeHeaders called with creds ---
  test("passes creds to makeHeaders for each request", async () => {
    const h = makeCtx();
    cleanup = h.cleanup;
    const seenHeaders: string[] = [];
    fetchRestore = stubFetch(async (input, init) => {
      const auth = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      seenHeaders.push(auth);
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/apps")) return jsonResponse({ apps: [{ id: "app1" }] });
      return jsonResponse({ builds: [] });
    });
    await runPerAppPollSync(h.ctx, null, makeSpec());
    // Both apps and builds requests should carry the header
    expect(seenHeaders.every((h) => h === "tok")).toBe(true);
    expect(seenHeaders.length).toBeGreaterThanOrEqual(2);
  });
});
