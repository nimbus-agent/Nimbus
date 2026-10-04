import { Database } from "bun:sqlite";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  AUDIT_SHIP_BATCH_LIMIT,
  AUDIT_SHIP_INTERVAL_MS,
  type AuditMetaRow,
  type AuditShipperHandle,
  currentAuditCursor,
  fetchAuditMetaSince,
  shipBatch,
  startAuditShipper,
  toShippableLine,
} from "./audit-shipper.ts";

const rows: AuditMetaRow[] = [
  {
    id: 1,
    actionType: "policy.applied",
    hitlStatus: "not_required",
    hash: "abc",
    timestamp: 100,
    actionJson: '{"secret":"x"}',
  },
];

describe("audit-shipper", () => {
  test("toShippableLine emits metadata ONLY — never actionJson", () => {
    const line = JSON.parse(toShippableLine(rows[0] as AuditMetaRow));
    expect(line).toEqual({
      id: 1,
      actionType: "policy.applied",
      hitlStatus: "not_required",
      hash: "abc",
      timestamp: 100,
    });
    expect(JSON.stringify(line)).not.toContain("secret");
  });

  test("shipBatch POSTs NDJSON and returns the count shipped", async () => {
    let body = "";
    const n = await shipBatch(rows, {
      shipTo: "https://siem/x",
      post: async (_u, b) => {
        body = b;
        return true;
      },
    });
    expect(n).toBe(1);
    expect(body.trim().split("\n")).toHaveLength(1);
    expect(body).not.toContain("secret");
  });

  test("shipBatch returns 0 and does not throw when the POST fails", async () => {
    const n = await shipBatch(rows, { shipTo: "https://siem/x", post: async () => false });
    expect(n).toBe(0);
  });

  test("empty batch ships nothing", async () => {
    expect(await shipBatch([], { shipTo: "https://siem/x", post: async () => true })).toBe(0);
  });
});

/** A `:memory:` db migrated to the audit-log schema, optionally pre-seeded with `n` audit rows. */
function auditDb(n = 0): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 37);
  for (let i = 0; i < n; i++) {
    appendAuditEntry(db, {
      actionType: `policy.applied.${i}`,
      hitlStatus: "not_required",
      actionJson: '{"secret":"never-shipped"}',
      timestamp: 1000 + i,
    });
  }
  return db;
}

describe("currentAuditCursor", () => {
  test("empty db => 0", () => {
    expect(currentAuditCursor(auditDb(0))).toBe(0);
  });

  test("after seeding N rows => max id", () => {
    expect(currentAuditCursor(auditDb(3))).toBe(3);
  });
});

describe("fetchAuditMetaSince", () => {
  test("returns rows with id > cursor mapped to AuditMetaRow (row_hash -> hash), no action_json", () => {
    const db = auditDb(3);
    const rows = fetchAuditMetaSince(db, 1, 500);
    expect(rows.map((r) => r.id)).toEqual([2, 3]);
    for (const r of rows) {
      expect(r.actionType).toMatch(/^policy\.applied\./);
      expect(r.hitlStatus).toBe("not_required");
      expect(typeof r.hash).toBe("string");
      expect(r.hash.length).toBeGreaterThan(0);
      expect(r.actionJson).toBeUndefined();
      expect(Object.keys(r).sort((a, b) => a.localeCompare(b))).toEqual([
        "actionType",
        "hash",
        "hitlStatus",
        "id",
        "timestamp",
      ]);
    }
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  test("respects the limit", () => {
    const db = auditDb(5);
    const rows = fetchAuditMetaSince(db, 0, 2);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("startAuditShipper", () => {
  let handle: AuditShipperHandle | undefined;

  afterEach(() => {
    // CRITICAL: stop the interval so no setInterval leaks (the test run must exit cleanly).
    handle?.stop();
    handle = undefined;
  });

  test("forward-only: baselines at MAX(id) on start, so pre-existing rows are never shipped", async () => {
    const db = auditDb(2); // cursor baselines at MAX(id)=2
    const posted: string[] = [];
    handle = startAuditShipper(db, {
      shipTo: "https://siem/x",
      intervalMs: 20,
      post: async (_u, ndjson) => {
        posted.push(ndjson);
        return true;
      },
    });
    // No new rows appended after start => nothing past the cursor => nothing shipped.
    await new Promise((r) => setTimeout(r, 60));
    expect(posted).toEqual([]);
  });

  test("ships rows appended after start; cursor advances so the next tick ships nothing", async () => {
    const db = auditDb(0); // empty => cursor baselines at 0
    let shipCount = 0;
    const bodies: string[] = [];
    handle = startAuditShipper(db, {
      shipTo: "https://siem/x",
      intervalMs: 20,
      post: async (_u, ndjson) => {
        shipCount++;
        bodies.push(ndjson);
        return true;
      },
    });
    appendAuditEntry(db, {
      actionType: "policy.applied.a",
      hitlStatus: "not_required",
      actionJson: '{"secret":"x"}',
      timestamp: 100,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(shipCount).toBeGreaterThanOrEqual(1);
    expect(bodies.join("")).toContain("policy.applied.a");
    expect(bodies.join("")).not.toContain("secret");
    const afterFirst = shipCount;
    // No new rows; the cursor advanced, so further ticks ship nothing (count holds).
    await new Promise((r) => setTimeout(r, 60));
    expect(shipCount).toBe(afterFirst);
  });

  test("a failing post (returns false) does NOT advance the cursor — rows retried next tick", async () => {
    const db = auditDb(0);
    let attempts = 0;
    handle = startAuditShipper(db, {
      shipTo: "https://siem/x",
      intervalMs: 20,
      post: async () => {
        attempts++;
        return false; // ship fails
      },
    });
    appendAuditEntry(db, {
      actionType: "policy.applied.retry",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 100,
    });
    await new Promise((r) => setTimeout(r, 90));
    // The same row is retried on each tick because the cursor never advanced.
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});

describe("currentAuditCursor without an audit_log table", () => {
  test("baselines at 0 instead of throwing", () => {
    const bare = new Database(":memory:");
    try {
      expect(currentAuditCursor(bare)).toBe(0);
    } finally {
      bare.close();
    }
  });
});

/**
 * The defaults — cadence, batch limit and the real `fetch`-based POST — driven deterministically:
 * a fake clock fires each tick exactly when the test says so, and a fake `fetch` stands in for the
 * SIEM endpoint. A tick runs synchronously up to its first await, so the POST it makes is visible
 * the moment `advanceTimersByTime` returns; `settle()` then lets the rest of that tick (its awaits
 * are all on already-settled promises) finish, including the cursor update.
 */
describe("startAuditShipper — defaults (fake clock, fake fetch)", () => {
  const realFetch = globalThis.fetch;
  const SHIP_TO = "https://siem.example/ingest";
  let shipper: AuditShipperHandle | undefined;
  let db: Database | undefined;

  afterEach(() => {
    shipper?.stop();
    shipper = undefined;
    jest.useRealTimers();
    globalThis.fetch = realFetch;
    db?.close();
    db = undefined;
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  /**
   * Stops the shipper, restores the real clock and yields ONE real macrotask. The interval runs each
   * tick as `void tick()`, so a rejection the tick failed to catch stays invisible while the test
   * only settles microtasks; bun:test reports it (failing the running test) once the event loop
   * turns. Without this step, a "the tick swallows its failure" assertion passes even when the tick's
   * own catch is deleted.
   */
  async function stopAndSurfaceEscapedRejections(): Promise<void> {
    shipper?.stop();
    shipper = undefined;
    jest.useRealTimers();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  function append(target: Database, actionType: string): void {
    appendAuditEntry(target, {
      actionType,
      hitlStatus: "not_required",
      actionJson: '{"secret":"never-shipped"}',
      timestamp: 1_000,
    });
  }

  function lines(ndjson: string | undefined): string[] {
    return (ndjson ?? "").split("\n").filter((l) => l !== "");
  }

  type FetchCall = { url: string; init: RequestInit | undefined };

  /** Replaces `fetch` with a recorder answering every call via `respond`. */
  function fakeFetch(respond: () => Response): FetchCall[] {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond();
    }) as unknown as typeof fetch;
    return calls;
  }

  test("ships on the default AUDIT_SHIP_INTERVAL_MS cadence, and not a millisecond before", () => {
    db = auditDb(0);
    jest.useFakeTimers();
    const posted: string[] = [];
    shipper = startAuditShipper(db, {
      shipTo: SHIP_TO,
      post: async (_u, ndjson) => {
        posted.push(ndjson);
        return true;
      },
    });
    append(db, "policy.applied.cadence");

    jest.advanceTimersByTime(AUDIT_SHIP_INTERVAL_MS - 1);
    expect(posted).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("policy.applied.cadence");
  });

  test("caps a tick at the default AUDIT_SHIP_BATCH_LIMIT rows; the remainder ships next tick", async () => {
    db = auditDb(0);
    jest.useFakeTimers();
    const bodies: string[] = [];
    shipper = startAuditShipper(db, {
      shipTo: SHIP_TO,
      intervalMs: 1_000,
      post: async (_u, ndjson) => {
        bodies.push(ndjson);
        return true;
      },
    });
    for (let i = 0; i <= AUDIT_SHIP_BATCH_LIMIT; i++) append(db, `policy.applied.${i}`);

    jest.advanceTimersByTime(1_000);
    expect(lines(bodies[0])).toHaveLength(AUDIT_SHIP_BATCH_LIMIT);
    await settle();
    jest.advanceTimersByTime(1_000);
    expect(bodies).toHaveLength(2);
    const rest = lines(bodies[1]);
    expect(rest).toHaveLength(1);
    expect((JSON.parse(rest[0] ?? "{}") as { id: number }).id).toBe(AUDIT_SHIP_BATCH_LIMIT + 1);
  });

  test("the default POST sends metadata-only NDJSON as application/x-ndjson; a 2xx advances the cursor", async () => {
    db = auditDb(0);
    jest.useFakeTimers();
    const calls = fakeFetch(() => new Response(null, { status: 202 }));
    shipper = startAuditShipper(db, { shipTo: SHIP_TO, intervalMs: 1_000 });
    append(db, "policy.applied.first");

    jest.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first?.url).toBe(SHIP_TO);
    expect(first?.init?.method).toBe("POST");
    expect(first?.init?.headers).toEqual({ "content-type": "application/x-ndjson" });
    const body = String(first?.init?.body);
    expect(body.endsWith("\n")).toBe(true);
    expect((JSON.parse(lines(body)[0] ?? "{}") as { actionType: string }).actionType).toBe(
      "policy.applied.first",
    );
    expect(body).not.toContain("secret");

    await settle();
    // The 202 counted as shipped: an idle tick re-sends nothing...
    jest.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(1);
    // ...and the next new row ships on its own.
    append(db, "policy.applied.second");
    jest.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(2);
    const second = String(calls[1]?.init?.body);
    expect(second).toContain("policy.applied.second");
    expect(second).not.toContain("policy.applied.first");
  });

  test("a non-2xx response is a failed ship: the cursor holds and the same rows are re-sent", async () => {
    db = auditDb(0);
    jest.useFakeTimers();
    const calls = fakeFetch(() => new Response("busy", { status: 503 }));
    shipper = startAuditShipper(db, { shipTo: SHIP_TO, intervalMs: 1_000 });
    append(db, "policy.applied.retry");

    jest.advanceTimersByTime(1_000);
    await settle();
    jest.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.init?.body)).toBe(String(calls[0]?.init?.body));
    expect(String(calls[1]?.init?.body)).toContain("policy.applied.retry");
  });

  test("a fetch that throws is a failed ship, never an escaped rejection", async () => {
    db = auditDb(0);
    jest.useFakeTimers();
    const attempts: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      attempts.push(String(init?.body));
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    shipper = startAuditShipper(db, { shipTo: SHIP_TO, intervalMs: 1_000 });
    append(db, "policy.applied.offline");
    jest.advanceTimersByTime(1_000);
    await settle();
    jest.advanceTimersByTime(1_000);
    // A rejection escaping either tick fails THIS test here, rather than passing unseen.
    await stopAndSurfaceEscapedRejections();

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(attempts[0]).toContain("policy.applied.offline");
  });

  test("a tick that throws (no audit_log table) is swallowed and posts nothing", async () => {
    db = new Database(":memory:");
    jest.useFakeTimers();
    let posts = 0;
    shipper = startAuditShipper(db, {
      shipTo: SHIP_TO,
      intervalMs: 1_000,
      post: async () => {
        posts += 1;
        return true;
      },
    });
    // The tick's first query throws ("no such table: audit_log"). The tick runs as `void tick()`, so
    // `advanceTimersByTime` cannot throw either way: only turning the event loop shows whether the
    // failure was swallowed or escaped.
    jest.advanceTimersByTime(1_000);
    await stopAndSurfaceEscapedRejections();
    expect(posts).toBe(0);
  });
});
