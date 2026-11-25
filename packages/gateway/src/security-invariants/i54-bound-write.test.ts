import { describe, expect, test } from "bun:test";
import {
  checkBoundCapabilities,
  checkBoundWrites,
  checkIacDiscard,
  RULE_ANCHORS,
} from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import {
  SYNTH_PREPARE_IDS,
  SYNTH_REPLY,
  synthBoundRow,
} from "../connectors/connector-writes/bound-fixtures.test-helpers.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { PREPARE_TOOL_IDS } from "../connectors/connector-writes/prepare-tools.ts";
import { createConnectorDispatcher } from "../connectors/registry.ts";
import { BOUND_VIA_GATE_REASON, NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";

describe("I54 — a bound connector write is dispatched only with the values its own gate-run prepare step produced", () => {
  const action = (input: Record<string, unknown>): PlannedAction => ({
    type: "iac.terraform.apply",
    payload: { mcpToolId: "iac_synth_apply", input },
  });

  /** An executor over the synthetic bound row (through the test seam), recording every dispatch. */
  function boundExecutor(approve = true) {
    const dispatched: PlannedAction[] = [];
    const prompts: string[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async (prompt) => {
          prompts.push(prompt);
          return { approved: approve, answerSource: "human" as const };
        },
      },
      { recordAudit: () => undefined },
      {
        dispatch: async (a) => {
          dispatched.push(a);
          return a.type.endsWith(".write.prepare") ? SYNTH_REPLY : { applied: true };
        },
      },
      undefined,
      { append: () => undefined },
      NO_POLICY_OVERLAY,
      undefined,
      undefined,
      { rows: [synthBoundRow(3)], prepareToolIds: SYNTH_PREPARE_IDS },
    );
    return { exec, dispatched, prompts };
  }

  test("IaC drift D2 (OR-DRIFT-1): the drift check is the ONE other prepare caller, asks nobody and never dispatches an apply", async () => {
    // D42(i) exists, run() calls it, and the production tree is clean.
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain('"bound-drift-confined"');
    expect(audit).toMatch(/\.\.\.checkDriftCheckConfined\(files\)/);
    const { checkDriftCheckConfined } = await import(
      "../../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    const files = [];
    for (const rel of [
      "packages/gateway/src/engine/run-ask.ts",
      "packages/gateway/src/engine/executor.ts",
      "packages/gateway/src/gateway-main.ts",
      "packages/gateway/src/iac-drift/drift-runner.ts",
    ]) {
      files.push({ relPath: rel, contents: await read(rel) });
    }
    expect(checkDriftCheckConfined(files)).toEqual([]);
    expect(
      checkDriftCheckConfined([
        ...files,
        { relPath: "packages/gateway/src/ipc/rogue.ts", contents: "exec.checkTerraformDrift(d);" },
      ]),
    ).toHaveLength(1);
    // The builder's consent denies without asking; the only extra it sets is the drift flag.
    const runAsk = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    const builder = runAsk.slice(runAsk.indexOf("export function buildIacDriftExecutor("));
    expect(builder.slice(0, builder.indexOf("\n}\n"))).toMatch(
      /newExecutorOnChannel\(\s*p,\s*NEVER_ASKED_CONSENT,\s*undefined,\s*\{ driftCheck: true \},\s*p\.localIndex,?\s*\)/,
    );
    // Behaviour: a drift executor over the real Terraform row never prompts and never dispatches the apply.
    const dispatched: PlannedAction[] = [];
    let asked = 0;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          asked += 1;
          return { approved: true, answerSource: "human" as const };
        },
      },
      { recordAudit: () => undefined },
      {
        dispatch: async (a) => {
          dispatched.push(a);
          return { planId: "a".repeat(32), planFile: "/x/plan.tfplan", hasChanges: true };
        },
        boundWriteCapabilities: {
          preflight: async () => ({ ok: true, release: () => undefined }),
          settle: async () => ({
            values: { planFile: "/p", planSha256: "d".repeat(64) },
            fields: [{ label: "Workdir", value: "/w" }],
            plan: {
              lines: ["Drift: none reported by terraform"],
              text: "",
              bytes: 0,
              sha256: "e".repeat(64),
            },
            cleanup: async () => undefined,
          }),
        },
      },
      undefined,
      { append: () => undefined },
      NO_POLICY_OVERLAY,
      undefined,
      { driftCheck: true },
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const r = await exec.checkTerraformDrift(join(tmpdir(), "nimbus-i54-drift"));
    expect(r.ok).toBe(true);
    expect(asked).toBe(0);
    expect(dispatched.map((a) => a.type)).toEqual(["iac.write.prepare"]);
    // The namespace is LAN-forbidden; only the read `iac.driftLatest` is on the Tauri allowlist (the check is not).
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    expect(() =>
      checkLanMethodAllowed("iac.driftCheck", { peerId: "p", writeAllowed: true }),
    ).toThrow(/not callable over LAN/);
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    const list = rust.slice(rust.indexOf("pub const ALLOWED_METHODS"), rust.indexOf("];"));
    expect([...list.matchAll(/"(iac\.[A-Za-z]+)"/g)].map((m) => m[1])).toEqual(["iac.driftLatest"]);
    expect(rust).toContain(
      'is_method_allowed("iac.driftLatest") && !is_method_allowed("iac.driftCheck")',
    );
    // A demo gateway refuses the whole namespace at the demo gate, before any dispatcher (I41)...
    const { demoRefusal } = await import("../ipc/server/demo-gate.ts");
    expect(demoRefusal("iac.driftCheck")).toBeDefined();
    expect(demoRefusal("iac.driftLatest")).toBeDefined();
    expect(demoRefusal("connector.status")).toBeUndefined();
    // ...an unbound runner refuses a check without running anything, while a bound one runs (the control)...
    const { dispatchIacDriftRpc, IAC_DRIFT_UNAVAILABLE } = await import("../ipc/iac-drift-rpc.ts");
    await expect(
      dispatchIacDriftRpc(
        "iac.driftCheck",
        {},
        { runner: () => undefined },
        { kind: "cli", clientId: "c" },
      ),
    ).rejects.toThrow(IAC_DRIFT_UNAVAILABLE);
    let ran = 0;
    const bound = {
      check: async () => {
        ran += 1;
        return [];
      },
      latest: () => [],
      accept: async () => ({ status: "accepted" as const }),
      running: () => false,
      wasRunningAt: () => false,
    };
    await dispatchIacDriftRpc(
      "iac.driftCheck",
      {},
      { runner: () => bound },
      { kind: "cli", clientId: "c" },
    );
    expect(ran).toBe(1);
    // ...and gateway-main binds the runner only inside the non-demo branch.
    const bindAt = stripComments(await read("packages/gateway/src/gateway-main.ts")).indexOf(
      "platform.bindIacDriftRunner(",
    );
    // A demo gateway builds neither the runner nor the scheduler (I41).
    const main = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    const at = main.indexOf("const iacDriftScheduler =");
    expect(main.slice(at, at + 200)).toMatch(/platform\.paths\.demo === true\s*\?\s*undefined/);
    expect(main.split("platform.bindIacDriftRunner(")).toHaveLength(2);
    expect(bindAt).toBeGreaterThan(at);
  });

  test("D42 exists with its clauses, run() calls it, and its files are anchors", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    for (const id of [
      "bound-prepare-literal-confined",
      "bound-name-confined",
      "bound-order-pinned",
      "bound-seam-not-production",
      "bound-prepare-set-frozen",
      "bound-public-gate-refuses",
    ]) {
      expect(audit).toContain(id);
    }
    const runAt = audit.indexOf("async function run(");
    expect(audit.slice(runAt)).toContain("checkBoundWrites(files)");
    for (const anchor of [
      "packages/gateway/src/engine/executor.ts",
      "packages/gateway/src/engine/prepare-step.ts",
      "packages/gateway/src/connectors/registry.ts",
      "packages/gateway/src/connectors/connector-writes/prepare-tools.ts",
    ]) {
      expect(RULE_ANCHORS).toContain(anchor);
    }
  });

  test("the production tree has no violation of D42, and D42 rejects a rogue seam, a rogue injection and a rogue prepare set write", async () => {
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(checkBoundWrites(files)).toEqual([]);
    const rogue = [
      ...files,
      {
        relPath: "packages/gateway/src/ipc/rogue.ts",
        contents:
          "const e = new ToolExecutor(a, b, c, d, f, g, h, i, table);\ninjectBoundFields(act, binds, values);\nPREPARE_TOOL_IDS.add(x);\n",
      },
    ];
    expect(new Set(checkBoundWrites(rogue).map((v) => v.rule))).toEqual(
      new Set(["bound-seam-not-production", "bound-name-confined", "bound-prepare-set-frozen"]),
    );
  });

  test("D43 and D42(h) exist, run() calls them, the production tree is clean and a rogue file is rejected", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    const runAt = audit.indexOf("async function run(");
    expect(audit.slice(runAt)).toContain("checkIacDiscard(files)");
    expect(audit.slice(runAt)).toContain("checkBoundCapabilities(files)");
    for (const id of [
      "discard-step-confined",
      "discard-name-confined",
      "discard-order-pinned",
      "bound-capability-confined",
      "bound-capability-calls",
    ]) {
      expect(audit).toContain(id);
    }
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(checkIacDiscard(files)).toEqual([]);
    expect(checkBoundCapabilities(files)).toEqual([]);
    const rogue = {
      relPath: "packages/gateway/src/ipc/rogue.ts",
      contents:
        'gate(a, undefined, { discardStep: t });\nconst k = "iac_cloudformation_changeset_discard";\nd.boundWriteCapabilities;\n',
    };
    expect(new Set(checkIacDiscard([...files, rogue]).map((v) => v.rule))).toEqual(
      new Set(["discard-step-confined", "discard-name-confined"]),
    );
    expect(checkBoundCapabilities([...files, rogue]).map((v) => v.rule)).toEqual([
      "bound-capability-confined",
    ]);
  });

  test("the prepare set is exactly the eight declared tools, frozen; the bound production rows name members of it (D1c, D2, D3a)", () => {
    expect(
      CONNECTOR_WRITE_ROWS.filter((r) => r.bound !== undefined)
        .map((r) => r.toolId)
        .sort(),
    ).toEqual(
      [
        "github_file_commit",
        "gitlab_commit_create",
        "iac_cloudformation_deploy",
        "iac_terraform_apply",
        "iac_terraform_apply_refresh_only",
        "iac_terraform_destroy",
        "k8s_manifest_apply",
      ].sort(),
    );
    expect([...PREPARE_TOOL_IDS].sort()).toEqual([
      "github_commit_prepare",
      "gitlab_commit_prepare",
      "iac_cloudformation_changeset_create",
      "iac_terraform_destroy_plan",
      "iac_terraform_plan",
      "iac_terraform_plan_refresh_only",
      "iac_terraform_show_json",
      "k8s_manifest_plan",
    ]);
    for (const r of CONNECTOR_WRITE_ROWS.filter((x) => x.bound !== undefined)) {
      expect(PREPARE_TOOL_IDS.has(r.bound?.prepare.tool ?? ""), r.toolId).toBe(true);
    }
    expect(() => (PREPARE_TOOL_IDS as unknown as Set<string>).add("x_plan")).toThrow(TypeError);
    expect(PREPARE_TOOL_IDS.size).toBe(8);
  });

  test("the Kubernetes apply (D3a) is the sixth bound row: settled by the gateway's own pure settler, reached only through the capability, with both hashes gateway-computed", async () => {
    const row = CONNECTOR_WRITE_ROWS.find((r) => r.toolId === "k8s_manifest_apply");
    expect(row?.bound?.prepare.settle).toBe("k8s-manifest");
    expect(row?.bound?.prepare.preflight).toBe("kubernetes");
    expect(row?.bound?.prepare.tool).toBe("k8s_manifest_plan");
    // Both identities are bound; the model never sees either (the door strips every bound field).
    expect(row?.bound?.binds.map((b) => b.field)).toEqual(["planSha256", "diffSha256"]);
    // The settler is named by its own module and the registry's capability only; the executor
    // reaches it through `boundWriteCapabilities.settle` and never by name.
    const registry = stripComments(await read("packages/gateway/src/connectors/registry.ts"));
    expect(registry.match(/\bsettleK8sManifest\(/g) ?? []).toHaveLength(1);
    const executor = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    expect(executor).not.toMatch(/settleK8sManifest/);
    // The settler computes both hashes itself and compares the reply's to them in constant time.
    const settle = stripComments(await read("packages/gateway/src/engine/k8s-settle.ts"));
    expect(settle).toMatch(/const planSha256 = k8sPlanHash\(context, namespace, manifest\)/);
    expect(settle).toMatch(/const diffSha256 = k8sDiffHash\(diff\)/);
    expect(settle.match(/sha256HexEqualConstantTime\(/g) ?? []).toHaveLength(2);
    // A pod's manifest text is never in the audit: the kubernetes apply is a text-carrying type.
    const { carriesTemplateText } = await import("../engine/audit-bodies.ts");
    expect(carriesTemplateText("kubernetes.manifest.apply")).toBe(true);
    expect(carriesTemplateText("kubernetes.write.prepare")).toBe(true);
  });

  test("the public gate() never binds: a bound row reaching it is refused, audited and not dispatched", async () => {
    const { exec, dispatched } = boundExecutor();
    const res = await exec.gate(action({ dir: "prod" }));
    expect(res).toEqual({ status: "rejected", reason: BOUND_VIA_GATE_REASON });
    expect(dispatched).toEqual([]);
  });

  test("a caller-supplied bound field is refused before any read or prompt, at the root, in input, and flat", async () => {
    for (const forged of [
      { type: "iac.terraform.apply", payload: { planDigest: "x", input: { dir: "prod" } } },
      action({ dir: "prod", planDigest: "x" }),
      { type: "iac.terraform.apply", payload: { dir: "prod", planDigest: "x" } },
    ] as PlannedAction[]) {
      const { exec, dispatched, prompts } = boundExecutor();
      const res = await exec.execute(forged);
      expect(res.status).toBe("rejected");
      expect(dispatched).toEqual([]);
      expect(prompts).toEqual([]);
    }
  });

  test("an approved bound write is dispatched with the gateway's own prepared value and nothing else bound", async () => {
    const { exec, dispatched, prompts } = boundExecutor();
    const res = await exec.execute(action({ dir: "prod" }));
    expect(res.status).toBe("ok");
    expect(prompts[0]).toContain("Prepared:");
    const writes = dispatched.filter((a) => !a.type.endsWith(".write.prepare"));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.payload?.["input"]).toEqual({
      dir: "prod",
      planDigest: SYNTH_REPLY.digest,
    });
    // Declined: the prepare read ran, the write did not.
    const declined = boundExecutor(false);
    expect((await declined.exec.execute(action({ dir: "prod" }))).status).toBe("rejected");
    expect(declined.dispatched.filter((a) => !a.type.endsWith(".write.prepare"))).toEqual([]);
  });

  test("the dispatcher refuses a prepare tool outside the prepare step", async () => {
    const d = createConnectorDispatcher(
      { listTools: async () => ({ iac_synth_plan: { execute: async () => "ran" } }) },
      { prepareToolIds: SYNTH_PREPARE_IDS },
    );
    await expect(
      d.dispatch({ type: "iac.terraform.apply", payload: { mcpToolId: "iac_synth_plan" } }),
    ).rejects.toThrow(/ERR_PREPARE_OUTSIDE_STEP/);
    await expect(
      d.dispatch({ type: "iac.write.prepare", payload: { mcpToolId: "iac_synth_plan" } }),
    ).resolves.toBe("ran");
  });

  test("the prepare phase runs before any approval: resolveHitlApproval orders it after the before-state and the preflight, and before the confirm text and the approval", async () => {
    const exec = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    const at = exec.indexOf("private async resolveHitlApproval(");
    const body = exec.slice(at, exec.indexOf("\n  }\n", at));
    const order = [
      "this.captureBeforePhase(",
      "this.preflightPhase(",
      "this.preparePhase(",
      "this.renderConfirmPhase(",
      "this.approvalPhase(",
    ].map((s) => body.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
