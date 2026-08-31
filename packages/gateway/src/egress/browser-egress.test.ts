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

  test("the SAME origin gets TWO rows when the verdict differs — dedupe key is (origin, verdict), not origin alone", async () => {
    // A passive image request from an unapproved origin is allowed (PASSIVE subresources are
    // allowed from any origin), while a script-initiated fetch to that SAME unapproved origin is
    // refused (neither navigateOrigins nor scriptOrigins lists it). If the dedupe key were ever
    // simplified back to origin-only, the second row below would silently vanish — the exact
    // regression this test exists to catch, since a cluster of BLOCKED rows naming an unapproved
    // origin is the clearest signal of exfiltration and must never be suppressed by an earlier
    // ALLOWED row for the same origin.
    const h = harness();
    await h.wrapped.route("**/*", async () => {});
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://cdn.other.example/x.png", "image", cap));
    await h.fire(fakeRoute("https://cdn.other.example/collect", "fetch", cap));
    expect(rows(h.db)).toEqual([
      {
        destination: "https://cdn.other.example",
        result_status: "authorized",
        method: "browser.request",
      },
      {
        destination: "https://cdn.other.example",
        result_status: "blocked",
        method: "browser.request",
      },
    ]);
    expect(cap.continued).toBe(1);
    expect(cap.aborted).toBe(1);
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

  test("the caller-supplied handler is invoked on an ALLOWED request, never discarded", async () => {
    // Review finding: `route: async (pattern, _handler) => {...}` used to accept then silently
    // drop the handler entirely — a future browser-driver caller's routing logic would vanish
    // with no error. The wrapper still decides continue/abort itself; the handler must still run.
    const h = harness();
    let handlerCalls = 0;
    await h.wrapped.route("**/*", async () => {
      handlerCalls += 1;
    });
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://example.com/a", "document", cap));
    expect(handlerCalls).toBe(1);
    expect(cap.continued).toBe(1); // the wrapper's own continue() still fires
  });

  test("the caller-supplied handler is NEVER invoked on a BLOCKED request — the block is structural", async () => {
    const h = harness();
    let handlerCalls = 0;
    await h.wrapped.route("**/*", async () => {
      handlerCalls += 1;
    });
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://evil.com/collect", "fetch", cap));
    expect(handlerCalls).toBe(0);
    expect(cap.aborted).toBe(1);
  });

  test("a PascalCase CDP resource type is GUARDED into the policy's vocabulary, not cast", () => {
    // The live defect the guard closed. `Fetch.requestPaused` reports `"Document"`; the union is
    // `playwright-core`-shaped lowercase. Under the `as CuResourceType` cast this replaced, every
    // real CDP type missed BOTH `PASSIVE` and `SCRIPT_INITIATED`, so the page's own document fell
    // to the gated branch and the lane could not render the origin its owner had just approved.
    return (async () => {
      const h = harness();
      await h.wrapped.route("**/*", async () => {});
      const cap: Captured = { continued: 0, aborted: 0 };
      await h.fire(fakeRoute("https://example.com/", "Document", cap));
      expect(cap.continued).toBe(1);
      expect(cap.aborted).toBe(0);
      const row = h.db
        .query<{ result_status: string }, []>(`SELECT result_status FROM egress_ledger`)
        .get();
      expect(row?.result_status).toBe("authorized");
    })();
  });

  test("an UNRECOGNISED resource type fails closed into the gated branch", async () => {
    // `Ping` (navigator.sendBeacon / <a ping>) is deliberately unmapped: it is a fire-and-forget
    // outbound POST, i.e. exactly the convenient exfiltration channel section 3.5.1 exists to
    // close. Folding it into a PASSIVE member "because it is a subresource" would reopen it.
    const h = harness();
    await h.wrapped.route("**/*", async () => {});
    const cap: Captured = { continued: 0, aborted: 0 };
    await h.fire(fakeRoute("https://evil.example/beacon", "Ping", cap));
    expect(cap.aborted).toBe(1);
    expect(cap.continued).toBe(0);
  });

  test("the RAW protocol string is what reaches payload_summary, not the substituted word", () => {
    // An operator reading a blocked row must see what the protocol actually said. Recording the
    // fallback (`other`) would hide which type was refused.
    return (async () => {
      const h = harness();
      await h.wrapped.route("**/*", async () => {});
      const cap: Captured = { continued: 0, aborted: 0 };
      await h.fire(fakeRoute("https://evil.example/beacon", "Ping", cap));
      const row = h.db
        .query<{ payload_summary: string }, []>(`SELECT payload_summary FROM egress_ledger`)
        .get();
      expect(row?.payload_summary.startsWith("Ping:")).toBe(true);
      expect(row?.payload_summary.startsWith("other:")).toBe(false);
    })();
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
