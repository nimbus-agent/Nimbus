import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkBeforeStateRead,
  checkConfirmComparison,
  checkModelWriteDoor,
  RULE_ANCHORS,
} from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import {
  censusCapabilities,
  censusPrepareReply,
  confirmableInput,
  read,
  readDirFiles,
  SRC_ROOT,
} from "../../test/helpers/security-invariants.ts";
import { isConnectorWriteToolId } from "../connectors/connector-write-registry.ts";
import {
  COMMIT_CREDENTIAL_REFUSAL,
  COMMIT_PATH_REFUSAL,
} from "../connectors/connector-writes/commit-paths.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  modelWriteRefusal,
  REMOTE_CONTENT_REFUSAL,
  remoteContentScannedRows,
} from "../connectors/connector-writes/model-write-refusals.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { PlannedAction } from "../engine/types.ts";

describe("I53 — a first-party connector write reaches the model only through the owner-turn door", () => {
  test("D0a: every Wave 4 write on every door reaches dispatch only after an exact type-to-confirm match at the executor gate", async () => {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    const wave4 = CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 4);
    expect(wave4).toHaveLength(52);
    const failures: string[] = [];
    for (const row of wave4) {
      const input = confirmableInput(row);
      const action = {
        type: row.actionType,
        payload: row.transport === "mesh" ? { mcpToolId: row.toolId, input } : input,
      };
      // A bound row (D1c) is prepared first; the fake connector answers that read.
      const prepared = censusPrepareReply(row, input);
      const refusedByRow = row.refuse !== undefined;
      const attempt = async (
        channel: "plain" | "exact" | "wrong" | "empty",
      ): Promise<{ status: string; dispatched: number; plainAsked: number }> => {
        let dispatched = 0;
        let plainAsked = 0;
        const exec = new ToolExecutor(
          {
            requestApproval: async () => {
              plainAsked += 1;
              return { approved: true, answerSource: "human" as const };
            },
            ...(channel === "plain"
              ? {}
              : {
                  requestConfirmedApproval: async (req: { confirmText: string }) => ({
                    approved: true,
                    typed:
                      channel === "exact"
                        ? req.confirmText
                        : channel === "wrong"
                          ? `${req.confirmText} `
                          : "",
                    answerSource: "human" as const,
                  }),
                }),
          },
          { recordAudit: () => {} },
          {
            dispatch: async (a: { type: string }) => {
              if (prepared !== undefined && a.type.endsWith(".write.prepare")) return prepared;
              // D2 (static D43): the gateway's own discard of an unused change set is not the write.
              if (
                a.type === "iac.cloudformation.changeset.discard" &&
                row.actionType !== "iac.cloudformation.changeset.discard"
              ) {
                return {};
              }
              dispatched += 1;
              return {};
            },
            ...censusCapabilities(row),
          },
          undefined,
          NULL_EGRESS_SINK,
          NO_POLICY_OVERLAY,
        );
        const res = await exec.execute(action);
        return { status: res.status, dispatched, plainAsked };
      };
      // A row the gate refuses itself (D2: the Pulumi apply): refused on every channel, nobody asked.
      if (refusedByRow) {
        for (const channel of ["plain", "exact", "wrong", "empty"] as const) {
          const r = await attempt(channel);
          if (r.status !== "rejected" || r.dispatched !== 0 || r.plainAsked !== 0) {
            failures.push(`${row.toolId}: a row-refused write ran on the ${channel} channel`);
          }
        }
        continue;
      }
      const plain = await attempt("plain");
      if (plain.status !== "rejected" || plain.dispatched !== 0 || plain.plainAsked !== 0) {
        failures.push(`${row.toolId}: a plain-only channel approved or was asked`);
      }
      for (const bad of ["wrong", "empty"] as const) {
        const r = await attempt(bad);
        if (r.status !== "rejected" || r.dispatched !== 0) failures.push(`${row.toolId}: ${bad}`);
      }
      const exact = await attempt("exact");
      if (exact.status !== "ok" || exact.dispatched !== 1 || exact.plainAsked !== 0) {
        failures.push(`${row.toolId}: the exact text did not approve alone`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("D0a: a Wave 4 tool named by mcpToolId runs only under its own action type, whatever the type's HITL class (the pairing, at the gate and at the dispatcher)", async () => {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    const { createConnectorDispatcher } = await import("../connectors/registry.ts");
    const wave4 = CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 4 && r.transport === "mesh");
    expect(wave4).toHaveLength(44);
    const failures: string[] = [];
    for (const row of wave4) {
      const input = confirmableInput(row);
      const other = wave4.find((r) => r.actionType !== row.actionType)?.actionType ?? "";
      const key = `${serviceOf(row.actionType)}_${row.toolId}`;
      for (const type of ["search.run", "pipeline.trigger", other]) {
        for (const mcpToolId of [row.toolId, key]) {
          let dispatched = 0;
          let asked = 0;
          const exec = new ToolExecutor(
            {
              requestApproval: async () => {
                asked += 1;
                return { approved: true, answerSource: "human" as const };
              },
              requestConfirmedApproval: async (req: { confirmText: string }) => {
                asked += 1;
                return { approved: true, typed: req.confirmText, answerSource: "human" as const };
              },
            },
            { recordAudit: () => {} },
            {
              dispatch: async () => {
                dispatched += 1;
                return {};
              },
            },
            undefined,
            NULL_EGRESS_SINK,
            NO_POLICY_OVERLAY,
          );
          const res = await exec.execute({ type, payload: { mcpToolId, input } });
          if (res.status !== "rejected" || dispatched !== 0 || asked !== 0) {
            failures.push(`${type} + ${mcpToolId}: ran or asked`);
          }
        }
      }
      // The dispatcher refuses it on its own, with the gate out of the picture.
      let ran = 0;
      const d = createConnectorDispatcher({
        listTools: async () => ({
          [key]: {
            execute: async () => {
              ran += 1;
              return {};
            },
          },
        }),
      });
      const err = await d.dispatch({ type: "search.run", payload: { mcpToolId: key, input } }).then(
        () => "",
        (e: unknown) => String(e),
      );
      if (ran !== 0 || !err.includes("ERR_WRITE_TOOL_ACTION_MISMATCH")) {
        failures.push(`${key}: the dispatcher ran it under search.run`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("D0a: a Wave 4 row is model-offerable only with a before reader AND a confirm target; the seven mail sends are never offered", async () => {
    const { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } = await import(
      "../connectors/connector-writes/model-offerable.ts"
    );
    const template = { target: "t", summary: "s", fields: [] };
    const reader = {
      tool: "x_get",
      argKeys: ["id"],
      args: (i: Readonly<Record<string, unknown>>) => ({ id: i["id"] }),
      select: () => [],
    };
    const base = {
      toolId: "x_y",
      actionType: "x.y",
      transport: "write" as const,
      wave: 4 as const,
      preview: template,
    };
    expect(isModelOfferableRow({ ...base, before: reader })).toBe(false);
    expect(isModelOfferableRow({ ...base, confirm: { template: "{id}" } })).toBe(false);
    expect(isModelOfferableRow({ ...base, before: reader, confirm: { template: "{id}" } })).toBe(
      true,
    );
    // The seven mail sends (OR-W34-1), since D1 the Bitbucket merge (no head precondition), and
    // since D2 the rows that stay owner-only: Terraform destroy, Pulumi, the change-set discard and
    // (OR-S4-DRIFT) the accept-drift apply (D3a took the Kubernetes apply off the list: it is offered while a pair is approved),
    // and since the Phase 9.7 close (OR-97-1) the four az/gcloud-read cloud rows and the pod delete.
    expect(MODEL_NEVER_OFFERED_TOOL_IDS.size).toBe(17);
    expect(MODEL_NEVER_OFFERED_TOOL_IDS.has("gcp_cloud_run_deploy")).toBe(true);
    expect(MODEL_NEVER_OFFERED_TOOL_IDS.has("bitbucket_pr_merge")).toBe(true);
    for (const r of CONNECTOR_WRITE_ROWS) {
      if (r.wave === 4) expect(r.confirm, r.toolId).toBeDefined();
    }
  });

  test("D1 (source): isModelOfferableRow checks the never-offered set first and needs a before reader or a bound write AND a confirm target for every Wave 4 row", async () => {
    const src = stripComments(
      await read("packages/gateway/src/connectors/connector-writes/model-offerable.ts"),
    );
    const body = src.slice(src.indexOf("export function isModelOfferableRow("));
    expect(body.indexOf("MODEL_NEVER_OFFERED_TOOL_IDS.has(row.toolId)")).toBeGreaterThan(-1);
    expect(body.indexOf("MODEL_NEVER_OFFERED_TOOL_IDS.has(row.toolId)")).toBeLessThan(
      body.indexOf("row.preview !== undefined"),
    );
    expect(body.replaceAll(/\s+/g, " ")).toContain(
      "row.preview !== undefined && (row.wave < 4 || ((row.before !== undefined || row.bound !== undefined) && row.confirm !== undefined))",
    );
  });

  test("D1: every model-offerable Wave 4 row has a reader the before-read dispatcher accepts (a read of its own connector), and a connector write is never one", async () => {
    const { isModelOfferableRow } = await import(
      "../connectors/connector-writes/model-offerable.ts"
    );
    const { isReadOnlyToolId } = await import("../share/read-tool-registry.ts");
    const offeredWave4 = CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 4 && isModelOfferableRow(r));
    // 28 through a before-state (D1, and the 0.20.0 Calendar delete), the two bound commits (D1c), the Terraform apply
    // and CloudFormation deploy (D2) through a prepare step, and the seven deploy-trigger and
    // mobile-release writes (D3b) through a before-state, the Kubernetes apply (D3a) through a
    // prepare step and the Kubernetes restart and scale (D3c) through a before-state; the destroy
    // is bound but never offered.
    expect(offeredWave4).toHaveLength(42);
    expect(offeredWave4.filter((r) => r.bound !== undefined).map((r) => r.toolId)).toEqual([
      "github_file_commit",
      "gitlab_commit_create",
      "iac_terraform_apply",
      "iac_cloudformation_deploy",
      "k8s_manifest_apply",
    ]);
    for (const r of offeredWave4.filter((x) => x.bound === undefined)) {
      expect(r.before, r.toolId).toBeDefined();
      expect(r.confirm, r.toolId).toBeDefined();
      const tools = [r.before?.tool, r.before?.also?.tool].filter(
        (t): t is string => t !== undefined,
      );
      for (const tool of tools) {
        // The dispatcher (`assertBeforeReadIsOwnRead`) refuses any other tool, so an `az` /
        // `gcloud` read (code-execution class) can back no model-offered row.
        expect(isReadOnlyToolId(tool), `${r.toolId} reads ${tool}`).toBe(true);
        expect(isConnectorWriteToolId(tool), `${r.toolId} reads ${tool}`).toBe(false);
      }
    }
    // A Wave 4 row with a preview and a confirm text but no reader is never offered.
    for (const id of [
      "azure_app_service_restart",
      "azure_aks_node_pool_scale",
      "gcp_cloud_run_deploy",
    ]) {
      const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === id);
      expect(r?.before, id).toBeUndefined();
      expect(r !== undefined && isModelOfferableRow(r), id).toBe(false);
    }
  });

  test("D1 (behaviour): a Wave 4 model write whose current state cannot be read is refused before any prompt, dispatches no write and is ledgered as blocked", async () => {
    const { ToolExecutor, NO_POLICY_OVERLAY } = await import("../engine/executor.ts");
    const { createBeforeStateRunner, WAVE4_BEFORE_REFUSAL } = await import(
      "../engine/before-state.ts"
    );
    const { row, withPreview, withConfirm } = await import(
      "../connectors/connector-writes/types.ts"
    );
    const { mcpClientToolKey } = await import("../connectors/lazy-mesh/tool-map.ts");
    // A Wave 4 row with a preview and a confirm text but no reader (nothing to read).
    const noReader = withConfirm(
      withPreview(row("jenkins_build_abort", "jenkins.build.abort", "mesh", 4), {
        target: "{jobName}",
        summary: "Abort {jobName}",
        fields: [],
      }),
      { template: "abort {jobName}" },
    );
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly rows: readonly ConnectorWriteRow[] | undefined;
      readonly toolId: string;
      readonly input: Record<string, unknown>;
      readonly reply: () => unknown;
      readonly reason: string;
      readonly dispatched: readonly string[];
    }> = [
      {
        name: "the read fails",
        rows: undefined,
        toolId: "jenkins_build_trigger",
        input: { jobName: "deploy" },
        reply: () => {
          throw new Error("down");
        },
        reason: WAVE4_BEFORE_REFUSAL,
        dispatched: ["jenkins.before.read"],
      },
      {
        name: "the reply names no job",
        rows: undefined,
        toolId: "jenkins_build_trigger",
        input: { jobName: "deploy" },
        reply: () => ({ content: [{ type: "text", text: "{}" }] }),
        reason: WAVE4_BEFORE_REFUSAL,
        dispatched: ["jenkins.before.read"],
      },
      {
        name: "the reader cannot be built from the input",
        rows: undefined,
        toolId: "jenkins_build_trigger",
        input: { jobName: "" },
        reply: () => ({}),
        reason: WAVE4_BEFORE_REFUSAL,
        dispatched: [],
      },
      {
        name: "the row has no reader",
        rows: [noReader],
        toolId: "jenkins_build_abort",
        input: { jobName: "deploy" },
        reply: () => ({}),
        reason: WAVE4_BEFORE_REFUSAL,
        dispatched: [],
      },
      {
        name: "a GitHub merge names no head sha (the guard's own reason)",
        rows: undefined,
        toolId: "github_pr_merge",
        input: { owner: "acme", repo: "api", pullNumber: 42 },
        reply: () => ({
          content: [
            { type: "text", text: JSON.stringify({ title: "T", head: { sha: "a".repeat(40) } }) },
          ],
        }),
        reason:
          "the merge must name the pull request's current head commit as sha, and it is not that commit",
        dispatched: ["github.before.read"],
      },
    ];
    for (const c of cases) {
      const target = CONNECTOR_WRITE_ROWS.find((r) => r.toolId === c.toolId);
      const actionType = c.rows?.[0]?.actionType ?? target?.actionType ?? "";
      let prompts = 0;
      const dispatched: string[] = [];
      const egress: string[] = [];
      const exec = new ToolExecutor(
        {
          requestApproval: async () => {
            prompts += 1;
            return { approved: true, answerSource: "human" as const };
          },
        },
        { recordAudit: () => {} },
        {
          dispatch: async (a) => {
            dispatched.push(a.type);
            return c.reply();
          },
        },
        undefined,
        { append: (e) => void egress.push(`${e.method}:${e.resultStatus}`) },
        NO_POLICY_OVERLAY,
        undefined,
        { beforeState: createBeforeStateRunner(c.rows === undefined ? {} : { rows: c.rows }) },
      );
      const out = await exec.execute({
        type: actionType,
        origin: "model",
        payload: {
          mcpToolId: mcpClientToolKey(serviceOf(actionType), c.toolId),
          input: c.input,
        },
      });
      expect(out, c.name).toEqual({ status: "rejected", reason: c.reason });
      expect(prompts, c.name).toBe(0);
      expect(dispatched, c.name).toEqual([...c.dispatched]);
      expect(egress[egress.length - 1], c.name).toBe(`${actionType}:blocked`);
    }
  });

  test("D41 exists with its clauses, run() calls it, and its files are anchors", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    for (const id of [
      "confirm-channel-confined",
      "confirm-coordinator-confined",
      "confirm-render-confined",
      "confirm-comparison-confined",
      "confirm-order-pinned",
    ]) {
      expect(audit).toContain(id);
    }
    const runAt = audit.indexOf("async function run(");
    expect(audit.slice(runAt)).toContain("checkConfirmComparison(files)");
    for (const anchor of [
      "packages/gateway/src/engine/executor.ts",
      "packages/gateway/src/ipc/capture-rpc.ts",
      "packages/gateway/src/ipc/consent.ts",
    ]) {
      expect(RULE_ANCHORS).toContain(anchor);
    }
  });

  test("the production tree has no violation of D41, and D41 rejects a rogue channel call and a rogue comparison", async () => {
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(checkConfirmComparison(files)).toEqual([]);
    const rogue = [
      ...files,
      {
        relPath: "packages/gateway/src/ipc/rogue.ts",
        contents:
          "async function f(c, text) {\n  const a = await c.requestConfirmedApproval(r);\n  return a.typed === text;\n}\n",
      },
    ];
    expect(checkConfirmComparison(rogue).map((v) => v.rule)).toEqual([
      "confirm-channel-confined",
      "confirm-comparison-confined",
    ]);
  });

  test("D0a: the strict comparison lives in the executor with no trim or case fold; the coordinator never judges", async () => {
    const exec = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    const at = exec.indexOf("private async confirmedOwnerPrompt(");
    const body = exec.slice(at, exec.indexOf("\n  }\n", at));
    expect(body).toContain("answer.typed === req.confirmText");
    expect(body).not.toMatch(/trim|toLowerCase|toUpperCase|localeCompare|normalize/);
    const consent = stripComments(await read("packages/gateway/src/ipc/consent.ts"));
    expect(consent).not.toMatch(/\.typed\s*[!=]==|confirmText\s*[!=]==\s*(?!undefined)\S/);
    // The plain channel method keeps its three parameters; its answer now names its source (SA1).
    const types = stripComments(await read("packages/gateway/src/engine/types.ts"));
    expect(types).toMatch(
      /requestApproval\(\s*prompt: string,\s*details\?: Record<string, unknown>,\s*actionType\?: string,\s*\): Promise<ApprovalAnswer>;/,
    );
  });

  // Wiring pins read the real sources; behaviour is driven through the REAL door builder with a
  // recording executor. The end-to-end prompt-injection proof (real runAsk, real ToolExecutor, an
  // active in-scope delegate) is `engine/connector-write-injection.test.ts`.
  const DOOR_PATH = "packages/gateway/src/engine/connector-write-agent-tools.ts";

  test("the door's executor is built with NO delegation (the first layer)", async () => {
    const src = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    // Phase 28 AD1: the model door and the MCP act door are one-line calls of ONE private maker,
    // `newDoorExecutor`, which holds the (absent) delegation and the runner.
    const at = src.indexOf("function newDoorExecutor(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    // Delegation is argument 3 (`undefined`); argument 4 is the extras object (Phase 10 SA3), whose
    // `beforeState` is the runner (spec § 5.4), built WITHOUT `readsEveryOrigin`, and which carries
    // no standing-rule dependencies.
    expect(body).toMatch(
      /newExecutorOnChannel\(\s*p,\s*consent,\s*undefined,\s*\{\s*beforeState:\s*createBeforeStateRunner\(/,
    );
    expect(body).not.toContain("standingRules");
    expect(body).not.toContain("delegation");
    expect(body).not.toContain("readsEveryOrigin");
    for (const builder of ["buildModelWriteExecutor", "buildAgentWriteExecutor"]) {
      const bAt = src.indexOf(`export function ${builder}(`);
      expect(bAt, builder).toBeGreaterThan(-1);
      const bBody = src.slice(bAt, src.indexOf("\n}\n", bAt));
      expect(bBody, builder).toContain("newDoorExecutor(");
      expect(bBody, builder).not.toContain("standingRules");
      expect(bBody, builder).not.toContain("delegation");
    }
  });

  test("SA2/SA4: the workflow write step's executor is built with NO delegation and the before-state runner", async () => {
    const src = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    // SA4: both workflow builders are one-line calls of the private maker, which holds the runner.
    const at = src.indexOf("function newWorkflowWriteExecutor(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toMatch(
      /newExecutorOnChannel\(\s*p,\s*consent,\s*undefined,\s*\{\s*beforeState:\s*createBeforeStateRunner\(/,
    );
    expect(body).not.toContain("delegation");
    expect(body).toMatch(
      /guardContext:\s*\(\)\s*=>\s*\(\{\s*kb:\s*p\.getTribalKbConfig\(\)\s*\}\)/,
    );
    // It offers nothing to the model: the request-context field the door reads is never set here.
    expect(body).not.toContain("connectorWriteExecutor");
  });

  test("SA2: gateway-main builds the workflow executor per run on the run's client and passes the dispatcher's trigger", async () => {
    const src = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    const at = src.indexOf("platform.ipc.setWorkflowRunHandler(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n  });\n", at));
    expect(body).toContain("buildWorkflowWriteExecutor({");
    expect(body).toMatch(/clientId:\s*ctx\.clientId/);
    expect(body).toMatch(/consentCoordinator:\s*platform\.ipc\.consent/);
    // The trigger is the IPC dispatcher's (ctx.trigger), never read from params here.
    expect(body).toMatch(/trigger:\s*ctx\.trigger/);
    // A demo-rooted gateway builds none (I41).
    expect(body).toMatch(/platform\.paths\.demo === true/);
  });

  test("B3 (R11): the door's runner is built WITH the KB config accessor, which run-ask requires", async () => {
    const src = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    // Phase 28 AD1: the runner is built in the door maker, shared by the model door and the act door.
    const at = src.indexOf("function newDoorExecutor(");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    // The CALL's argument text, not the bare name: `guardContext` must be a property of the
    // object passed to `createBeforeStateRunner(`, fed by the run-ask parameter.
    const call = body.slice(body.indexOf("createBeforeStateRunner("));
    const arg = call.slice(0, call.indexOf("\n      }),"));
    expect(arg).toMatch(/guardContext:\s*\(\)\s*=>\s*\(\{\s*kb:\s*p\.getTribalKbConfig\(\)\s*\}\)/);
    // A required parameter: a construction site that forgets it fails typecheck.
    expect(src).toMatch(/\n {2}getTribalKbConfig: \(\) => TribalKbConfig \| undefined;\n/);
  });

  test("B3 (R11): gateway-main passes the platform KB accessor to BOTH runAsk construction sites", async () => {
    const src = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    const wiring = /getTribalKbConfig:\s*\(\)\s*=>\s*platform\.tribalKbConfig\(\)/;
    const invokeAt = src.indexOf("platform.ipc.setAgentInvokeHandler((ctx) =>");
    const chatopsAt = src.indexOf("platform.chatops?.bindAskEngine(");
    expect(invokeAt).toBeGreaterThan(-1);
    expect(chatopsAt).toBeGreaterThan(invokeAt);
    const invoke = src.slice(invokeAt, chatopsAt);
    expect(invoke).toContain("runAsk({");
    expect(invoke).toMatch(wiring);
    const chatopsEnd = src.indexOf("\n  );\n", chatopsAt);
    const chatops = src.slice(chatopsAt, chatopsEnd);
    expect(chatops).toContain("createChatOpsAskEngine((query) => ({");
    expect(chatops).toMatch(wiring);
    // Fail closed on a missing accessor: no optional call anywhere, and the field is required.
    expect(src).not.toMatch(/platform\.tribalKbConfig\?\./);
    const types = stripComments(await read("packages/gateway/src/platform/types.ts"));
    expect(types).toMatch(/\n {2}tribalKbConfig: \(\) => TribalKbConfig \| undefined;/);
  });

  test("the executor is set only on an owner cli/ui, non-demo turn, and cleared otherwise", async () => {
    const src = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    const at = src.indexOf("function offerConnectorWriteExecutorIfOwner(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toContain("p.offerConnectorWriteTools === true && !isDemo(p)");
    expect(body).toContain("store.connectorWriteExecutor = buildModelWriteExecutor(p)");
    expect(body).toContain("delete store.connectorWriteExecutor");
  });

  test("the owner-turn map offers the door to cli and ui only; an undeclared client gets none", async () => {
    const { CONNECTOR_WRITE_OFFER_BY_KIND } = await import("../ipc/server/inline-handlers.ts");
    expect({ ...CONNECTOR_WRITE_OFFER_BY_KIND }).toEqual({
      cli: true,
      ui: true,
      unknown: false,
      mcp: false,
      http: false,
      chatops: false,
      fleet: false,
      push: false,
    });
  });

  // The CALL, not the import: a leftover import must not satisfy the pin.
  const ASK_CALLS_DECLARE = /\bawait\s+declareCliClientKind\s*\(\s*client\s*\)/;
  const REPL_WIRES_DECLARE = /\bdeclareKind\s*:\s*declareCliClientKind\b/;
  const REPL_CORE_CALLS_DECLARE = /\bawait\s+deps\.declareKind\s*\(\s*client\s*\)/;

  test("the CLI's ask calls the declaration, repl wires it into its core, which calls it", async () => {
    const ask = stripComments(await read("packages/cli/src/commands/ask.ts"));
    const repl = stripComments(await read("packages/cli/src/commands/repl.ts"));
    const core = stripComments(await read("packages/cli/src/commands/repl-core.ts"));
    expect(ASK_CALLS_DECLARE.test(ask)).toBe(true);
    expect(REPL_WIRES_DECLARE.test(repl)).toBe(true);
    expect(REPL_CORE_CALLS_DECLARE.test(core)).toBe(true);
    expect(await read("packages/cli/src/lib/declare-client-kind.ts")).toContain('kind: "cli"');
  });

  test("red-proof: an import with the call deleted, or an unwired repl, fails the pins", () => {
    const importOnly = 'import { declareCliClientKind } from "../lib/declare-client-kind.ts";\n';
    expect(ASK_CALLS_DECLARE.test(importOnly)).toBe(false);
    expect(
      ASK_CALLS_DECLARE.test(stripComments(`${importOnly}// await declareCliClientKind(client);`)),
    ).toBe(false);
    expect(REPL_WIRES_DECLARE.test(importOnly)).toBe(false);
    expect(REPL_WIRES_DECLARE.test(`${importOnly}export const d = { declareKind: noop };`)).toBe(
      false,
    );
  });
  async function door(opts: { recheck: boolean | "throws"; executor: boolean }) {
    const { buildConnectorWriteAgentTools } = await import(
      "../engine/connector-write-agent-tools.ts"
    );
    const { row, textField, withPreview } = await import("../connectors/connector-writes/types.ts");
    const { toStandardSchema } = await import("@mastra/core/schema");
    const ROW = withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 2), {
      target: "{name}",
      summary: "Sync application {name}",
      fields: [textField("revision", "Revision", "HEAD")],
    });
    const actions: PlannedAction[] = [];
    const epoch = 7000 + Math.floor(Math.random() * 1e6);
    const source = {
      offerableEnabledRows: () => [ROW],
      listServerTools: async () => ({
        argocd_argocd_app_sync: {
          description: "sync",
          inputSchema: toStandardSchema({
            type: "object",
            properties: { name: { type: "string" }, revision: { type: "string" } },
          } as Parameters<typeof toStandardSchema>[0]),
        },
      }),
      toolsEpoch: () => epoch,
      recheck: () => {
        if (opts.recheck === "throws") throw new Error("policy unreadable");
        return opts.recheck;
      },
      warn: () => undefined,
    };
    const executor = opts.executor
      ? {
          execute: async (a: PlannedAction) => {
            actions.push(a);
            return { status: "ok" as const, result: { synced: true } };
          },
        }
      : undefined;
    const tools = await buildConnectorWriteAgentTools(
      source,
      () => executor,
      (_s, _t, def) => def,
      new Set(),
    );
    const tool = tools["argocd__argocd_app_sync"] as {
      execute: (input: unknown) => Promise<unknown>;
    };
    return { tool, actions };
  }

  test("every door action carries origin: model, the second layer against delegation", async () => {
    const { tool, actions } = await door({ recheck: true, executor: true });
    await tool.execute({ name: "web", revision: "abc" });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.origin).toBe("model");
    expect(actions[0]?.type).toBe("argocd.app.sync");
  });

  test("no executor on the turn: a stale tool call is refused and nothing is dispatched", async () => {
    const { tool, actions } = await door({ recheck: true, executor: false });
    expect(await tool.execute({ name: "web" })).toEqual({
      refused: "connector writes are only callable by the local owner",
    });
    expect(actions).toHaveLength(0);
  });

  test("the per-call recheck refuses when enablement or policy lapsed, or cannot be read", async () => {
    for (const recheck of [false, "throws"] as const) {
      const { tool, actions } = await door({ recheck, executor: true });
      expect(await tool.execute({ name: "web" })).toEqual({
        refused: "this connector write is no longer enabled; ask again",
      });
      expect(actions).toHaveLength(0);
    }
  });

  test("the production source stays gated: enablement, policy, offerability and the approved set", async () => {
    const src = stripComments(
      await read("packages/gateway/src/connectors/connector-writes/model-write-source.ts"),
    );
    expect(src).toContain("isModelOfferableRow");
    expect(src).toContain("isConnectorWriteModelAccessEnabled");
    expect(src).toContain("getModelWriteEnablement");
    // F3/F4: the destination refusals read the live policy's ChatOps bindings and the KB config.
    expect(src).toContain("modelWriteRefusal(row.toolId, input,");
    const door = stripComments(
      await read("packages/gateway/src/engine/connector-write-agent-tools.ts"),
    );
    const refusalAt = door.indexOf("destinationRefusal(source, row, input)");
    expect(refusalAt).toBeGreaterThan(door.indexOf("if (!isPlainObject(input))"));
    expect(refusalAt).toBeLessThan(door.indexOf("ex.execute("));
    // V84 re-consent: the listing and the per-call recheck share ONE predicate that reads it.
    expect(src).toContain("approvedToolIds.has(row.toolId)");
    expect(src.match(/offeredUnder\(/g)?.length).toBe(3);
    // The production wiring feeds the KB refusal the real [tribal] config (triple rule): the
    // gateway's source passes the platform's live accessor, and assemble fills it.
    const main = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    expect(main).toMatch(/getTribalKbConfig:\s*\(\)\s*=>\s*platform\.tribalKbConfig\(\)/);
    const assemble = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    expect(assemble).toMatch(/tribalKbConfig\s*[:(]/);
  });

  test("D39 exists with all four clauses, run() calls it, and the door is an anchor", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    for (const id of [
      "connector-write-tools-built-outside-door",
      "connector-write-executor-read-confined",
      "connector-write-context-field-confined",
      "connector-write-builders-confined",
      "connector-write-door-names-transport",
      "connector-write-door-origin-model",
    ]) {
      expect(audit).toContain(id);
    }
    const runAt = audit.indexOf("async function run(");
    expect(runAt).toBeGreaterThan(-1);
    expect(audit.slice(runAt)).toContain("checkModelWriteDoor(files)");
    expect(audit).toContain(`"${DOOR_PATH}"`);
  });

  test("the checker rejects a second builder of write tools (red-proof, not just presence)", () => {
    const v = checkModelWriteDoor([
      {
        relPath: "packages/gateway/src/engine/rogue.ts",
        contents:
          'import { createTool as ct } from "@mastra/core/tools";\nimport { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";\nct({});',
      },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["connector-write-tools-built-outside-door"]);
  });

  test("the production tree has no violation of D39", async () => {
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(files.some((f) => f.relPath === DOOR_PATH)).toBe(true);
    expect(checkModelWriteDoor(files)).toEqual([]);
  });
  // ---- spec § 5.4: the door's before-state read ----------------------------------------------

  test("no before-state read type is in the frozen HITL set (a read never raises a prompt)", async () => {
    const { HITL_REQUIRED } = await import("../engine/executor.ts");
    for (const t of HITL_REQUIRED) expect(t.endsWith(".before.read")).toBe(false);
    // Every service a write row names: its read type is outside the set.
    for (const r of CONNECTOR_WRITE_ROWS) {
      expect(HITL_REQUIRED.has(`${r.actionType.split(".")[0] ?? ""}.before.read`)).toBe(false);
    }
  });

  test("the beforeStateRows test seam is named by no non-test gateway file but run-ask.ts and the act door's builder call", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const naming = files
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => /\bbeforeStateRows\b/.test(stripComments(f.contents)))
      .map((f) => f.rel.split("\\").join("/"));
    // Phase 28 AD1: `ipc/capture-rpc.ts` passes the act door's wiring field through to
    // `buildAgentWriteExecutor`. PRODUCTION never sets it: the wiring site, `platform/assemble.ts`,
    // does not name it, so the rows are always the write table.
    expect([...naming].sort()).toEqual(["engine/run-ask.ts", "ipc/capture-rpc.ts"]);
    expect(naming).not.toContain("platform/assemble.ts");
  });

  test("the door executor alone carries the before-state runner, as argument 8", async () => {
    const runAsk = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    const askAt = runAsk.indexOf("function buildAskExecutor(");
    const askBody = runAsk.slice(askAt, runAsk.indexOf("\n}\n", askAt));
    expect(askBody).toContain("newTurnExecutor(p, p.delegation)");
    expect(askBody).not.toContain("createBeforeStateRunner");
    const exec = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    expect(exec).toMatch(
      /private readonly previewCredentialFor\?: PreviewCredentialResolver,\s*extras: ToolExecutorExtras = \{\},\s*private readonly writeTable\?: WriteTable,\s*\)/,
    );
  });

  test("D40 exists with its three clauses, run() calls it, and its files are anchors", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    for (const id of [
      "before-read-literal-confined",
      "before-state-runner-confined",
      "before-read-guard-present",
    ]) {
      expect(audit).toContain(id);
    }
    const runAt = audit.indexOf("async function run(");
    expect(audit.slice(runAt)).toContain("checkBeforeStateRead(files)");
    for (const anchor of [
      "packages/gateway/src/engine/before-state.ts",
      "packages/gateway/src/connectors/registry.ts",
    ]) {
      expect(RULE_ANCHORS).toContain(anchor);
    }
  });

  test("the production tree has no violation of D40, and D40 rejects a rogue read type", async () => {
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(checkBeforeStateRead(files)).toEqual([]);
    const rogue = [
      ...files,
      {
        relPath: "packages/gateway/src/engine/rogue.ts",
        contents: 'const t = "jira.before.read";',
      },
    ];
    expect(checkBeforeStateRead(rogue).map((v) => v.rule)).toEqual([
      "before-read-literal-confined",
    ]);
  });

  test("B2a: a before-state guard refusal is produced only in before-state.ts and consumed only by executor.ts", async () => {
    const files = (await readDirFiles("packages/gateway/src")).filter(
      (f) => !f.rel.endsWith(".test.ts"),
    );
    const naming = (re: RegExp): string[] =>
      files
        .filter((f) => re.test(stripComments(f.contents)))
        .map((f) => f.rel.split("\\").join("/"))
        .sort((a, b) => a.localeCompare(b));
    // The refusal value's type and the error are named by these two files only.
    expect(naming(/\bBeforeStateRefusal\b/)).toEqual(["engine/before-state.ts"]);
    expect(naming(/\bBeforeStateRefusedError\b/)).toEqual([
      "engine/before-state.ts",
      "engine/executor.ts",
    ]);
    const runner = stripComments(await read("packages/gateway/src/engine/before-state.ts"));
    // The ONE construction of the refusal (`refusalOf`), from the reader's own guard reason, or
    // (D1) the fixed Wave 4 text when no guard applies to a Wave 4 row.
    expect(runner.match(/status: "refused"/g)).toHaveLength(2); // the type's field, and the value
    expect(runner.match(/refusalOf[(]/g)).toHaveLength(3); // the definition and its two uses
    expect(runner).toContain("const guardReason = guarded ? reader.guard?.reason : undefined;");
    expect(runner).toContain("const refusal = refusalOf(guardReason ?? WAVE4_BEFORE_REFUSAL);");
    const exec = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    const previewAt = exec.indexOf("private async captureBeforePhase(");
    const previewBody = exec.slice(previewAt, exec.indexOf("\n  }\n", previewAt));
    expect(previewBody).toContain(
      'if (before.status === "refused") throw new BeforeStateRefusedError(before.reason);',
    );
    expect(exec.match(/new BeforeStateRefusedError\(/g)).toHaveLength(1);
    // D1: a Wave 4 model write whose preview is absent is refused by the runner module's own
    // helper (the error is constructed there), before any read or prompt.
    expect(previewBody).toContain("throwIfWave4WithoutPreview(action, this.rows());");
    expect(runner).toContain("export function throwIfWave4WithoutPreview(");
    const gateAt = exec.indexOf("private statusOfGateThrow(");
    const gateBody = exec.slice(gateAt, exec.indexOf("\n  }\n", gateAt));
    expect(exec.match(/instanceof BeforeStateRefusedError/g)).toHaveLength(1);
    expect(gateBody).toMatch(
      /else if \(e instanceof BeforeStateRefusedError \|\| e instanceof PrepareRefusedError\) \{\s*return refuseGate\(record, e\.reason\);/,
    );
    // The one helper sets BOTH the caller's reason and the audit reason from the same fixed text.
    expect(exec).toMatch(
      /function refuseGate\(record: GateRecord, reason: string\): "rejected" \{\s*record\.rejectReason = reason;\s*record\.hitlRejectReason = reason;\s*return "rejected";/,
    );
  });

  test("B2a: a guard refusal reaches no consent prompt and dispatches no write (behaviour)", async () => {
    const { ToolExecutor, NO_POLICY_OVERLAY } = await import("../engine/executor.ts");
    const { createBeforeStateRunner } = await import("../engine/before-state.ts");
    const { row, withBefore, withPreview } = await import(
      "../connectors/connector-writes/types.ts"
    );
    const reason = "the model cannot do this; ask the owner";
    const guardedRow = withBefore(
      withPreview(row("jira_issue_update", "jira.issue.update", "mesh", 2), {
        target: "{issueKey}",
        summary: "Update {issueKey}",
        fields: [],
      }),
      {
        tool: "jira_issue_get",
        argKeys: ["issueKey"],
        args: (input) => ({ issueKey: input["issueKey"] }),
        select: () => [],
        guard: { reason, appliesTo: () => true, allows: () => false },
      },
    );
    let prompts = 0;
    const dispatched: string[] = [];
    const egress: string[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          prompts += 1;
          return { approved: true, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      {
        dispatch: async (a) => {
          dispatched.push(a.type);
          return {};
        },
      },
      undefined,
      { append: (e) => void egress.push(`${e.method}:${e.resultStatus}`) },
      NO_POLICY_OVERLAY,
      undefined,
      { beforeState: createBeforeStateRunner({ rows: [guardedRow] }) },
    );
    const out = await exec.execute({
      type: "jira.issue.update",
      origin: "model",
      payload: { mcpToolId: "jira_jira_issue_update", input: { issueKey: "NIM-1" } },
    });
    expect(out).toEqual({ status: "rejected", reason });
    expect(prompts).toBe(0);
    expect(dispatched).toEqual(["jira.before.read"]);
    expect(egress).toEqual(["jira.before.read:authorized", "jira.issue.update:blocked"]);
  });
});

describe("I53 / I28 — B3r: remote content in drafts, pages, notes and markup files is refused on both doors", () => {
  const REFUSALS = "packages/gateway/src/connectors/connector-writes/model-write-refusals.ts";

  /** The comment-free body of `name` (a top-level function) in `src`. */
  function bodyOf(src: string, name: string): string {
    const at = src.indexOf(`export function ${name}(`);
    expect(at, name).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n}\n", at));
  }

  test("I53: messagingDestinationRefusal calls remoteContentRefusal after the scoped label, before the null field", async () => {
    const body = bodyOf(stripComments(await read(REFUSALS)), "messagingDestinationRefusal");
    const scoped = body.indexOf("refusesGitlabScopedLabel(");
    const remote = body.indexOf("remoteContentRefusal(toolId, input)");
    const nullField = body.indexOf("nullOptionalFieldCheck(");
    expect(scoped).toBeGreaterThan(-1);
    expect(remote).toBeGreaterThan(scoped);
    expect(nullField).toBeGreaterThan(remote);
  });

  test("I28: modelWriteRefusal calls messagingDestinationRefusal first, so the agent door (which runs it since AD3b) gets the rule", async () => {
    const model = bodyOf(stripComments(await read(REFUSALS)), "modelWriteRefusal");
    const first = model.indexOf(
      "= messagingDestinationRefusal(toolId, input, { chatops: ctx.chatops });",
    );
    expect(first).toBeGreaterThan(0);
    expect(model.slice(0, first)).not.toContain("return");
  });

  test("the rule calls the detector with exactly two arguments (the tripwire seam is unreachable)", async () => {
    const src = stripComments(await read(REFUSALS));
    const calls = src.split("remoteContentIn(").length - 1;
    expect(calls).toBe(1);
    expect(src).toMatch(/remoteContentIn\(format, text\)/);
  });

  test("behaviour: an Outlook HTML pixel, and a Confluence ri:url image, through the door check", () => {
    expect(
      modelWriteRefusal(
        "outlook_draft_create",
        { to: "a@x.com", subject: "S", body: "<img src=https://h/p.gif>", contentType: "html" },
        { chatops: undefined, kb: undefined },
      ),
    ).toBe(REMOTE_CONTENT_REFUSAL);
    expect(
      modelWriteRefusal(
        "confluence_page_append",
        { pageId: "1", storageHtml: '<ac:image><ri:url ri:value="https://h/x.png"/></ac:image>' },
        { chatops: undefined, kb: undefined },
      ),
    ).toBe(REMOTE_CONTENT_REFUSAL);
  });
});

describe("I53 / I28 - B3w: sent mail, Teams and forge Markdown cannot load remote content", () => {
  test("the eleven B3w rows are scanned", () => {
    const rows = new Set(remoteContentScannedRows());
    for (const id of [
      "outlook_mail_send",
      "teams_message_post",
      "teams_message_post_chat",
      "github_issue_comment_create",
      "github_issue_create",
      "gitlab_issue_note_create",
      "gitlab_mr_note_create",
      "gitlab_issue_create",
      "linear_comment_create",
      "linear_issue_create",
      "linear_issue_update",
    ]) {
      expect(rows.has(id), id).toBe(true);
    }
  });

  test("behaviour: an HTML Outlook send (an owner-door row), a GitHub comment image (the agent and model doors)", () => {
    expect(
      modelWriteRefusal(
        "outlook_mail_send",
        { to: "a@x.com", subject: "S", body: "<img src=https://h/p.gif>", contentType: "html" },
        { chatops: undefined, kb: undefined },
      ),
    ).toBe(REMOTE_CONTENT_REFUSAL);
    expect(
      modelWriteRefusal(
        "github_issue_comment_create",
        { owner: "o", repo: "r", issueNumber: 1, body: "![](https://h/p.gif)" },
        { chatops: undefined, kb: undefined },
      ),
    ).toBe(REMOTE_CONTENT_REFUSAL);
  });
});

describe("I53 / I54 - D1c: a commit the model proposes is refused for a CI, hook or credential path and never carries the bound head", () => {
  const SRC = join(SRC_ROOT, "connectors", "connector-writes");
  const COMMIT_FILES = [{ path: ".github/workflows/ci.yml", content: "on: push\n" }];

  test("modelWriteRefusal calls commitModelRefusal after the messaging check, and the agent door runs it (AD3b)", async () => {
    const src = stripComments(await readFile(join(SRC, "model-write-refusals.ts"), "utf8"));
    const model = src.slice(src.indexOf("export function modelWriteRefusal("));
    expect(model).toMatch(
      /messagingDestinationRefusal\([\s\S]*commitModelRefusal\(toolId, input\)[\s\S]*knowledgeBaseRefusal\(/,
    );
    expect(src).not.toContain("actDoorRefusal");
  });

  test("behaviour: a workflow path, a CODEOWNERS file and a credential are refused (the model door and, since AD3b, the agent door)", () => {
    const model = (files: unknown) =>
      modelWriteRefusal(
        "github_file_commit",
        { owner: "o", repo: "r", branch: "b", message: "m", files },
        { chatops: undefined, kb: undefined },
      );
    expect(model(COMMIT_FILES)).toBe(COMMIT_PATH_REFUSAL);
    expect(model([{ path: "docs/CODEOWNERS", content: "x" }])).toBe(COMMIT_PATH_REFUSAL);
    const token = `gh${"p_"}${"a".repeat(36)}`;
    expect(model([{ path: "a.ts", content: token }])).toBe(COMMIT_CREDENTIAL_REFUSAL);
    expect(model([{ path: "a.ts", content: "ok" }])).toBeUndefined();
  });

  test("the offered schema drops the bound head: the door strips every bound field from the listing", async () => {
    const src = stripComments(
      await readFile(join(SRC_ROOT, "engine", "connector-write-agent-tools.ts"), "utf8"),
    );
    expect(src).toMatch(
      /offeredInputSchema\(\s*entry\["inputSchema"\],[\s\S]{0,120}binds\.map\(\(b\) => b\.field\)/,
    );
  });

  test("no bound row is proposable with an empty door table: an agent reaches one only on I58's approved basis (the owner approved it by name; the executor's prompt shows its diff or plan)", async () => {
    const { Database } = await import("bun:sqlite");
    const { runIndexedSchemaMigrations } = await import("../index/migrations/runner.ts");
    const { createAgentDoor } = await import(
      "../connectors/connector-writes/agent-door-runtime.ts"
    );
    const bare = new Database(":memory:");
    runIndexedSchemaMigrations(bare, 97);
    const door = createAgentDoor({
      db: bare,
      enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>() }) as never,
      listServerTools: async () => undefined,
      tribalKbConfig: () => undefined,
      userMcpPolicy: { userMcpModelAccessAllowed: () => false },
      isServiceConfigured: async () => true,
      now: () => 1,
    });
    for (const r of CONNECTOR_WRITE_ROWS.filter((row) => row.bound !== undefined)) {
      expect(door.verdict(r.actionType).kind, r.actionType).toBe("denied");
    }
    bare.close();
  });
});
