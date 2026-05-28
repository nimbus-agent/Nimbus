import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
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
});
