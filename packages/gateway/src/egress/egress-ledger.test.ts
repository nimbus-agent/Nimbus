import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GENESIS_HASH } from "../db/audit-chain.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendEgressEntry, computeEgressRowHash, makeEgressSink } from "./egress-ledger.ts";
import type { EgressEntry } from "./egress-record.ts";

function entry(over: Partial<EgressEntry> = {}): EgressEntry {
  return {
    timestamp: 100,
    sourceType: "task",
    sourceId: "s1",
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

describe("appendEgressEntry", () => {
  test("returns the row hash it stored, so a later row can name this one", () => {
    const out = appendEgressEntry(db, entry({ method: "a.x", timestamp: 1 }));
    const stored = db.query(`SELECT row_hash FROM egress_ledger ORDER BY id ASC`).get() as {
      row_hash: string;
    };
    expect(out.rowHash).toBe(stored.row_hash);
    expect(out.rowHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the first row chains from GENESIS_HASH with a 64-char hex row_hash", () => {
    appendEgressEntry(db, entry());
    const row = db.query(`SELECT prev_hash, row_hash FROM egress_ledger ORDER BY id ASC`).get() as {
      prev_hash: string;
      row_hash: string;
    };
    expect(row.prev_hash).toBe(GENESIS_HASH);
    expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the second row's prev_hash equals the first row's row_hash", () => {
    appendEgressEntry(db, entry({ method: "email.send" }));
    appendEgressEntry(db, entry({ method: "repo.commit.push", timestamp: 200 }));
    const rows = db
      .query(`SELECT row_hash, prev_hash FROM egress_ledger ORDER BY id ASC`)
      .all() as {
      row_hash: string;
      prev_hash: string;
    }[];
    expect(rows[1]?.prev_hash).toBe(rows[0]?.row_hash);
  });

  test("computeEgressRowHash is deterministic for the same inputs", () => {
    const i = {
      prevHash: GENESIS_HASH,
      timestamp: 1,
      sourceType: "task",
      sourceId: "s",
      destination: "email",
      method: "email.send",
      hitlStatus: "approved",
      resultStatus: "authorized",
    };
    expect(computeEgressRowHash(i)).toBe(computeEgressRowHash(i));
  });

  test("a blocked row persists result_status='blocked' and hitl_status='rejected'", () => {
    appendEgressEntry(db, entry({ resultStatus: "blocked", hitlStatus: "rejected" }));
    const row = db.query(`SELECT result_status, hitl_status FROM egress_ledger`).get() as {
      result_status: string;
      hitl_status: string;
    };
    expect(row.result_status).toBe("blocked");
    expect(row.hitl_status).toBe("rejected");
  });

  test("append fails closed when the existing head row_hash is malformed", () => {
    appendEgressEntry(db, entry());
    // Corrupt the head row's hash to a non-64-char value, simulating ledger corruption.
    db.run(
      `UPDATE egress_ledger SET row_hash = 'deadbeef' WHERE id = (SELECT MAX(id) FROM egress_ledger)`,
    );
    expect(() => appendEgressEntry(db, entry({ timestamp: 200 }))).toThrow(/malformed/);
  });

  test("camelCase fields map to correct snake_case columns (round-trip)", () => {
    appendEgressEntry(
      db,
      entry({
        payloadSummary: '{"to":"test@example.com"}',
        sourceType: "task",
        sourceId: "sess-42",
        hitlStatus: "not_required",
        resultStatus: "authorized",
      }),
    );
    const row = db
      .query(
        `SELECT timestamp, source_type, source_id, destination, method, payload_summary, hitl_status, result_status FROM egress_ledger`,
      )
      .get() as {
      timestamp: number;
      source_type: string;
      source_id: string;
      destination: string;
      method: string;
      payload_summary: string;
      hitl_status: string;
      result_status: string;
    };
    expect(row.timestamp).toBe(100);
    expect(row.source_type).toBe("task");
    expect(row.source_id).toBe("sess-42");
    expect(row.destination).toBe("email");
    expect(row.method).toBe("email.send");
    expect(row.payload_summary).toBe('{"to":"test@example.com"}');
    expect(row.hitl_status).toBe("not_required");
    expect(row.result_status).toBe("authorized");
  });
});

describe("makeEgressSink", () => {
  test("the sink appends a row through append()", () => {
    const sink = makeEgressSink(db);
    sink.append(entry());
    const c = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
    expect(c).toBe(1);
  });
});
