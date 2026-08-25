import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { LocalIndex } from "../../index/local-index.ts";
import { ProviderRateLimiter } from "../../sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../sync/sync-capabilities.ts";
import type { SyncContext } from "../../sync/types.ts";
import { createMockVault } from "../../vault/mock.ts";
import {
  type CliShellOutcome,
  type CliShellSyncSpec,
  isSafeCliArg,
  runSinglePassCliShellSync,
} from "./cli-shell-sync.ts";
import type { SyncUpsertRow } from "./paginated-sync.ts";

// ---------------------------------------------------------------------------
// Test context factory
// ---------------------------------------------------------------------------

function makeCtx(): { ctx: SyncContext; db: Database; cleanup: () => void } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const ctx = {
    ...buildSyncCapabilities({ vault: createMockVault(), db, depth: "full" }, "github"),
    vault: createMockVault(),
    db,
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({}),
    depth: "full",
  } as unknown as SyncContext;
  return { ctx, db, cleanup: () => db.close() };
}

function row(externalId: string): SyncUpsertRow {
  return {
    service: "demo",
    type: "reference" as const,
    externalId,
    title: `Item ${externalId}`,
    modifiedAt: 1_700_000_000_000,
    syncedAt: 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// CliShellOutcome builders
// ---------------------------------------------------------------------------

const ok = (items: unknown[], bytes?: number): CliShellOutcome => ({
  ok: true,
  text: JSON.stringify(items),
  ...(bytes !== undefined ? { bytes } : {}),
});
const okText = (text: string, bytes?: number): CliShellOutcome => ({
  ok: true,
  text,
  ...(bytes !== undefined ? { bytes } : {}),
});
const errOut = (text = "error", bytes?: number): CliShellOutcome => ({
  ok: false,
  text,
  ...(bytes !== undefined ? { bytes } : {}),
});

// ---------------------------------------------------------------------------
// Fake spec builder
// ---------------------------------------------------------------------------

function baseSpec(over: Partial<CliShellSyncSpec<{ ok: true }>>): CliShellSyncSpec<{ ok: true }> {
  return {
    ensureRunning: async () => {},
    loadCreds: async () => ({ ok: true }),
    pass1Cursor: () => "nimbus-demo1:abc",
    maxPages: 20,
    runCliPage: async () => ok([]),
    parsePage: (text) => {
      let items: unknown[] = [];
      try {
        const p = JSON.parse(text) as unknown;
        items = Array.isArray(p) ? p : [];
      } catch {
        // empty
      }
      return { items, hasMore: false };
    },
    map: (raw) => row((raw as { id: string }).id),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// isSafeCliArg tests
// ---------------------------------------------------------------------------

describe("isSafeCliArg", () => {
  test("rejects empty string", () => {
    expect(isSafeCliArg("")).toBe(false);
  });

  test("rejects string longer than 1024 chars", () => {
    expect(isSafeCliArg("a".repeat(1025))).toBe(false);
  });

  test("accepts string of exactly 1024 chars", () => {
    expect(isSafeCliArg("a".repeat(1024))).toBe(true);
  });

  test("rejects string starting with dash", () => {
    expect(isSafeCliArg("-flag")).toBe(false);
    expect(isSafeCliArg("--flag")).toBe(false);
  });

  test("rejects string containing control character (< 0x20)", () => {
    expect(isSafeCliArg("hello\x00world")).toBe(false);
    expect(isSafeCliArg("hello\x1fworld")).toBe(false);
    expect(isSafeCliArg("\t tab")).toBe(false); // 0x09 < 0x20
  });

  test("accepts normal ASCII value", () => {
    expect(isSafeCliArg("us-east-1")).toBe(true);
    expect(isSafeCliArg("my-model-name")).toBe(true);
    expect(isSafeCliArg("projects/my-project/models/abc")).toBe(true);
  });

  test("accepts a space (0x20 is NOT < 0x20, boundary is exclusive)", () => {
    expect(isSafeCliArg("hello world")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runSinglePassCliShellSync tests
// ---------------------------------------------------------------------------

describe("runSinglePassCliShellSync", () => {
  let h: ReturnType<typeof makeCtx> | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("unconfigured creds (loadCreds → null) → noop, incoming cursor preserved, no CLI call", async () => {
    h = makeCtx();
    let called = 0;
    const res = await runSinglePassCliShellSync(
      h.ctx,
      "incoming-cursor",
      baseSpec({
        loadCreds: async () => null,
        runCliPage: async () => {
          called += 1;
          return ok([]);
        },
      }),
    );
    expect(called).toBe(0);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("incoming-cursor");
  });

  test("single page with items: maps + upserts all, returns pass1Cursor", async () => {
    h = makeCtx();
    const res = await runSinglePassCliShellSync(
      h.ctx,
      null,
      baseSpec({
        runCliPage: async () => ok([{ id: "a" }, { id: "b" }]),
      }),
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe("nimbus-demo1:abc");
    expect(res.hasMore).toBe(false);
  });

  test("multi-page via nextPageCursor: threads cursor correctly and accumulates upserts", async () => {
    h = makeCtx();
    const seenCursors: string[] = [];
    const pages: Record<string, CliShellOutcome> = {
      "": okText(JSON.stringify({ items: [{ id: "a" }], next: "tok1" })),
      tok1: okText(JSON.stringify({ items: [{ id: "b" }], next: "" })),
    };
    const res = await runSinglePassCliShellSync(
      h.ctx,
      null,
      baseSpec({
        runCliPage: async (_creds, _page, pageCursor) => {
          seenCursors.push(pageCursor);
          return pages[pageCursor] ?? ok([]);
        },
        parsePage: (text) => {
          const p = JSON.parse(text) as { items: { id: string }[]; next: string };
          return {
            items: p.items,
            hasMore: p.next !== "",
            nextPageCursor: p.next,
          };
        },
      }),
    );
    expect(seenCursors).toEqual(["", "tok1"]);
    expect(res.itemsUpserted).toBe(2);
  });

  test("first-page ok:false → parse-empty result with pass1Cursor", async () => {
    h = makeCtx();
    const res = await runSinglePassCliShellSync(
      h.ctx,
      "keep-me",
      baseSpec({ runCliPage: async () => errOut("access denied") }),
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("nimbus-demo1:abc"); // syncPassCursorParseEmpty uses pass1Cursor
    expect(res.bytesTransferred).toBeGreaterThan(0);
  });

  test("non-first-page ok:false → break, returns success with items so far", async () => {
    h = makeCtx();
    let i = 0;
    const responses: CliShellOutcome[] = [
      okText(JSON.stringify({ items: [{ id: "a" }], next: "tok1" })),
      errOut("throttled"),
    ];
    const res = await runSinglePassCliShellSync(
      h.ctx,
      null,
      baseSpec({
        runCliPage: async () => responses[i++] ?? ok([]),
        parsePage: (text) => {
          const p = JSON.parse(text) as { items: { id: string }[]; next: string };
          return { items: p.items, hasMore: p.next !== "", nextPageCursor: p.next };
        },
      }),
    );
    expect(res.itemsUpserted).toBe(1);
    expect(res.cursor).toBe("nimbus-demo1:abc");
  });

  test("null-mapped items are skipped (map returns null)", async () => {
    h = makeCtx();
    const res = await runSinglePassCliShellSync(
      h.ctx,
      null,
      baseSpec({
        runCliPage: async () => ok([{ id: "keep" }, { id: "skip" }]),
        map: (raw) => {
          const id = (raw as { id: string }).id;
          return id === "skip" ? null : row(id);
        },
      }),
    );
    expect(res.itemsUpserted).toBe(1);
  });

  test("maxPages caps the walk", async () => {
    h = makeCtx();
    let called = 0;
    const res = await runSinglePassCliShellSync(
      h.ctx,
      null,
      baseSpec({
        maxPages: 3,
        runCliPage: async () => {
          called += 1;
          return okText(JSON.stringify({ items: [{ id: `x${called}` }], next: "more" }));
        },
        parsePage: (text) => {
          const p = JSON.parse(text) as { items: unknown[]; next: string };
          return { items: p.items, hasMore: true, nextPageCursor: p.next };
        },
      }),
    );
    expect(called).toBe(3);
    expect(res.itemsUpserted).toBe(3);
  });

  test("bytes accounting: uses outcome.bytes when provided, falls back to text.length", async () => {
    h = makeCtx();
    const res = await runSinglePassCliShellSync(
      h.ctx,
      null,
      baseSpec({
        // bytes=100 explicitly provided, text.length would be different
        runCliPage: async () => ok([], 100),
      }),
    );
    expect(res.bytesTransferred).toBe(100);
  });

  test("bytes accounting fallback: uses text.length when bytes omitted", async () => {
    h = makeCtx();
    const text = JSON.stringify([]);
    const res = await runSinglePassCliShellSync(
      h.ctx,
      null,
      baseSpec({
        runCliPage: async () => ({ ok: true, text }), // no bytes field
      }),
    );
    expect(res.bytesTransferred).toBe(text.length);
  });

  test("map receives creds for context-derived mapping", async () => {
    h = makeCtx();
    const seenCreds: unknown[] = [];
    await runSinglePassCliShellSync(
      h.ctx,
      null,
      baseSpec({
        runCliPage: async () => ok([{ id: "a" }]),
        map: (raw, creds) => {
          seenCreds.push(creds);
          return row((raw as { id: string }).id);
        },
      }),
    );
    expect(seenCreds).toEqual([{ ok: true }]);
  });
});
