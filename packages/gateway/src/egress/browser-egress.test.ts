import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type LedgerableRoute, wrapLedgeredBrowserContext } from "./browser-egress.ts";

const target = { navigateOrigins: ["https://example.com"], scriptOrigins: [] };

interface Captured {
  continued: number;
  aborted: number;
}

function fakeRoute(url: string, resourceType: string, cap: Captured): LedgerableRoute {
  return {
    request: () => ({ url: () => url, resourceType: () => resourceType }),
    continue: async () => {
      cap.continued += 1;
    },
    abort: async () => {
      cap.aborted += 1;
    },
  };
}

function harness() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  let handler: ((r: LedgerableRoute) => Promise<void>) | undefined;
  const ctx = {
    route: async (_p: string, h: (r: LedgerableRoute) => Promise<void>) => {
      handler = h;
    },
  };
  const wrapped = wrapLedgeredBrowserContext(ctx, {
    db,
    sessionId: "s1",
    target,
    now: () => 1000,
  });
  return {
    db,
    wrapped,
    fire: async (r: LedgerableRoute) => {
      await handler?.(r);
    },
  };
}

function rows(db: Database) {
  return db
    .query<{ destination: string; result_status: string; method: string }, []>(
      `SELECT destination, result_status, method FROM egress_ledger WHERE source_type='browser' ORDER BY id`,
    )
    .all();
}

describe("wrapLedgeredBrowserContext", () => {
  test("appends one authorized row per distinct origin and continues the request", async () => {
    const h = harness();
    await h.wrapped.route("**/*", async () => {});
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://example.com/a", "document", cap));
    expect(rows(h.db)).toEqual([
      {
        destination: "https://example.com",
        result_status: "authorized",
        method: "browser.request",
      },
    ]);
    expect(cap.continued).toBe(1);
  });

  test("DEDUPES by origin — one row per distinct origin, not per request", async () => {
    const h = harness();
    await h.wrapped.route("**/*", async () => {});
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://example.com/a", "document", cap));
    await h.fire(fakeRoute("https://example.com/b", "image", cap));
    await h.fire(fakeRoute("https://example.com/c", "image", cap));
    expect(rows(h.db).length).toBe(1);
    expect(cap.continued).toBe(3);
  });

  test("a passive subresource from a THIRD-PARTY origin gets its own row", async () => {
    const h = harness();
    await h.wrapped.route("**/*", async () => {});
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://cdn.other.example/x.png", "image", cap));
    expect(rows(h.db)).toEqual([
      {
        destination: "https://cdn.other.example",
        result_status: "authorized",
        method: "browser.request",
      },
    ]);
  });

  test("a refused request appends a BLOCKED row and aborts", async () => {
    const h = harness();
    await h.wrapped.route("**/*", async () => {});
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://evil.com/collect", "fetch", cap));
    expect(rows(h.db)).toEqual([
      { destination: "https://evil.com", result_status: "blocked", method: "browser.request" },
    ]);
    expect(cap.aborted).toBe(1);
    expect(cap.continued).toBe(0);
  });

  test("an append failure ABORTS the request — fail-closed", async () => {
    // The whole point of appending BEFORE the request: a zero-row window must mean no request was
    // made, never that one was made unrecorded. Assert the CALL COUNT, not just that it threw.
    const h = harness();
    h.db.close(); // any append now throws
    await h.wrapped.route("**/*", async () => {});
    const cap: Captured = { continued: 0, aborted: 0 };
    await expect(h.fire(fakeRoute("https://example.com/a", "document", cap))).rejects.toThrow();
    expect(cap.continued).toBe(0);
  });

  test("never stores a full URL — only the origin", async () => {
    const h = harness();
    await h.wrapped.route("**/*", async () => {});
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://example.com/p?token=SECRET", "document", cap));
    const all = h.db
      .query<{ destination: string; payload_summary: string }, []>(
        `SELECT destination, payload_summary FROM egress_ledger`,
      )
      .all();
    for (const r of all) {
      expect(r.destination).not.toContain("SECRET");
      expect(r.payload_summary).not.toContain("SECRET");
    }
  });
});
