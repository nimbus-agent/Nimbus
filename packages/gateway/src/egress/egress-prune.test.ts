import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { pruneEgress } from "./egress-prune.ts";
import type { EgressEntry } from "./egress-record.ts";
import { verifyEgressChain } from "./egress-verify.ts";

function e(ts: number, method = "email.send"): EgressEntry {
  return {
    timestamp: ts,
    sourceType: "task",
    sourceId: "s",
    destination: "email",
    method,
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

describe("pruneEgress — basic", () => {
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

  test("no-op prune: nothing older than beforeTs → no tombstone, verifies ok, prunedCount 0", () => {
    appendEgressEntry(db, e(100));
    const before = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
    const out = pruneEgress(db, 0, 999); // nothing before ts 0
    expect(out.prunedCount).toBe(0);
    expect(out.boundaryHash).toBeUndefined();
    // row count unchanged — no tombstone written
    const after = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
    expect(after).toBe(before);
    expect(verifyEgressChain(db).ok).toBe(true);
  });
});

describe("pruneEgress — tombstone-boundary design (LOAD-BEARING)", () => {
  test("partial prune: survivor row_hash is UNCHANGED and chain verifies ok", () => {
    // Seed a 3-row chain: ts 10, 20, 30
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    appendEgressEntry(db, e(30, "tasks.run"));

    // Capture the surviving row's row_hash BEFORE the prune
    const survivorBefore = db
      .query(`SELECT id, row_hash FROM egress_ledger ORDER BY id DESC LIMIT 1`)
      .get() as { id: number; row_hash: string };

    // Prune ts < 25 — deletes rows at ts=10 and ts=20; survivor is ts=30
    const result = pruneEgress(db, 25, 999);
    expect(result.prunedCount).toBe(2);
    expect(result.boundaryHash).toMatch(/^[0-9a-f]{64}$/);

    // (a) chain verifies ok
    expect(verifyEgressChain(db).ok).toBe(true);

    // (b) survivor's row_hash is UNCHANGED — not re-rooted
    const survivorAfter = db
      .query(`SELECT row_hash FROM egress_ledger WHERE id = ?`)
      .get(survivorBefore.id) as { row_hash: string };
    expect(survivorAfter.row_hash).toBe(survivorBefore.row_hash);

    // (c) a prune tombstone exists whose source_id == boundaryHash (the last-deleted row's row_hash)
    const tomb = db
      .query(
        `SELECT source_id FROM egress_ledger WHERE source_type = 'prune' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { source_id: string };
    expect(tomb.source_id).toBe(result.boundaryHash!);
  });

  test("survivor tamper still detected after prune (hash mismatch)", () => {
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    appendEgressEntry(db, e(30, "tasks.run"));

    pruneEgress(db, 25, 999); // ts=10 and ts=20 deleted; ts=30 survives

    // Verify clean before tamper
    expect(verifyEgressChain(db).ok).toBe(true);

    // Tamper a DATA field on the surviving row (raw UPDATE — not via ledger API)
    const survivorId = (
      db
        .query(`SELECT id FROM egress_ledger WHERE source_type != 'prune' ORDER BY id ASC LIMIT 1`)
        .get() as {
        id: number;
      }
    ).id;
    db.run(`UPDATE egress_ledger SET destination = 'evil' WHERE id = ?`, [survivorId]);

    // Must be detected: row_hash mismatch at the tampered row
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(survivorId);
    expect(r.reason).toMatch(/row_hash mismatch/);
  });

  test("full prune: all rows deleted, tombstone present, chain verifies ok", () => {
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));

    const result = pruneEgress(db, 999, 1000); // before=999 deletes all rows (ts 10, 20)
    expect(result.prunedCount).toBe(2);
    expect(result.boundaryHash).toMatch(/^[0-9a-f]{64}$/);

    // Tombstone is the only remaining row
    const rows = db.query(`SELECT source_type FROM egress_ledger ORDER BY id ASC`).all() as {
      source_type: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_type).toBe("prune");

    expect(verifyEgressChain(db).ok).toBe(true);
  });

  test("prune-then-append: new entries after prune chain correctly and verify ok", () => {
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    appendEgressEntry(db, e(30));

    pruneEgress(db, 25, 999); // prune ts=10 and ts=20

    // Append new entries after the prune
    appendEgressEntry(db, e(500, "slack.post"));
    appendEgressEntry(db, e(600, "calendar.create"));

    expect(verifyEgressChain(db).ok).toBe(true);
  });

  test("boundaryHash in tombstone source_id equals last-deleted row's row_hash", () => {
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    appendEgressEntry(db, e(30));

    // Capture the row_hash of ts=20 (the last row to be deleted at cutoff 25)
    const lastDeletedHash = (
      db.query(`SELECT row_hash FROM egress_ledger WHERE timestamp = 20`).get() as {
        row_hash: string;
      }
    ).row_hash;

    const result = pruneEgress(db, 25, 999);
    expect(result.boundaryHash).toBe(lastDeletedHash);

    const tomb = db
      .query(`SELECT source_id FROM egress_ledger WHERE source_type = 'prune'`)
      .get() as { source_id: string };
    expect(tomb.source_id).toBe(lastDeletedHash);
  });
});

describe("pruneEgress — sequential multi-prune (LOAD-BEARING regression)", () => {
  test("two sequential prunes: second deletes first tombstone, chain still verifies ok", () => {
    // Seed a 4-row chain: ts 10, 20, 30, 40
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    appendEgressEntry(db, e(30));
    appendEgressEntry(db, e(40));

    // Prune 1: delete ts < 25 (ts=10 and ts=20); tombstone T1 appended with timestamp now1=26
    const r1 = pruneEgress(db, 25, 26);
    expect(r1.prunedCount).toBe(2);

    // Capture T1's row_hash before prune 2 deletes it
    const t1Hash = (
      db
        .query(
          `SELECT row_hash FROM egress_ledger WHERE source_type = 'prune' ORDER BY id DESC LIMIT 1`,
        )
        .get() as { row_hash: string }
    ).row_hash;

    // Capture R30's row_hash before prune 2 deletes it (it is the last deleted REGULAR row;
    // T1, appended after R40, has a higher id — so the boundary must be R30's hash, not T1's,
    // because R40's prev_hash points to R30).
    const r30Hash = (
      db.query(`SELECT row_hash FROM egress_ledger WHERE timestamp = 30`).get() as {
        row_hash: string;
      }
    ).row_hash;

    // Prune 2: delete ts < 35 (ts=30 AND T1 whose timestamp=26 < 35); tombstone T2 appended
    const r2 = pruneEgress(db, 35, 100);
    // Deleted rows: ts=30 and T1 (ts=26) — 2 rows
    expect(r2.prunedCount).toBe(2);
    // T2's source_id must equal R30's row_hash (= R40's prev_hash — the correct boundary),
    // NOT T1's row_hash: T1 was appended after R40 and has a higher id, so "last deleted by id"
    // would be T1, but R40's prev_hash is R30's hash — that mismatch was the original bug.
    const t2 = db
      .query(
        `SELECT source_id FROM egress_ledger WHERE source_type = 'prune' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { source_id: string };
    expect(t2.source_id).toBe(r30Hash);
    // t1Hash and r30Hash must be distinct hashes (sanity: these are different rows)
    expect(t1Hash).not.toBe(r30Hash);

    // Chain must still verify: surviving row (ts=40) + T2
    expect(verifyEgressChain(db).ok).toBe(true);

    // The surviving row (ts=40) is still intact and unmodified
    const survivor = db
      .query(
        `SELECT timestamp FROM egress_ledger WHERE source_type != 'prune' ORDER BY id ASC LIMIT 1`,
      )
      .get() as { timestamp: number };
    expect(survivor.timestamp).toBe(40);

    // Appending a new entry after the second prune still chains and verifies
    appendEgressEntry(db, e(500, "slack.post"));
    expect(verifyEgressChain(db).ok).toBe(true);
  });
});

describe("pruneEgress — existing tamper tests (T5 compatibility)", () => {
  test("a tampered data field on a surviving row is still detected via row_hash mismatch", () => {
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    appendEgressEntry(db, e(30));

    // Tamper row at ts=30 BEFORE prune (no prune in this case — just verify baseline)
    const id = (
      db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1`).get() as { id: number }
    ).id;
    db.run(`UPDATE egress_ledger SET destination = 'evil' WHERE id = ?`, [id]);
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(id);
    expect(r.reason).toMatch(/row_hash mismatch/);
  });

  test("a tampered prev_hash on a surviving row (post-prune) is still detected", () => {
    appendEgressEntry(db, e(10));
    appendEgressEntry(db, e(20));
    appendEgressEntry(db, e(30));
    appendEgressEntry(db, e(40));

    pruneEgress(db, 25, 999); // deletes ts=10 and ts=20; survivors: ts=30 and ts=40

    // Corrupt the prev_hash of the ts=40 row (second survivor — mid-chain after the boundary)
    const secondSurvivorId = (
      db
        .query(`SELECT id FROM egress_ledger WHERE source_type != 'prune' ORDER BY id DESC LIMIT 1`)
        .get() as { id: number }
    ).id;
    db.run(`UPDATE egress_ledger SET prev_hash = ? WHERE id = ?`, [
      "0".repeat(64),
      secondSurvivorId,
    ]);

    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/prev_hash mismatch/);
  });
});
