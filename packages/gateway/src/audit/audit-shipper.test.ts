import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
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
