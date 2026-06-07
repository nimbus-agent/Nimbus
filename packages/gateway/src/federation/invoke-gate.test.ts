import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { answerFederatedInvoke, type InvokeGateCtx } from "./invoke-gate.ts";

function freshCtx(over: Partial<InvokeGateCtx> = {}): { db: Database; ctx: InvokeGateCtx } {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  const store = new TeamVaultStore(db);
  store.createEntry("prod-aws", "aws", "owner", 1000);
  store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1000);
  const ctx: InvokeGateCtx = {
    db,
    store,
    quorumFor: () => undefined, // no quorum by default
    runQuorum: async () => ({ outcome: "approved", approvers: [] }),
    runTool: async () => ({ stopped: true }),
    now: () => 5000,
    ...over,
  };
  return { db, ctx };
}

describe("answerFederatedInvoke (I19)", () => {
  it("runs the tool and returns ok for a granted (entry,peer,tool)", async () => {
    const { ctx } = freshCtx();
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: { id: "i-123" },
      purpose: "stop idle box",
    });
    expect(r).toEqual({ kind: "ok", result: { stopped: true } });
  });

  it("returns opaque no_grant for an ungranted tool (no entry-existence leak)", async () => {
    const { db, ctx } = freshCtx();
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.lambda.invoke",
      args: {},
      purpose: "x",
    });
    expect(r).toEqual({ kind: "error", error: "no_grant" });
    const audited = db
      .query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string };
    expect(audited.action_type).toBe("teamvault.invoke.no_grant");
  });

  it("returns opaque no_grant (audited identity_invalid) when operator identity is invalid (I18)", async () => {
    const { db, ctx } = freshCtx({ identity: { enabled: true, isOperatorValid: () => false } });
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: {},
      purpose: "x",
    });
    expect(r).toEqual({ kind: "error", error: "no_grant" });
    const audited = db
      .query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string };
    expect(audited.action_type).toBe("teamvault.invoke.identity_invalid");
  });

  it("does NOT run the tool when quorum is required but fails", async () => {
    let ran = false;
    const { ctx } = freshCtx({
      quorumFor: () => ({ approvers: 2, windowSeconds: 300 }),
      runQuorum: async () => ({ outcome: "failed", approvers: ["peer:x"] }),
      runTool: async () => {
        ran = true;
        return {};
      },
    });
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: {},
      purpose: "x",
    });
    expect(r).toEqual({ kind: "error", error: "quorum_failed" });
    expect(ran).toBe(false);
  });

  it("runs the tool when quorum is required and met", async () => {
    const { ctx } = freshCtx({
      quorumFor: () => ({ approvers: 2, windowSeconds: 300 }),
      runQuorum: async () => ({ outcome: "approved", approvers: ["peer:x", "peer:y"] }),
    });
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: {},
      purpose: "x",
    });
    expect(r).toEqual({ kind: "ok", result: { stopped: true } });
  });
});
