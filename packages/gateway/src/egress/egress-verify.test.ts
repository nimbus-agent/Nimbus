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
  test("a tampered data field is detected via row_hash mismatch", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
    appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
    const id = (
      db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1`).get() as { id: number }
    ).id;
    db.run(`UPDATE egress_ledger SET destination = 'evil' WHERE id = ?`, [id]);
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(id);
    expect(r.reason).toMatch(/row_hash mismatch/);
  });
  test("a post-write hitl_status flip is detected via row_hash mismatch", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1, hitlStatus: "rejected" }));
    const id = (
      db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1`).get() as { id: number }
    ).id;
    // Flip the persisted consent decision without touching any other field.
    db.run(`UPDATE egress_ledger SET hitl_status = 'approved' WHERE id = ?`, [id]);
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(id);
    expect(r.reason).toMatch(/row_hash mismatch/);
  });
  test("a tampered prev_hash is detected via linkage check", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
    appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
    appendEgressEntry(db, e({ method: "c.z", timestamp: 3 }));
    expect(verifyEgressChain(db).ok).toBe(true);
    // Fetch the second row's id — the one whose prev_hash we'll corrupt.
    const secondId = (
      db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1 OFFSET 1`).get() as {
        id: number;
      }
    ).id;
    // Mutate ONLY prev_hash (no hashed data field changes) so only the linkage check fires.
    db.run(`UPDATE egress_ledger SET prev_hash = ? WHERE id = ?`, ["0".repeat(64), secondId]);
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(secondId);
    expect(r.reason).toMatch(/prev_hash mismatch/);
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
  test("marker rows are not counted as outbound egress events", () => {
    // One real gated action…
    appendEgressEntry(
      db,
      e({ timestamp: 50, sourceType: "task", destination: "jira", method: "jira.issue.create" }),
    );
    // …and one prune tombstone, which carries resultStatus 'authorized' but sends NOTHING.
    appendEgressEntry(
      db,
      e({
        timestamp: 51,
        sourceType: "prune",
        sourceId: "boundary-hash",
        destination: "local",
        method: "egress.prune",
      }),
    );
    const out = proveWindow(db, {});
    expect(out.completeness.outboundEgressEvents).toBe(1);
  });
});
