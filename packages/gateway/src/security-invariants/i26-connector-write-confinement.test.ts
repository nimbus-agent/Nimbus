import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { freshEgressDb, read } from "../../test/helpers/security-invariants.ts";
import { CHATOPS_POST_TOOL_IDS } from "../chatops/transport/connector-post.ts";
import {
  isConnectorWriteOrPrepareToolId,
  isConnectorWriteToolId,
} from "../connectors/connector-write-registry.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { PREPARE_TOOL_IDS } from "../connectors/connector-writes/prepare-tools.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import { serviceOf } from "../engine/service-of.ts";
import { answerFederatedInvoke, type InvokeGateCtx } from "../federation/invoke-gate.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { TRIBAL_KB_WRITE_TOOL_IDS } from "../tribal/tribal-write-gate.ts";

describe("I26 — every connector write row is confined to the local I2 path; federated gate rejects them", () => {
  test("answerFederatedInvoke is wired with the union write-or-prepare predicate in federation-rpc.ts", async () => {
    const src = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(src).toMatch(/isWriteForbiddenToolId:\s*isConnectorWriteOrPrepareToolId\s*,/);
    expect(src).not.toContain("isWriteForbiddenToolId: isConnectorWriteToolId");
  });

  test("a federated peer naming a PREPARE tool (bare or namespaced) is refused write_forbidden and never runs (I54, D1c)", async () => {
    const ids = new Set<string>();
    for (const id of PREPARE_TOOL_IDS) {
      // The server key a session lists it under (`k8s_*` tools live in the `kubernetes` server).
      const head = id.split("_")[0] as string;
      const server = head === "k8s" ? "kubernetes" : head;
      ids.add(id);
      ids.add(`${server}_${id}`);
    }
    expect(ids.size).toBe(PREPARE_TOOL_IDS.size * 2);
    // The production wiring is what federation-rpc.ts passes.
    const failures: string[] = [];
    const db = freshEgressDb();
    const store = new TeamVaultStore(db);
    store.createEntry("prod-gh", "github", "owner", 1000);
    for (const toolId of ids) {
      store.grant("prod-gh", "peer:abc", toolId, 1000);
      let ran = 0;
      const ctx: InvokeGateCtx = {
        db,
        store,
        quorumFor: () => undefined,
        runQuorum: async () => ({ outcome: "approved", approvers: [] }),
        runTool: async () => {
          ran += 1;
          return {};
        },
        isCodeExecutionForbiddenToolId: () => false,
        isWriteForbiddenToolId: isConnectorWriteOrPrepareToolId,
        isConnectorAllowed: () => true,
        now: () => 5000,
      };
      const count = (): number =>
        (
          db
            .query(
              "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'teamvault.invoke.write_forbidden'",
            )
            .get() as { n: number }
        ).n;
      const before = count();
      const r = await answerFederatedInvoke(ctx, {
        peerId: "peer:abc",
        entry: "prod-gh",
        toolId,
        args: { owner: "o", repo: "r", branch: "main", files: [] },
        purpose: "x",
      });
      if (r.kind !== "error" || r.error !== "no_grant") {
        failures.push(`${toolId}: result ${JSON.stringify(r)}`);
      }
      if (ran !== 0) failures.push(`${toolId}: runTool was called`);
      if (count() - before !== 1) failures.push(`${toolId}: audit rows ${count() - before}`);
    }
    db.close();
    expect(failures).toEqual([]);
  });

  test("the plain files read is NOT a prepare tool: the composed predicate leaves it alone", () => {
    expect(isConnectorWriteOrPrepareToolId("github_files_get")).toBe(false);
    expect(isConnectorWriteOrPrepareToolId("github_github_files_get")).toBe(false);
    expect(isConnectorWriteOrPrepareToolId("github_github_commit_prepare")).toBe(true);
    expect(isConnectorWriteOrPrepareToolId("gitlab_commit_prepare")).toBe(true);
    // Every write is still refused through the composed predicate.
    expect(isConnectorWriteOrPrepareToolId("github_file_commit")).toBe(true);
  });

  test("the federated invoke gate fail-closed rejects write-classified tool ids (D20 predicate)", async () => {
    const gate = await read("packages/gateway/src/federation/invoke-gate.ts");
    expect(gate).toContain("isWriteForbiddenToolId");
    expect(gate).toContain("write_forbidden");
  });

  test("a federated peer naming any write is refused and audited write_forbidden", async () => {
    const ids = new Set<string>();
    for (const row of CONNECTOR_WRITE_ROWS) {
      ids.add(row.toolId);
      ids.add(`${serviceOf(row.actionType)}_${row.toolId}`);
    }
    for (const id of [...CHATOPS_POST_TOOL_IDS, ...TRIBAL_KB_WRITE_TOOL_IDS]) ids.add(id);
    expect(ids.size).toBeGreaterThanOrEqual(CONNECTOR_WRITE_ROWS.length + 4);

    const failures: string[] = [];
    const db = freshEgressDb();
    const store = new TeamVaultStore(db);
    store.createEntry("prod-aws", "aws", "owner", 1000);
    for (const toolId of ids) {
      // The grant exists, so the write refusal is the only barrier before runTool.
      store.grant("prod-aws", "peer:abc", toolId, 1000);
      let ran = 0;
      const ctx: InvokeGateCtx = {
        db,
        store,
        quorumFor: () => undefined,
        runQuorum: async () => ({ outcome: "approved", approvers: [] }),
        runTool: async () => {
          ran += 1;
          return {};
        },
        isCodeExecutionForbiddenToolId: () => false,
        isWriteForbiddenToolId: isConnectorWriteToolId,
        isConnectorAllowed: () => true,
        now: () => 5000,
      };
      const count = (): number =>
        (
          db
            .query(
              "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'teamvault.invoke.write_forbidden'",
            )
            .get() as { n: number }
        ).n;
      const before = count();
      const r = await answerFederatedInvoke(ctx, {
        peerId: "peer:abc",
        entry: "prod-aws",
        toolId,
        args: {},
        purpose: "x",
      });
      if (r.kind !== "error" || r.error !== "no_grant") {
        failures.push(`${toolId}: result ${JSON.stringify(r)}`);
      }
      if (ran !== 0) failures.push(`${toolId}: runTool was called`);
      if (count() - before !== 1) {
        failures.push(`${toolId}: write_forbidden audit rows ${count() - before}`);
      }
    }
    db.close();
    expect(failures).toEqual([]);
  });

  test("I26 (Phase 9.7 D0c): a federated invoke of slack_views_open is refused with teamvault.invoke.write_forbidden and never runs", async () => {
    expect(CHATOPS_POST_TOOL_IDS.has("slack_views_open")).toBe(true);
    expect(isConnectorWriteToolId("slack_views_open")).toBe(true);
    const db = freshEgressDb();
    const store = new TeamVaultStore(db);
    store.createEntry("prod-slack", "slack", "owner", 1000);
    store.grant("prod-slack", "peer:abc", "slack_views_open", 1000);
    let ran = 0;
    const r = await answerFederatedInvoke(
      {
        db,
        store,
        quorumFor: () => undefined,
        runQuorum: async () => ({ outcome: "approved", approvers: [] }),
        runTool: async () => {
          ran += 1;
          return {};
        },
        isCodeExecutionForbiddenToolId: () => false,
        isWriteForbiddenToolId: isConnectorWriteToolId,
        isConnectorAllowed: () => true,
        now: () => 5000,
      },
      {
        peerId: "peer:abc",
        entry: "prod-slack",
        toolId: "slack_views_open",
        args: { trigger_id: "t", view: {} },
        purpose: "x",
      },
    );
    expect(r.kind === "error" && r.error === "no_grant").toBe(true);
    expect(ran).toBe(0);
    const n = (
      db
        .query(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'teamvault.invoke.write_forbidden'",
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(1);
    db.close();
  });

  test("the federated invoke gate has no egress seam, so a refused write appends no egress row", async () => {
    const gate = stripComments(await read("packages/gateway/src/federation/invoke-gate.ts"));
    expect(/\begress/i.test(gate)).toBe(false);
  });

  test("every connector write row is HITL-gated via its action type (local path)", () => {
    expect(CONNECTOR_WRITE_ROWS).toHaveLength(144);
    expect(CONNECTOR_WRITE_ROWS.filter((r) => !HITL_REQUIRED.has(r.actionType))).toEqual([]);
  });

  test("D20 confines connector write tool ids to the row table and the transport, dispatch, act-door and code-execution sites", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D20-connector-write");
    expect(audit).toContain("D20-invoke-gate-predicate");
    expect(audit).toContain("D20-invoke-gate-code-execution");
  });

  // The code-execution half (2026-10-05): a federated peer never chooses what code runs on the
  // anchor. `iac_terraform_plan` / `iac_pulumi_preview` are READ registrations that hand terraform /
  // pulumi a caller-named directory, which evaluates its code, so the write predicate never saw them.
  test("federation-rpc wires the code-execution predicate into answerFederatedInvoke", async () => {
    const src = stripComments(await read("packages/gateway/src/ipc/federation-rpc.ts"));
    expect(src).toMatch(/\bisCodeExecutionForbiddenToolId:\s*isConnectorCodeExecutionToolId\b/);
  });

  test("the gate refuses a code-executing tool id before identity, the grant, quorum and the run", async () => {
    const gate = stripComments(await read("packages/gateway/src/federation/invoke-gate.ts"));
    const body =
      /export async function answerFederatedInvoke\([\s\S]*?\n\}\n/.exec(gate)?.[0] ?? "";
    expect(body).not.toBe("");
    const check = body.indexOf("ctx.isCodeExecutionForbiddenToolId(q.toolId)");
    expect(check).toBeGreaterThan(-1);
    expect(body).toContain('"code_execution_forbidden"');
    for (const later of ["ctx.identity", "ctx.store.getEntry", "ctx.quorumFor", "ctx.runTool"]) {
      expect(body.indexOf(later), later).toBeGreaterThan(check);
    }
  });

  // Asserted on the SOURCE, like LlmRegistryOptions.db below: a type error is invisible to a runtime
  // suite. Required means no federated invoke ctx can be built without deciding.
  test("the code-execution predicate is a REQUIRED InvokeGateCtx field", async () => {
    const gate = stripComments(await read("packages/gateway/src/federation/invoke-gate.ts"));
    const fields = /export interface InvokeGateCtx \{([\s\S]*?)\n\}/.exec(gate)?.[1] ?? "";
    expect(fields).not.toBe("");
    expect(/\bisCodeExecutionForbiddenToolId\s*\?\s*:/.test(fields)).toBe(false);
    expect(
      /\bisCodeExecutionForbiddenToolId\s*:\s*\(toolId: string\) => boolean/.test(fields),
    ).toBe(true);
  });

  test("both iac reads that evaluate a caller-named directory are refused, bare and namespaced", async () => {
    const { isConnectorCodeExecutionToolId } = await import(
      "../connectors/connector-code-execution-tool-ids.ts"
    );
    for (const id of [
      "iac_terraform_plan",
      "iac_pulumi_preview",
      "iac_iac_terraform_plan",
      "iac_iac_pulumi_preview",
    ]) {
      expect(isConnectorCodeExecutionToolId(id), id).toBe(true);
    }
  });

  // The Windows `.cmd`-wrapper argument-injection class (2026-10-05): `az` / `gcloud` re-parse their
  // argv, so a caller value reaching one escapes its slot. Every read of the four `.cmd`-backed
  // connectors is refused, bare and in the session form, so the sweep's "only iac" verdict — true on
  // POSIX — cannot leave a federated RCE path open on the Windows push leg.
  test("the az/gcloud-backed reads are refused as code execution, bare and namespaced", async () => {
    const { WINDOWS_CLI_ARG_INJECTION_TOOL_IDS, isConnectorCodeExecutionToolId } = await import(
      "../connectors/connector-code-execution-tool-ids.ts"
    );
    expect(WINDOWS_CLI_ARG_INJECTION_TOOL_IDS.size).toBe(10);
    for (const id of WINDOWS_CLI_ARG_INJECTION_TOOL_IDS) {
      expect(isConnectorCodeExecutionToolId(id), id).toBe(true);
      expect(isConnectorCodeExecutionToolId(`azure_${id}`), id).toBe(true);
    }
  });
});
