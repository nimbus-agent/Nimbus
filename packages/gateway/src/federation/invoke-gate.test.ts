import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import {
  answerFederatedInvoke,
  answerLocalOperatorInvoke,
  answerLocalOperatorList,
  type InvokeGateCtx,
  type LocalOperatorInvokeCtx,
  type LocalOperatorListCtx,
} from "./invoke-gate.ts";

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

function freshLocalCtx(over: Partial<LocalOperatorListCtx> = {}): {
  db: Database;
  ctx: LocalOperatorListCtx;
} {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  const store = new TeamVaultStore(db);
  store.createEntry("dw-snowflake", "snowflake", "owner", 1000);
  const ctx: LocalOperatorListCtx = {
    db,
    store,
    runListTool: async () => [{ id: 1 }, { id: 2 }],
    now: () => 7000,
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

describe("answerLocalOperatorList (I19 — localOperator principal)", () => {
  it("authorizes on entry-presence + service match, returns items, audits answered", async () => {
    const { db, ctx } = freshLocalCtx();
    const r = await answerLocalOperatorList(ctx, {
      entry: "dw-snowflake",
      service: "snowflake",
      listToolId: "snowflake_list_schemas",
    });
    expect(r).toEqual({ kind: "ok", items: [{ id: 1 }, { id: 2 }] });
    const audited = db
      .query(`SELECT action_type, federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string; federation_json: string };
    expect(audited.action_type).toBe("teamvault.invoke.answered");
    const parsed = JSON.parse(audited.federation_json);
    expect(parsed.principal).toBe("localOperator");
    expect("peer_id" in parsed).toBe(false);
  });

  it("returns no_grant and does NOT call runListTool when entry is missing", async () => {
    let called = false;
    const { ctx } = freshLocalCtx({
      runListTool: async () => {
        called = true;
        return [];
      },
    });
    const r = await answerLocalOperatorList(ctx, {
      entry: "missing-entry",
      service: "snowflake",
      listToolId: "snowflake_list_schemas",
    });
    expect(r).toEqual({ kind: "error", error: "no_grant" });
    expect(called).toBe(false);
  });

  it("returns no_grant and does NOT call runListTool when service mismatches entry", async () => {
    let called = false;
    const { ctx } = freshLocalCtx({
      runListTool: async () => {
        called = true;
        return [];
      },
    });
    const r = await answerLocalOperatorList(ctx, {
      entry: "dw-snowflake",
      service: "bigquery", // wrong service
      listToolId: "bigquery_list_datasets",
    });
    expect(r).toEqual({ kind: "error", error: "no_grant" });
    expect(called).toBe(false);
  });

  it("returns identity_invalid (non-opaque) when identity is enabled and invalid", async () => {
    let called = false;
    const { db, ctx } = freshLocalCtx({
      identity: { enabled: true, isOperatorValid: () => false },
      runListTool: async () => {
        called = true;
        return [];
      },
    });
    const r = await answerLocalOperatorList(ctx, {
      entry: "dw-snowflake",
      service: "snowflake",
      listToolId: "snowflake_list_schemas",
    });
    expect(r).toEqual({ kind: "error", error: "identity_invalid" });
    expect(called).toBe(false);
    const audited = db
      .query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string };
    expect(audited.action_type).toBe("teamvault.invoke.identity_invalid");
  });
});

// ---------------------------------------------------------------------------
// I26 tests
// ---------------------------------------------------------------------------

function freshI26Ctx(over: Partial<InvokeGateCtx> = {}): { db: Database; ctx: InvokeGateCtx } {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  const store = new TeamVaultStore(db);
  store.createEntry("warehouse", "tableau", "owner", 1000);
  store.grant("warehouse", "peer-1", "tableau_datasource_refresh", 1000);
  store.grant("warehouse", "peer-1", "tableau_list", 1000);
  const ctx: InvokeGateCtx = {
    db,
    store,
    quorumFor: () => undefined,
    runQuorum: async () => ({ outcome: "approved", approvers: [] }),
    runTool: async () => ({ ok: true }),
    now: () => 9000,
    ...over,
  };
  return { db, ctx };
}

function freshLocalInvokeCtx(over: Partial<LocalOperatorInvokeCtx> = {}): {
  db: Database;
  ctx: LocalOperatorInvokeCtx;
} {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  const store = new TeamVaultStore(db);
  store.createEntry("warehouse", "tableau", "owner", 1000);
  const ctx: LocalOperatorInvokeCtx = {
    db,
    store,
    runTool: async () => ({ ok: true }),
    now: () => 9000,
    ...over,
  };
  return { db, ctx };
}

describe("I26 — federated peer gate fail-closed rejects write tool ids", () => {
  it("a granted write tool id is rejected; runTool is never called", async () => {
    let ran = false;
    const { db, ctx } = freshI26Ctx({
      runTool: async () => {
        ran = true;
        return { ok: true };
      },
      isWriteForbiddenToolId: (id) => id === "tableau_datasource_refresh",
    });
    const result = await answerFederatedInvoke(ctx, {
      peerId: "peer-1",
      entry: "warehouse",
      toolId: "tableau_datasource_refresh",
      purpose: "p",
      args: {},
    });
    expect(result).toEqual({ kind: "error", error: "no_grant" });
    expect(ran).toBe(false);
    // M3: audit log must record write_forbidden
    const audited = db
      .query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string };
    expect(audited.action_type).toBe("teamvault.invoke.write_forbidden");
  });

  it("a read tool id is unaffected by the predicate", async () => {
    let ran = false;
    const { ctx } = freshI26Ctx({
      runTool: async () => {
        ran = true;
        return { ok: true };
      },
      isWriteForbiddenToolId: (id) => id === "tableau_datasource_refresh",
    });
    const result = await answerFederatedInvoke(ctx, {
      peerId: "peer-1",
      entry: "warehouse",
      toolId: "tableau_list",
      purpose: "p",
      args: {},
    });
    expect(result).toEqual({ kind: "ok", result: { ok: true } });
    expect(ran).toBe(true);
  });
});

describe("answerLocalOperatorInvoke — local owner may invoke a write tool id", () => {
  it("runs the tool and returns its result", async () => {
    const { ctx } = freshLocalInvokeCtx({
      runTool: async (input) => ({ echoed: input.toolId }),
    });
    const result = await answerLocalOperatorInvoke(ctx, {
      entry: "warehouse",
      service: "tableau",
      toolId: "tableau_datasource_refresh",
      args: {},
    });
    expect(result).toEqual({ kind: "ok", result: { echoed: "tableau_datasource_refresh" } });
  });

  it("fail-closed on entry/service mismatch — runTool is NEVER called (M1)", async () => {
    let ran = false;
    const { ctx } = freshLocalInvokeCtx({
      runTool: async () => {
        ran = true;
        return { ok: true };
      },
    });
    const result = await answerLocalOperatorInvoke(ctx, {
      entry: "warehouse",
      service: "looker", // wrong service
      toolId: "tableau_datasource_refresh",
      args: {},
    });
    expect(result).toEqual({ kind: "error", error: "no_grant" });
    expect(ran).toBe(false);
  });

  it("returns identity_invalid (non-opaque) and does NOT call runTool when identity is invalid (M2)", async () => {
    let ran = false;
    const { db, ctx } = freshLocalInvokeCtx({
      identity: { enabled: true, isOperatorValid: () => false },
      runTool: async () => {
        ran = true;
        return { ok: true };
      },
    });
    const result = await answerLocalOperatorInvoke(ctx, {
      entry: "warehouse",
      service: "tableau",
      toolId: "tableau_datasource_refresh",
      args: {},
    });
    expect(result).toEqual({ kind: "error", error: "identity_invalid" });
    expect(ran).toBe(false);
    const audited = db
      .query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string };
    expect(audited.action_type).toBe("teamvault.invoke.identity_invalid");
  });
});
