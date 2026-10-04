import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { isConnectorCodeExecutionToolId } from "../connectors/connector-code-execution-tool-ids.ts";
import { isConnectorWriteToolId } from "../connectors/connector-write-registry.ts";
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
    // REQUIRED field: the production predicate, so every case here also proves it over-blocks nothing.
    isCodeExecutionForbiddenToolId: isConnectorCodeExecutionToolId,
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
    isCodeExecutionForbiddenToolId: isConnectorCodeExecutionToolId,
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

  it("the REAL isConnectorWriteToolId predicate rejects a granted GitOps write id fail-closed", async () => {
    let ran = false;
    const { db, ctx } = freshI26Ctx({
      runTool: async () => {
        ran = true;
        return { ok: true };
      },
      isWriteForbiddenToolId: isConnectorWriteToolId,
    });
    // Grant the gitops write id so the rejection is unambiguously the write predicate, not a missing grant.
    ctx.store.grant("warehouse", "peer-1", "flux_kustomization_reconcile", 1000);
    const result = await answerFederatedInvoke(ctx, {
      peerId: "peer-1",
      entry: "warehouse",
      toolId: "flux_kustomization_reconcile",
      purpose: "p",
      args: {},
    });
    expect(result).toEqual({ kind: "error", error: "no_grant" });
    expect(ran).toBe(false);
    const audited = db
      .query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string };
    expect(audited.action_type).toBe("teamvault.invoke.write_forbidden");
  });

  // Classified 2026-10-05: four moved to the write registrar in connectors 0.2.2, and
  // gdrive_file_trash, which still mutates from a read registration. Each is tried BARE and in the
  // `<server>_<tool>` form a team-credentialed session actually executes (`@mastra/mcp` namespaces
  // every key) — the bare id alone was all the predicate used to match, so the executable form of
  // even a long-classified write (tableau_datasource_refresh) went through. Each case first proves
  // the grant WOULD let the call through, so the refusal is the write predicate and nothing else.
  // The last four are the comms writes whose literals D17 / D19 confine to their own gates: those
  // gates pin the destination when the GATEWAY posts or appends, but a federated invoke carries the
  // peer's own arguments, so the peer would choose the channel or the knowledge base.
  const cases = [
    ["aws", "aws_ec2_instance_stop"],
    ["aws", "aws_ec2_instance_start"],
    ["slack", "slack_message_post_dm"],
    ["teams", "teams_message_post_chat"],
    ["google_drive", "gdrive_file_trash"],
    ["tableau", "tableau_datasource_refresh"],
    ["slack", "slack_chat_post"],
    ["teams", "teams_chat_post"],
    ["notion", "notion_kb_append"],
    ["confluence", "confluence_kb_append"],
  ] as const;
  for (const [service, bare] of cases)
    for (const toolId of [bare, `${service}_${bare}`]) {
      it(`${toolId}: granted, yet refused (opaque no_grant, audited write_forbidden) before runTool`, async () => {
        let runToolCalls = 0;
        const { db, ctx } = freshI26Ctx({
          runTool: async () => {
            runToolCalls++;
            return { ok: true };
          },
        });
        ctx.store.createEntry(`team-${service}`, service, "owner", 1000);
        ctx.store.grant(`team-${service}`, "peer-1", toolId, 1000);
        const request = {
          peerId: "peer-1",
          entry: `team-${service}`,
          toolId,
          purpose: "p",
          args: {},
        };
        const lastDecision = (): string =>
          (
            db.query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`).get() as {
              action_type: string;
            }
          ).action_type;

        // Control: without the predicate the grant answers it.
        expect(await answerFederatedInvoke(ctx, request)).toEqual({
          kind: "ok",
          result: { ok: true },
        });
        expect(runToolCalls).toBe(1);
        expect(lastDecision()).toBe("teamvault.invoke.answered");

        const guarded: InvokeGateCtx = { ...ctx, isWriteForbiddenToolId: isConnectorWriteToolId };
        expect(await answerFederatedInvoke(guarded, request)).toEqual({
          kind: "error",
          error: "no_grant",
        });
        expect(runToolCalls).toBe(1); // never reached the connector
        expect(lastDecision()).toBe("teamvault.invoke.write_forbidden");
      });
    }

  it("a namespaced READ is still answered under the real predicate — no over-blocking", async () => {
    let runToolCalls = 0;
    const { ctx } = freshI26Ctx({
      runTool: async () => {
        runToolCalls++;
        return { ok: true };
      },
      isWriteForbiddenToolId: isConnectorWriteToolId,
    });
    ctx.store.grant("warehouse", "peer-1", "tableau_tableau_list", 1000);
    const result = await answerFederatedInvoke(ctx, {
      peerId: "peer-1",
      entry: "warehouse",
      toolId: "tableau_tableau_list",
      purpose: "p",
      args: {},
    });
    expect(result).toEqual({ kind: "ok", result: { ok: true } });
    expect(runToolCalls).toBe(1);
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

// ---------------------------------------------------------------------------
// I26 — connector tools that run caller-directed code on this machine
// ---------------------------------------------------------------------------

function lastDecisionOf(db: Database): string {
  return (
    db.query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`).get() as {
      action_type: string;
    }
  ).action_type;
}

const REFUSED = { kind: "error", error: "no_grant" } as const;

describe("I26 — federated peer gate fail-closed rejects tools that run caller-directed code", () => {
  // `iac_terraform_plan` and `iac_pulumi_preview` are READ registrations, so the write predicate
  // never saw them — yet each hands terraform / pulumi a caller-named directory, which evaluates
  // the code in it. Each is tried bare and in the `<server>_<tool>` form a session executes, with
  // the production wiring (both predicates, write first), after a control proving the grant would
  // answer it — so the refusal is the code-execution check and nothing else.
  for (const bare of ["iac_terraform_plan", "iac_pulumi_preview"])
    for (const toolId of [bare, `iac_${bare}`]) {
      it(`${toolId}: granted, yet refused (opaque no_grant, audited code_execution_forbidden) before runTool`, async () => {
        const ran: string[] = [];
        const { db, ctx } = freshI26Ctx({
          runTool: async (input) => {
            ran.push(input.toolId);
            return { ok: true };
          },
          isWriteForbiddenToolId: isConnectorWriteToolId,
        });
        ctx.store.createEntry("team-iac", "iac", "owner", 1000);
        ctx.store.grant("team-iac", "peer-1", toolId, 1000);
        const request = {
          peerId: "peer-1",
          entry: "team-iac",
          toolId,
          purpose: "p",
          args: { workingDirectory: "/srv/checkout/infra" },
        };

        // Control: with the code-execution check off, the grant answers it.
        const unchecked: InvokeGateCtx = { ...ctx, isCodeExecutionForbiddenToolId: () => false };
        expect(await answerFederatedInvoke(unchecked, request)).toEqual({
          kind: "ok",
          result: { ok: true },
        });
        expect(ran).toEqual([toolId]);
        expect(lastDecisionOf(db)).toBe("teamvault.invoke.answered");

        expect(await answerFederatedInvoke(ctx, request)).toEqual(REFUSED);
        expect(ran).toEqual([toolId]); // never reached the connector
        expect(lastDecisionOf(db)).toBe("teamvault.invoke.code_execution_forbidden");
      });
    }

  it("refuses before identity, the grant and quorum are consulted", async () => {
    const consulted: string[] = [];
    const { db, ctx } = freshI26Ctx({
      identity: {
        enabled: true,
        isOperatorValid: () => {
          consulted.push("identity");
          return false;
        },
      },
      quorumFor: () => {
        consulted.push("quorumFor");
        return { approvers: 2, windowSeconds: 60 };
      },
      runQuorum: async () => {
        consulted.push("runQuorum");
        return { outcome: "approved", approvers: [] };
      },
      runTool: async () => {
        consulted.push("runTool");
        return {};
      },
    });
    // No such entry and no grant: a check placed after identity or the grant lookup would audit
    // `identity_invalid` or `no_grant` here instead.
    const result = await answerFederatedInvoke(ctx, {
      peerId: "peer-1",
      entry: "no-such-entry",
      toolId: "iac_iac_pulumi_preview",
      purpose: "p",
      args: {},
    });
    expect(result).toEqual(REFUSED);
    expect(lastDecisionOf(db)).toBe("teamvault.invoke.code_execution_forbidden");
    expect(consulted).toEqual([]);
  });

  it("an iac write is refused as a write first, and as code execution with no write predicate", async () => {
    for (const toolId of [
      "iac_iac_terraform_apply",
      "iac_terraform_destroy",
      "iac_iac_pulumi_up",
    ]) {
      const request = { peerId: "peer-1", entry: "team-iac", toolId, purpose: "p", args: {} };

      const wired = freshI26Ctx({ isWriteForbiddenToolId: isConnectorWriteToolId });
      expect(await answerFederatedInvoke(wired.ctx, request)).toEqual(REFUSED);
      expect(lastDecisionOf(wired.db)).toBe("teamvault.invoke.write_forbidden");

      // The code-execution classification stands on its own, whatever happens to the write list.
      const unwired = freshI26Ctx();
      expect(await answerFederatedInvoke(unwired.ctx, request)).toEqual(REFUSED);
      expect(lastDecisionOf(unwired.db)).toBe("teamvault.invoke.code_execution_forbidden");
    }
  });

  it("a granted read of a process-spawning connector is still answered — no over-blocking", async () => {
    for (const [service, toolId] of [
      ["kubernetes", "kubernetes_k8s_pod_list"],
      ["aws", "aws_aws_ecs_service_list"],
      ["athena", "athena_athena_get"],
    ] as const) {
      let runs = 0;
      const { db, ctx } = freshI26Ctx({
        runTool: async () => {
          runs++;
          return { ok: true };
        },
        isWriteForbiddenToolId: isConnectorWriteToolId,
      });
      ctx.store.createEntry(`team-${service}`, service, "owner", 1000);
      ctx.store.grant(`team-${service}`, "peer-1", toolId, 1000);
      const result = await answerFederatedInvoke(ctx, {
        peerId: "peer-1",
        entry: `team-${service}`,
        toolId,
        purpose: "p",
        args: {},
      });
      expect(result, toolId).toEqual({ kind: "ok", result: { ok: true } });
      expect(runs, toolId).toBe(1);
      expect(lastDecisionOf(db), toolId).toBe("teamvault.invoke.answered");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveIdentitySubject threading (Wave 7b deferral — I19 audit enrichment)
// ---------------------------------------------------------------------------

describe("resolveIdentitySubject threading", () => {
  it("answerFederatedInvoke: answered audit row carries identity_subject when resolver returns a value", async () => {
    const { db, ctx } = freshCtx({
      resolveIdentitySubject: () => "operator@example.com",
    });
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: {},
      purpose: "enrichment test",
    });
    expect(r.kind).toBe("ok");
    const row = db
      .query(`SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { federation_json: string };
    const parsed = JSON.parse(row.federation_json);
    expect(parsed.identity_subject).toBe("operator@example.com");
  });

  it("answerFederatedInvoke: answered audit row OMITS identity_subject when resolver returns undefined", async () => {
    const { db, ctx } = freshCtx({
      resolveIdentitySubject: () => undefined,
    });
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: {},
      purpose: "omit test",
    });
    expect(r.kind).toBe("ok");
    const row = db
      .query(`SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { federation_json: string };
    const parsed = JSON.parse(row.federation_json);
    expect("identity_subject" in parsed).toBe(false);
  });

  it("answerLocalOperatorList: answered audit row carries identity_subject when resolver returns a value", async () => {
    const { db, ctx } = freshLocalCtx({
      resolveIdentitySubject: () => "local@example.com",
    });
    const r = await answerLocalOperatorList(ctx, {
      entry: "dw-snowflake",
      service: "snowflake",
      listToolId: "snowflake_list_schemas",
    });
    expect(r.kind).toBe("ok");
    const row = db
      .query(`SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { federation_json: string };
    const parsed = JSON.parse(row.federation_json);
    expect(parsed.identity_subject).toBe("local@example.com");
  });

  it("answerLocalOperatorList: answered audit row OMITS identity_subject when resolver returns undefined", async () => {
    const { db, ctx } = freshLocalCtx({
      resolveIdentitySubject: () => undefined,
    });
    const r = await answerLocalOperatorList(ctx, {
      entry: "dw-snowflake",
      service: "snowflake",
      listToolId: "snowflake_list_schemas",
    });
    expect(r.kind).toBe("ok");
    const row = db
      .query(`SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { federation_json: string };
    const parsed = JSON.parse(row.federation_json);
    expect("identity_subject" in parsed).toBe(false);
  });

  it("answerLocalOperatorInvoke: answered audit row carries identity_subject when resolver returns a value", async () => {
    const { db, ctx } = freshLocalInvokeCtx({
      resolveIdentitySubject: () => "invoke@example.com",
    });
    const r = await answerLocalOperatorInvoke(ctx, {
      entry: "warehouse",
      service: "tableau",
      toolId: "tableau_datasource_refresh",
      args: {},
    });
    expect(r.kind).toBe("ok");
    const row = db
      .query(`SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { federation_json: string };
    const parsed = JSON.parse(row.federation_json);
    expect(parsed.identity_subject).toBe("invoke@example.com");
  });

  it("answerLocalOperatorInvoke: answered audit row OMITS identity_subject when resolver returns undefined", async () => {
    const { db, ctx } = freshLocalInvokeCtx({
      resolveIdentitySubject: () => undefined,
    });
    const r = await answerLocalOperatorInvoke(ctx, {
      entry: "warehouse",
      service: "tableau",
      toolId: "tableau_datasource_refresh",
      args: {},
    });
    expect(r.kind).toBe("ok");
    const row = db
      .query(`SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { federation_json: string };
    const parsed = JSON.parse(row.federation_json);
    expect("identity_subject" in parsed).toBe(false);
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
