import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendTeamVaultAudit } from "./team-vault-audit.ts";

describe("appendTeamVaultAudit", () => {
  it("writes a row with the team-vault decision into audit_log + federation_json (peer principal)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    appendTeamVaultAudit(db, {
      principal: { kind: "peer", peerId: "peer:abc" },
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      decision: "no_grant",
      timestamp: 1000,
    });
    const row = db
      .query(`SELECT action_type, federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string; federation_json: string };
    expect(row.action_type).toBe("teamvault.invoke.no_grant");
    const parsed = JSON.parse(row.federation_json);
    expect(parsed).toMatchObject({
      entry: "prod-aws",
      peer_id: "peer:abc",
      principal: "peer",
    });
    db.close();
  });

  it("records the approvers set when present (quorum decisions)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    appendTeamVaultAudit(db, {
      principal: { kind: "peer", peerId: "peer:abc" },
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

  it("localOperator principal writes principal:'localOperator' and NO peer_id", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    appendTeamVaultAudit(db, {
      principal: { kind: "localOperator" },
      entry: "dw-snowflake",
      toolId: "snowflake_list_schemas",
      decision: "answered",
      timestamp: 3000,
    });
    const row = db
      .query(`SELECT action_type, federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string; federation_json: string };
    expect(row.action_type).toBe("teamvault.invoke.answered");
    const parsed = JSON.parse(row.federation_json);
    expect(parsed.principal).toBe("localOperator");
    expect("peer_id" in parsed).toBe(false);
    db.close();
  });

  it("peer principal writes peer_id and principal:'peer'", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    appendTeamVaultAudit(db, {
      principal: { kind: "peer", peerId: "peer:xyz" },
      entry: "prod-slack",
      toolId: "slack_list_channels",
      decision: "answered",
      timestamp: 4000,
    });
    const row = db
      .query(`SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { federation_json: string };
    const parsed = JSON.parse(row.federation_json);
    expect(parsed.principal).toBe("peer");
    expect(parsed.peer_id).toBe("peer:xyz");
    db.close();
  });
});
