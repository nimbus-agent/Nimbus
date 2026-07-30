import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { appendAuditEntry, computeAuditRowHash, GENESIS_HASH } from "./audit-chain.ts";

describe("computeAuditRowHash", () => {
  test("is deterministic for identical inputs", () => {
    const row = {
      prevHash: GENESIS_HASH,
      actionType: "a",
      hitlStatus: "approved",
      actionJson: "{}",
      timestamp: 1,
    };
    expect(computeAuditRowHash(row)).toBe(computeAuditRowHash(row));
  });

  describe("federationJson participates in the hash", () => {
    // The federated leg of the chain was entirely untested: every case above omits
    // `federationJson`, so neither arm of the `typeof … === "string" && length > 0`
    // guard was exercised. A federated audit row whose provenance did NOT change the
    // hash would let that field be rewritten after the fact without breaking the chain.
    const base = {
      prevHash: GENESIS_HASH,
      actionType: "federation.query",
      hitlStatus: "approved",
      actionJson: '{"q":"x"}',
      timestamp: 42,
    };

    test("a non-empty federationJson changes the hash", () => {
      const withFed = computeAuditRowHash({ ...base, federationJson: '{"peer":"alice"}' });
      expect(withFed).not.toBe(computeAuditRowHash(base));
      expect(withFed).toMatch(/^[0-9a-f]{64}$/);
    });

    test("a different federationJson yields a different hash", () => {
      expect(computeAuditRowHash({ ...base, federationJson: '{"peer":"alice"}' })).not.toBe(
        computeAuditRowHash({ ...base, federationJson: '{"peer":"bob"}' }),
      );
    });

    test("empty string and null are equivalent to the field being absent", () => {
      // The `length > 0` guard exists so a nullish/blank provenance cannot silently
      // fork the chain away from rows written before the column existed. (Passing an
      // explicit `undefined` is a type error under exactOptionalPropertyTypes, so
      // "absent" is expressed by omitting the key.)
      const absent = computeAuditRowHash(base);
      expect(computeAuditRowHash({ ...base, federationJson: "" })).toBe(absent);
      expect(computeAuditRowHash({ ...base, federationJson: null })).toBe(absent);
    });

    test("is still deterministic with federationJson set", () => {
      const row = { ...base, federationJson: '{"peer":"alice","ns":"team"}' };
      expect(computeAuditRowHash(row)).toBe(computeAuditRowHash(row));
    });
  });

  test("differs when any field differs", () => {
    const base = {
      prevHash: GENESIS_HASH,
      actionType: "a",
      hitlStatus: "approved",
      actionJson: "{}",
      timestamp: 1,
    };
    const mutated = { ...base, actionType: "b" };
    expect(computeAuditRowHash(base)).not.toBe(computeAuditRowHash(mutated));
  });

  test("returns 64-char lowercase hex", () => {
    const h = computeAuditRowHash({
      prevHash: GENESIS_HASH,
      actionType: "a",
      hitlStatus: "approved",
      actionJson: "{}",
      timestamp: 1,
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("GENESIS_HASH is 64 zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });

  test("changes when prevHash changes (chain linkage)", () => {
    const row = { actionType: "a", hitlStatus: "approved", actionJson: "{}", timestamp: 1 };
    const a = computeAuditRowHash({ ...row, prevHash: GENESIS_HASH });
    const b = computeAuditRowHash({ ...row, prevHash: "deadbeef".repeat(8) });
    expect(a).not.toBe(b);
  });
});

describe("appendAuditEntry", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
  });

  afterEach(() => db.close());

  test("chains to genesis for the first row", () => {
    appendAuditEntry(db, {
      actionType: "test.first",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ a: 1 }),
      timestamp: 1000,
    });
    const row = db
      .query(`SELECT action_type, prev_hash, row_hash FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string; prev_hash: string; row_hash: string };
    expect(row.action_type).toBe("test.first");
    expect(row.prev_hash).toBe(GENESIS_HASH);
    expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("chains subsequent rows to the previous row_hash", () => {
    appendAuditEntry(db, {
      actionType: "a",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 1,
    });
    appendAuditEntry(db, {
      actionType: "b",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 2,
    });
    const rows = db
      .query(`SELECT id, row_hash, prev_hash FROM audit_log ORDER BY id ASC`)
      .all() as Array<{ id: number; row_hash: string; prev_hash: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.row_hash);
  });

  test("row_hash matches what computeAuditRowHash would produce", () => {
    const fields = {
      actionType: "verify.hash",
      hitlStatus: "approved",
      actionJson: '{"x":42}',
      timestamp: 9999,
    };
    appendAuditEntry(db, fields);
    const row = db
      .query(`SELECT row_hash, prev_hash FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { row_hash: string; prev_hash: string };
    const expected = computeAuditRowHash({
      prevHash: GENESIS_HASH,
      actionType: fields.actionType,
      hitlStatus: fields.hitlStatus,
      actionJson: fields.actionJson,
      timestamp: fields.timestamp,
    });
    expect(row.row_hash).toBe(expected);
    expect(row.prev_hash).toBe(GENESIS_HASH);
  });
});
