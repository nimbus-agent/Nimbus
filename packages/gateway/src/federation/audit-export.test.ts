import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { exportFederationAudit } from "./audit-export.ts";

function dbWithAudit(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  appendAuditEntry(db, {
    actionType: "federation.query",
    hitlStatus: "not_required",
    actionJson: '{"q":"secret"}',
    timestamp: 100,
  });
  appendAuditEntry(db, {
    actionType: "ask",
    hitlStatus: "not_required",
    actionJson: "{}",
    timestamp: 200,
  });
  return db;
}

describe("exportFederationAudit", () => {
  test("returns ONLY federation-prefixed entries, metadata only (no action_json)", () => {
    const rows = exportFederationAudit(dbWithAudit(), { sinceMs: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionType).toBe("federation.query");
    expect(JSON.stringify(rows[0])).not.toContain("secret");
    expect((rows[0] as unknown as Record<string, unknown>)["actionJson"]).toBeUndefined();
  });

  test("respects sinceMs", () => {
    const db = dbWithAudit();
    appendAuditEntry(db, {
      actionType: "federation.invoke",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 300,
    });
    expect(exportFederationAudit(db, { sinceMs: 250 }).map((r) => r.actionType)).toEqual([
      "federation.invoke",
    ]);
  });
});
