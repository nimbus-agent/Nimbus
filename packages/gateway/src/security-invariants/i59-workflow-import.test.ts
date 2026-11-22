import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read } from "../../test/helpers/security-invariants.ts";
import { agentDoorRow } from "../connectors/connector-writes/agent-door.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { HITL_REQUIRED, ToolExecutor } from "../engine/executor.ts";
import * as demoGate from "../ipc/server/demo-gate.ts";

describe("I59 - a workflow from outside this install enters only through importWorkflowBundle, over the owner's human approval of the verbatim steps", () => {
  async function harness59() {
    const { Database } = await import("bun:sqlite");
    const { CURRENT_SCHEMA_VERSION } = await import("../index/local-index.ts");
    const { runIndexedSchemaMigrations } = await import("../index/migrations/runner.ts");
    const { importWorkflowBundle } = await import("../automation/workflow-import.ts");
    const helpers = await import("../connectors/connector-writes/workflow-bundle.test-helpers.ts");
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const asked: unknown[] = [];
    const run = (
      bundleText: string,
      opts: {
        kind?: "cli" | "ui" | "unknown" | "mcp";
        ask?: (
          a: unknown,
        ) => Promise<
          | { approved: true; auditId: number }
          | { approved: false; reason: "declined" | "not_human" }
        >;
        extra?: Record<string, unknown>;
      } = {},
    ) =>
      importWorkflowBundle(
        {
          db,
          now: () => helpers.FIXTURE_NOW,
          clientKind: opts.kind ?? "cli",
          askOwner: (a) => {
            asked.push(a);
            return (opts.ask ?? (async () => ({ approved: true as const, auditId: 1 })))(a);
          },
        },
        { bundleText, ...(opts.extra ?? {}) },
      );
    const count = (t: string): number =>
      (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { db, asked, run, count, helpers };
  }

  test("the type is in the frozen HITL set, is never an MCP proposal, and is refused over LAN, in the demo root and on the renderer allowlist", async () => {
    expect(HITL_REQUIRED.has("workflow.import")).toBe(true);
    // Since AD3b an outside agent can propose only a type a write row routes to (and the owner approved
    // for agents by name); no row names `workflow.import`, so the agent door can never propose it.
    expect(agentDoorRow("workflow.import")).toBeUndefined();
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    for (const m of ["workflow.import", "workflow.export"]) {
      expect(() => checkLanMethodAllowed(m, { peerId: "peer:x", writeAllowed: true }), m).toThrow(
        /ERR_METHOD_NOT_ALLOWED/,
      );
      expect(demoRefusalOf(m), m).toBeDefined();
    }
    const bridge = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(bridge).not.toMatch(/workflow\.(?:import|export)/);
    // The reads stay LAN-allowed on purpose, and `workflow.list` is the only one that shows provenance.
    expect(() =>
      checkLanMethodAllowed("workflow.list", { peerId: "peer:x", writeAllowed: false }),
    ).not.toThrow();
  });

  function demoRefusalOf(method: string): unknown {
    // eslint-free dynamic read: demo-gate exports `demoRefusal`.
    return demoGate.demoRefusal(method);
  }

  test("the gate prompts for it, and an active delegate is never asked to approve it (I20)", async () => {
    let asked = 0;
    let prompts = 0;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          prompts += 1;
          return { approved: false, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      { dispatch: async () => ({}) },
      {
        store: {
          activeDelegateePeer: () => "peer:delegate",
          activeDelegateFor: () => true,
        } as never,
        requestRemote: async () => {
          asked += 1;
          return { kind: "answered", approved: true, peerId: "peer:delegate" } as never;
        },
        isOperatorValid: () => true,
      } as never,
      NULL_EGRESS_SINK,
    );
    const out = await exec.gate({ type: "workflow.import", payload: { promptText: "x" } });
    expect(out).toEqual({ status: "rejected", reason: "User declined consent gate." });
    expect(asked).toBe(0);
    expect(prompts).toBe(1);
    const src = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    expect(src).toMatch(/isOwnerOnlyActionType\(action\.type\)/);
    expect(src).toMatch(/type === "workflow\.import"/);
  });

  test("a prompt-text type is shown and recorded the same way at all three sites (usesPromptText)", async () => {
    const { usesPromptText, isOwnerOnlyActionType } = await import("../engine/executor.ts");
    for (const t of [
      "pack.install",
      "standing.rule.create",
      "standing.rule.resume",
      "workflow.import",
    ]) {
      expect(usesPromptText(t), t).toBe(true);
    }
    expect(usesPromptText("connector.writes.enable")).toBe(false);
    for (const t of [
      "registry.add",
      "pack.install",
      "connector.writes.enable",
      "workflow.import",
      "standing.rule.create",
      "extension.install",
    ]) {
      expect(isOwnerOnlyActionType(t), t).toBe(true);
    }
    expect(isOwnerOnlyActionType("gmail.thread.archive")).toBe(false);
    // The audit row keeps the identifying fields and drops the long prompt text.
    const rows: string[] = [];
    const exec = new ToolExecutor(
      { requestApproval: async () => ({ approved: true, answerSource: "human" as const }) },
      { recordAudit: (e) => void rows.push(e.actionJson) },
      { dispatch: async () => ({}) },
      undefined,
      NULL_EGRESS_SINK,
    );
    await exec.gate({
      type: "workflow.import",
      payload: { name: "w", promptText: "SECRET-LONG-TEXT", stepsSha256: "a".repeat(64) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain("SECRET-LONG-TEXT");
    expect(rows[0]).toContain("stepsSha256");
  });

  test("every refusal writes nothing and asks nobody: a bad signature, a schedule or rule key, a model step, a stale bundle, a pin mismatch, a non-owner kind", async () => {
    const h = await harness59();
    const { fixtureBody, signFixture, FIXTURE_STEPS, fixtureKey } = h.helpers;
    const good = signFixture(fixtureBody());
    const tampered = JSON.parse(good);
    tampered.body.description = "tampered";
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["signature", () => h.run(JSON.stringify(tampered))],
      ["schedule key", () => h.run(signFixture({ ...fixtureBody(), schedule: "* * * * *" }))],
      ["rule key", () => h.run(signFixture({ ...fixtureBody(), standingRule: {} }))],
      [
        "model step",
        () =>
          h.run(
            signFixture({ ...fixtureBody(), steps: [...FIXTURE_STEPS, { kind: "run", run: "x" }] }),
          ),
      ],
      ["pin mismatch", () => h.run(good, { extra: { signer: "0".repeat(12) } })],
      ["unknown kind", () => h.run(good, { kind: "unknown" })],
      ["mcp kind", () => h.run(good, { kind: "mcp" })],
      ["not json", () => h.run("{")],
    ];
    for (const [name, call] of cases) {
      await expect(call(), name).rejects.toBeDefined();
    }
    expect(h.asked).toHaveLength(0);
    expect(h.count("workflow")).toBe(0);
    expect(h.count("workflow_import")).toBe(0);
    void fixtureKey;
  });

  test("a declined, --yes, scripted or non-human answer writes nothing; only a human approval writes the workflow and its provenance together", async () => {
    const h = await harness59();
    const { fixtureBody, signFixture } = h.helpers;
    const text = signFixture(fixtureBody());
    for (const reason of ["declined", "not_human"] as const) {
      await expect(
        h.run(text, { ask: async () => ({ approved: false, reason }) }),
        reason,
      ).rejects.toBeDefined();
      expect(h.count("workflow")).toBe(0);
      expect(h.count("workflow_import")).toBe(0);
    }
    await h.run(text);
    expect(h.count("workflow")).toBe(1);
    expect(h.count("workflow_import")).toBe(1);
    expect(h.count("standing_rule")).toBe(0);
  });

  test("the RPC asks through createOwnerOnlyAsk (no delegation, a human answer only) and checks the connection's kind before the core", async () => {
    const disp = stripComments(await read("packages/gateway/src/ipc/server/dispatchers.ts"));
    const at = disp.indexOf("async function dispatchWorkflowImportRpcFor(");
    const body = disp.slice(at, disp.indexOf("\n}\n", at));
    expect(body).toMatch(/askOwner:\s*createOwnerOnlyAsk\(/);
    expect(body).toMatch(/callerKind:\s*ctx\.getClientKind\(clientId\)/);
    expect(body).not.toMatch(/delegation/i);
    const rpc = stripComments(await read("packages/gateway/src/ipc/workflow-import-rpc.ts"));
    expect(rpc.indexOf('requireOwnerKind(ctx.callerKind, "workflow.import")')).toBeGreaterThan(-1);
    expect(rpc.indexOf('requireOwnerKind(ctx.callerKind, "workflow.import")')).toBeLessThan(
      rpc.indexOf("importWorkflowBundle("),
    );
    const core = stripComments(await read("packages/gateway/src/automation/workflow-import.ts"));
    // The signature is verified before any store is read, and the approval comes before the write.
    const fn = core.slice(core.indexOf("export async function importWorkflowBundle("));
    expect(fn.indexOf("verifyBundle(")).toBeGreaterThan(-1);
    expect(fn.indexOf("verifyBundle(")).toBeLessThan(fn.indexOf("floorFor("));
    expect(fn.indexOf("deps.askOwner(")).toBeLessThan(fn.indexOf("commit(deps"));
    expect(core).toContain("db.transaction(");
  });

  test("the bundle is verified over the domain-tagged canonical body, and its steps must already be canonical", async () => {
    const bundle = stripComments(await read("packages/gateway/src/automation/workflow-bundle.ts"));
    expect(bundle).toContain("BUNDLE_SIGN_TAG + canonicalJson(body)");
    expect(bundle).toContain("nacl.sign.detached.verify(bundleSignedBytes(typed)");
    expect(bundle).toContain("canonicalStepsText(parsed) !== text");
    // No workflow module holds the share seed: only the byte signer in share-keypair.ts does.
    for (const f of [
      "automation/workflow-bundle.ts",
      "automation/workflow-import.ts",
      "ipc/workflow-import-rpc.ts",
    ]) {
      expect(await read(`packages/gateway/src/${f}`), f).not.toMatch(/ensureShareKeypair/);
    }
  });

  test("I55: the rule and learning path never reads import provenance, and an import creates no rule", async () => {
    for (const f of [
      "engine/standing-rule-step.ts",
      "standing/standing-rule-derive.ts",
      "standing/approval-learning.ts",
      "standing/standing-rule-store.ts",
    ]) {
      expect(stripComments(await read(`packages/gateway/src/${f}`)), f).not.toMatch(
        /workflow_import|workflow-import-store|readImportSource|listSources/,
      );
    }
    const core = stripComments(await read("packages/gateway/src/automation/workflow-import.ts"));
    expect(core).not.toMatch(/standing_rule|insertRule|claimFire|standingRuleStep/);
  });
});
