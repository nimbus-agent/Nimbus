import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendTeamVaultAudit } from "./team-vault-audit.ts";

describe("appendTeamVaultAudit", () => {
  it("writes a row with the team-vault decision into audit_log + federation_json", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    appendTeamVaultAudit(db, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      decision: "no_grant",
      timestamp: 1000,
    });
    const row = db
      .query(`SELECT action_type, federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string; federation_json: string };
    expect(row.action_type).toBe("teamvault.invoke.no_grant");
    expect(JSON.parse(row.federation_json)).toMatchObject({
      entry: "prod-aws",
      peer_id: "peer:abc",
    });
    db.close();
  });

  it("records the approvers set when present (quorum decisions)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    appendTeamVaultAudit(db, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      decision: "answered",
      timestamp: 2000,
      approvers: ["peer:x", "peer:y"],
    });
    const row = db
      .query(`SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { federation_json: string };
    expect(JSON.parse(row.federation_json).approvers).toEqual(["peer:x", "peer:y"]);
    db.close();
  });
});
