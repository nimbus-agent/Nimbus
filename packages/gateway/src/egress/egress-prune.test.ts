import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { pruneEgress } from "./egress-prune.ts";
import type { EgressEntry } from "./egress-record.ts";
import { verifyEgressChain } from "./egress-verify.ts";

function e(ts: number): EgressEntry {
  return {
    timestamp: ts,
    sourceType: "task",
    sourceId: "s",
    destination: "email",
    method: "email.send",
    payloadSummary: "{}",
    hitlStatus: "approved",
    resultStatus: "authorized",
  };
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

describe("pruneEgress", () => {
  test("deletes rows before the cutoff and reports the count", () => {
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    appendEgressEntry(db, e(30));
    const out = pruneEgress(db, 25, 999);
    expect(out.prunedCount).toBe(2);
  });

  test("writes a continuing 'prune' tombstone row so the chain stays verifiable", () => {
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    pruneEgress(db, 15, 999);
    const tomb = db
      .query(
        `SELECT source_type, method, result_status FROM egress_ledger ORDER BY id DESC LIMIT 1`,
      )
      .get() as { source_type: string; method: string; result_status: string };
    expect(tomb.source_type).toBe("prune");
    expect(verifyEgressChain(db).ok).toBe(true);
  });

  test("pruning an empty/zero-match window still leaves a verifiable chain", () => {
    appendEgressEntry(db, e(100));
    pruneEgress(db, 0, 999); // nothing before ts 0
    expect(verifyEgressChain(db).ok).toBe(true);
  });
});
