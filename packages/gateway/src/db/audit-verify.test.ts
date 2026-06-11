import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendAuditEntry } from "./audit-chain.ts";
import { verifyAuditChain } from "./audit-verify.ts";

function newIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

describe("verifyAuditChain", () => {
  test("reports ok on an intact chain", () => {
    const idx = newIndex();
    idx.recordAudit({ actionType: "a", hitlStatus: "approved", actionJson: "{}", timestamp: 1 });
    idx.recordAudit({ actionType: "b", hitlStatus: "approved", actionJson: "{}", timestamp: 2 });
    const result = verifyAuditChain(idx, { fromId: 0 });
    expect(result.ok).toBe(true);
    expect(result.verifiedRows).toBe(2);
    expect(result.firstBreakAtId).toBeUndefined();
  });

  test("detects tampering in a middle row", () => {
    const idx = newIndex();
    idx.recordAudit({ actionType: "a", hitlStatus: "approved", actionJson: "{}", timestamp: 1 });
    idx.recordAudit({ actionType: "b", hitlStatus: "approved", actionJson: "{}", timestamp: 2 });
    idx.recordAudit({ actionType: "c", hitlStatus: "approved", actionJson: "{}", timestamp: 3 });
    idx.rawDb.run(`UPDATE audit_log SET action_json = ? WHERE id = 2`, ['{"t":1}']);
    const result = verifyAuditChain(idx, { fromId: 0 });
    expect(result.ok).toBe(false);
    expect(result.firstBreakAtId).toBe(2);
  });

  test("incremental mode skips rows already verified", () => {
    const idx = newIndex();
    idx.recordAudit({ actionType: "a", hitlStatus: "approved", actionJson: "{}", timestamp: 1 });
    idx.setAuditVerifiedThroughId(1);
    idx.recordAudit({ actionType: "b", hitlStatus: "approved", actionJson: "{}", timestamp: 2 });
    const result = verifyAuditChain(idx, { fromId: idx.getAuditVerifiedThroughId() });
    expect(result.ok).toBe(true);
    expect(result.verifiedRows).toBe(1);
  });

  // --- Branch coverage additions ---

  // line 20 FALSE arm: audit_log without federation_json (pre-V33 schema)
  test("verifies intact chain on a pre-V33 db (no federation_json column)", () => {
    // Migrate only up to V32 so audit_log lacks the V33 federation_json column.
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 32);
    appendAuditEntry(db, {
      actionType: "legacy.a",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 10,
    });
    appendAuditEntry(db, {
      actionType: "legacy.b",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 20,
    });
    // Confirm the column really is absent (guards our premise).
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(audit_log)`)
      .all()
      .map((c) => c.name);
    expect(cols).not.toContain("federation_json");

    // verifyAuditChain must take the FALSE arm of auditLogHasFederationJson.
    const idx = new LocalIndex(db);
    const result = verifyAuditChain(idx, { fromId: 0 });
    expect(result.ok).toBe(true);
    expect(result.verifiedRows).toBe(2);
    expect(result.firstBreakAtId).toBeUndefined();
  });

  // line 39 ?? GENESIS_HASH arm: fromId > 0 but the row does not exist in the table
  test("falls back to GENESIS_HASH when fromId points to a missing row", () => {
    // Empty table — no row with id = 99 exists.
    const idx = newIndex();
    // fromId = 99 → SELECT row_hash … WHERE id = 99 returns undefined → ?? GENESIS_HASH.
    // No rows with id > 99 either, so the chain trivially verifies.
    const result = verifyAuditChain(idx, { fromId: 99 });
    expect(result.ok).toBe(true);
    expect(result.verifiedRows).toBe(0);
    // lastVerifiedId is initialised to fromId when there are no rows to walk.
    expect(result.lastVerifiedId).toBe(99);
  });

  // line 50 TRUE arm: prev_hash mismatch → early-exit with ok: false
  test("detects a tampered prev_hash and reports the break", () => {
    const idx = newIndex();
    idx.recordAudit({ actionType: "a", hitlStatus: "approved", actionJson: "{}", timestamp: 1 });
    idx.recordAudit({ actionType: "b", hitlStatus: "approved", actionJson: "{}", timestamp: 2 });
    idx.recordAudit({ actionType: "c", hitlStatus: "approved", actionJson: "{}", timestamp: 3 });
    // Directly corrupt the prev_hash of row 2 so it no longer points at row 1's hash.
    idx.rawDb.run(`UPDATE audit_log SET prev_hash = ? WHERE id = 2`, ["badf00d".padEnd(64, "0")]);
    const result = verifyAuditChain(idx, { fromId: 0 });
    expect(result.ok).toBe(false);
    expect(result.firstBreakAtId).toBe(2);
    expect(result.reason).toMatch(/prev_hash mismatch/);
    // Row 1 was verified before the break.
    expect(result.verifiedRows).toBe(1);
  });
});
