import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { verifyAuditChain } from "../db/audit-verify.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendFederationAudit } from "./federation-audit.ts";

let db: Database;
let index: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  index = new LocalIndex(db);
});
afterEach(() => db.close());

test("legacy + federation audit rows keep the Blake3 chain verifiable", () => {
  appendAuditEntry(db, {
    actionType: "tool.call",
    hitlStatus: "approved",
    actionJson: JSON.stringify({ tool: "x" }),
    timestamp: 1000,
  });
  appendFederationAudit(db, {
    peerId: "peerA",
    namespace: "project:zurich",
    purpose: "review",
    decision: "answered",
    method: "federation.query",
    timestamp: 2000,
  });
  appendFederationAudit(db, {
    peerId: "peerB",
    namespace: "project:zurich",
    purpose: "snoop",
    decision: "no_grant",
    method: "federation.query",
    timestamp: 3000,
  });

  const result = verifyAuditChain(index, { fromId: 0 });
  expect(result.ok).toBe(true);

  const fedRows = db
    .query(`SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL`)
    .all();
  expect(fedRows).toHaveLength(2);

  const legacyRow = db
    .query(`SELECT federation_json FROM audit_log ORDER BY id ASC LIMIT 1`)
    .get() as { federation_json: string | null };
  expect(legacyRow.federation_json).toBeNull();
});
