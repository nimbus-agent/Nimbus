import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import type { EgressEntry } from "./egress-record.ts";
import { egressHead, listEgress, proveWindow, verifyEgressChain } from "./egress-verify.ts";

function e(over: Partial<EgressEntry> = {}): EgressEntry {
  return {
    timestamp: 100,
    sourceType: "task",
    sourceId: "s",
    destination: "email",
    method: "email.send",
    payloadSummary: "{}",
    hitlStatus: "approved",
    resultStatus: "authorized",
    ...over,
  };
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

describe("verifyEgressChain", () => {
  test("an empty ledger verifies ok with 0 rows", () => {
    expect(verifyEgressChain(db)).toEqual({ ok: true, verifiedRows: 0 });
  });
  test("a clean 3-row chain verifies ok", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
    appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
    appendEgressEntry(db, e({ method: "c.z", timestamp: 3 }));
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(true);
    expect(r.verifiedRows).toBe(3);
  });
  test("a tampered row_hash is detected and brokenAt points at it", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
    appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
    const id = (
      db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1`).get() as { id: number }
    ).id;
    db.run(`UPDATE egress_ledger SET destination = 'evil' WHERE id = ?`, [id]);
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(id);
  });
});

describe("egressHead", () => {
  test("reports the head hash and count", () => {
    appendEgressEntry(db, e());
    const h = egressHead(db);
    expect(h.count).toBe(1);
    expect(h.head).toMatch(/^[0-9a-f]{64}$/);
  });
  test("an empty ledger reports the genesis head and count 0", () => {
    const h = egressHead(db);
    expect(h.count).toBe(0);
    expect(h.head).toBe("0".repeat(64));
  });
});

describe("listEgress", () => {
  test("filters by since/until and respects limit", () => {
    appendEgressEntry(db, e({ timestamp: 10 }));
    appendEgressEntry(db, e({ timestamp: 20 }));
    appendEgressEntry(db, e({ timestamp: 30 }));
    expect(listEgress(db, { since: 15, until: 25 })).toHaveLength(1);
    expect(listEgress(db, { limit: 2 })).toHaveLength(2);
  });
});

describe("proveWindow", () => {
  test("a zero-egress window reports outboundEgressEvents 0 and verifies ok", () => {
    const out = proveWindow(db, { since: 0, until: 1000 });
    expect(out.completeness).toEqual({ tier: "authorized-actions", outboundEgressEvents: 0 });
    expect(out.verify.ok).toBe(true);
    expect(out.rows).toHaveLength(0);
  });
  test("a window with one dispatch reports exactly that row", () => {
    appendEgressEntry(db, e({ timestamp: 50, method: "email.send" }));
    const out = proveWindow(db, { since: 0, until: 100 });
    expect(out.completeness.outboundEgressEvents).toBe(1);
    expect(out.rows[0]?.method).toBe("email.send");
  });
});
