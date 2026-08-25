import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { LocalIndex } from "../../index/local-index.ts";
import { ProviderRateLimiter } from "../../sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../sync/sync-capabilities.ts";
import type { SyncContext } from "../../sync/types.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { FetchOutcome } from "./fetch-outcome.ts";
import {
  bareArrayPage,
  type PaginatedSyncSpec,
  runSinglePassPaginatedSync,
  upsertMapped,
} from "./paginated-sync.ts";

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

function row(externalId: string) {
  return {
    service: "demo",
    type: "reference" as const,
    externalId,
    title: `Item ${externalId}`,
    modifiedAt: 1_700_000_000_000,
    syncedAt: 1_700_000_000_000,
  };
}

describe("upsertMapped", () => {
  let h: ReturnType<typeof makeCtx> | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("maps + upserts non-null rows and counts them; skips nulls", () => {
    h = makeCtx();
    const raw = [{ id: "1" }, { id: "skip" }, { id: "2" }];
    const count = upsertMapped(h.ctx, raw, (r) => {
      const id = (r as { id: string }).id;
      return id === "skip" ? null : row(id);
    });
    expect(count).toBe(2);
    const ids = h.db
      .query<{ external_id: string }, [string]>(
        "SELECT external_id FROM item WHERE service = ? ORDER BY external_id",
      )
      .all("demo")
      .map((x) => x.external_id);
    expect(ids).toEqual(["1", "2"]);
  });

  test("empty input → 0, no rows", () => {
    h = makeCtx();
    expect(upsertMapped(h.ctx, [], () => row("x"))).toBe(0);
    const n = h.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM item").get();
    expect(n?.c).toBe(0);
  });
});

const ok = (parsed: unknown, bytes = 10): FetchOutcome => ({ kind: "ok", parsed, bytes });
const httpErr = (bytes = 3): FetchOutcome => ({ kind: "http_error", bytes, status: 503 });
const parseErr = (bytes = 3): FetchOutcome => ({ kind: "parse_error", bytes });

function baseSpec(over: Partial<PaginatedSyncSpec<{ ok: true }>>): PaginatedSyncSpec<{ ok: true }> {
  return {
    ensureRunning: async () => {},
    loadCreds: async () => ({ ok: true }),
    pass1Cursor: () => "nimbus-demo1:abc",
    maxPages: 20,
    startPage: 1,
    fetchPage: async () => ok([]),
    parsePage: (parsed) => bareArrayPage(parsed, 2),
    map: (raw) => row((raw as { id: string }).id),
    ...over,
  };
}

describe("bareArrayPage", () => {
  test("non-array → empty, no more", () => {
    expect(bareArrayPage({ not: "array" }, 2)).toEqual({ items: [], hasMore: false });
  });
  test("full page (length >= pageSize) → hasMore true", () => {
    expect(bareArrayPage([{ id: "1" }, { id: "2" }], 2)).toEqual({
      items: [{ id: "1" }, { id: "2" }],
      hasMore: true,
    });
  });
  test("short page → hasMore false", () => {
    expect(bareArrayPage([{ id: "1" }], 2).hasMore).toBe(false);
  });
});

describe("runSinglePassPaginatedSync", () => {
  let h: ReturnType<typeof makeCtx> | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("unconfigured creds → noop, incoming cursor preserved, no fetch", async () => {
    h = makeCtx();
    let fetched = 0;
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      "incoming-cursor",
      baseSpec({
        loadCreds: async () => null,
        fetchPage: async () => {
          fetched += 1;
          return ok([]);
        },
      }),
    );
    expect(fetched).toBe(0);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("incoming-cursor");
  });

  test("happy multi-page walk: stops on short page, accumulates bytes + upserts", async () => {
    h = makeCtx();
    const pages: FetchOutcome[] = [ok([{ id: "a" }, { id: "b" }], 100), ok([{ id: "c" }], 40)];
    let i = 0;
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({ fetchPage: async () => pages[i++] ?? ok([]) }),
    );
    expect(res.itemsUpserted).toBe(3);
    expect(res.bytesTransferred).toBe(140);
    expect(res.cursor).toBe("nimbus-demo1:abc");
    expect(res.hasMore).toBe(false);
  });

  test("first-page http_error → http-empty result with incoming cursor", async () => {
    h = makeCtx();
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      "keep-me",
      baseSpec({ fetchPage: async () => httpErr(7) }),
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("keep-me");
    expect(res.bytesTransferred).toBe(7);
  });

  test("first-page parse_error → parse-empty result with default cursor", async () => {
    h = makeCtx();
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      "ignored",
      baseSpec({ fetchPage: async () => parseErr(5) }),
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("nimbus-demo1:abc");
  });

  test("error on a non-first page → break, success with items so far", async () => {
    h = makeCtx();
    const pages: FetchOutcome[] = [ok([{ id: "a" }, { id: "b" }], 50), httpErr(4)];
    let i = 0;
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({ fetchPage: async () => pages[i++] ?? ok([]) }),
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe("nimbus-demo1:abc");
    expect(res.bytesTransferred).toBe(54);
  });

  test("maxPages caps the walk", async () => {
    h = makeCtx();
    let fetched = 0;
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({
        maxPages: 3,
        // always a full page → would loop forever without the cap
        fetchPage: async () => {
          fetched += 1;
          return ok([{ id: `x${fetched}` }, { id: `y${fetched}` }], 10);
        },
      }),
    );
    expect(fetched).toBe(3);
    expect(res.itemsUpserted).toBe(6);
  });

  test("startPage 0 passes 0-based page numbers to fetchPage", async () => {
    h = makeCtx();
    const seen: number[] = [];
    await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({
        startPage: 0,
        maxPages: 2,
        fetchPage: async (_creds, page) => {
          seen.push(page);
          return ok([]); // empty → stop after first
        },
      }),
    );
    expect(seen).toEqual([0]);
  });

  test("continuation-token: nextPageCursor threads into the next fetchPage call", async () => {
    h = makeCtx();
    const seenCursors: string[] = [];
    // Page A returns token "t1"; page B returns "" (stop).
    const byCursor: Record<string, FetchOutcome> = {
      "": ok({ items: [{ id: "a" }], next: "t1" }, 20),
      t1: ok({ items: [{ id: "b" }], next: "" }, 15),
    };
    const res = await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({
        fetchPage: async (_creds, _page, pageCursor) => {
          seenCursors.push(pageCursor);
          return byCursor[pageCursor] ?? ok({ items: [], next: "" });
        },
        parsePage: (parsed) => {
          const p = parsed as { items: { id: string }[]; next: string };
          return {
            items: p.items,
            hasMore: p.items.length > 0 && p.next !== "",
            nextPageCursor: p.next,
          };
        },
      }),
    );
    expect(seenCursors).toEqual(["", "t1"]);
    expect(res.itemsUpserted).toBe(2);
  });

  test("map receives creds (for creds-derived mapping context)", async () => {
    h = makeCtx();
    const seenCreds: unknown[] = [];
    await runSinglePassPaginatedSync(
      h.ctx,
      null,
      baseSpec({
        loadCreds: async () => ({ ok: true }),
        fetchPage: async () => ok([{ id: "a" }]), // short page → one pass
        map: (raw, creds) => {
          seenCreds.push(creds);
          return row((raw as { id: string }).id);
        },
      }),
    );
    expect(seenCreds).toEqual([{ ok: true }]);
  });
});
