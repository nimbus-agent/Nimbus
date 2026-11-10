// Phase 9.7 D2 through the real model door: the Terraform apply and the CloudFormation deploy are
// offered only at `--wave 4` with each write approved by name (and the Terraform one only while the
// owner approved a working directory), shown to the model WITHOUT the plan file, the plan hash or
// the change set id, refused (CloudFormation IAM capabilities) before any read, and run as
// `origin: "model"` actions through the typed prompt. The destroy, the Pulumi apply and the
// change-set discard are never offered. Rows, listing check, prepare step and executor are the
// production ones; the connector side is a fake slot and a fake dispatcher and capability.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { makeEgressSink } from "../../egress/egress-ledger.ts";
import { createBeforeStateRunner } from "../../engine/before-state.ts";
import {
  buildConnectorWriteAgentTools,
  CONNECTOR_WRITE_TOOL_NAME_MAX,
  DECLINED_RESULT_TEXT,
} from "../../engine/connector-write-agent-tools.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../engine/executor.ts";
import { isPrepareActionType, PREPARE_REFUSALS } from "../../engine/prepare-step.ts";
import type {
  AuditSink,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "../../engine/types.ts";
import { readListedJsonSchema } from "../../engine/user-mcp-agent-tools.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { setModelWriteEnablement } from "./enablement-store.ts";
import { IAC_INPUT_REFUSALS, IAC_MODEL_REFUSALS, IAC_PREFLIGHT_REFUSALS } from "./iac-limits.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";

const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;
const WD = "/srv/infra/prod";
const WD2 = "/srv/infra/staging";
const ARN =
  "arn:aws:cloudformation:eu-west-1:123456789012:changeSet/nimbus-x/00000000-0000-0000-0000-000000000000";
const PLAN = {
  lines: [
    "Deletes: 0, Replaces: 0, Creates: 1, Updates: 0",
    "End of plan: 1 changes (0 deletes, 0 replaces)",
  ],
  text: "x",
  bytes: 1,
  sha256: "b".repeat(64),
  changeCount: 1,
  deleteCount: 0,
} as const;
const TEMPLATE = "Resources:\n  B:\n    Type: AWS::S3::Bucket\n";

const schema = (keys: readonly string[], required: readonly string[] = []) =>
  toStandardSchema({
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, {}])),
    required: [...required],
  } as Parameters<typeof toStandardSchema>[0]);

/** What the iac server lists: every tool of the connector's own schema, bound keys REQUIRED. */
function listing(opts: { readonly omit?: readonly string[] } = {}): Record<string, unknown> {
  const tools: Record<string, [readonly string[], readonly string[]]> = {
    iac_terraform_apply: [
      ["workingDirectory", "planFile", "planSha256"],
      ["workingDirectory", "planFile", "planSha256"],
    ],
    iac_terraform_destroy: [
      ["workingDirectory", "planFile", "planSha256"],
      ["workingDirectory", "planFile", "planSha256"],
    ],
    iac_cloudformation_deploy: [
      ["stackName", "templateBody", "capabilities", "changeSetId"],
      ["stackName", "templateBody", "changeSetId"],
    ],
    iac_pulumi_up: [["workingDirectory"], ["workingDirectory"]],
    iac_cloudformation_changeset_discard: [
      ["stackName", "changeSetId"],
      ["stackName", "changeSetId"],
    ],
    iac_terraform_plan: [["workingDirectory"], ["workingDirectory"]],
    iac_terraform_destroy_plan: [["workingDirectory"], ["workingDirectory"]],
    iac_terraform_show_json: [
      ["workingDirectory", "planFile"],
      ["workingDirectory", "planFile"],
    ],
    iac_cloudformation_changeset_create: [
      ["stackName", "templateBody", "capabilities"],
      ["stackName", "templateBody"],
    ],
  };
  const out: Record<string, unknown> = {};
  for (const [id, [keys, required]] of Object.entries(tools)) {
    if (opts.omit?.includes(id) === true) continue;
    out[mcpClientToolKey("iac", id)] = {
      description: `the connector's ${id}`,
      inputSchema: schema(keys, required),
    };
  }
  return out;
}

describe("D2 through the real model door", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 84);
  });
  afterEach(() => db.close());

  async function door(
    opts: {
      readonly workdirs?: readonly string[];
      readonly omit?: readonly string[];
      readonly preflightReason?: string;
      readonly settleThrowsReason?: string;
      readonly answer?: (req: ConfirmedApprovalRequest) => ConfirmedApprovalResult;
    } = {},
  ) {
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => ALLOWED,
      listServerTools: async (service) =>
        service === "iac" ? listing(opts.omit === undefined ? {} : { omit: opts.omit }) : undefined,
      toolsEpoch: () => 0,
      warn: () => {},
      approvedWorkdirs: () => opts.workdirs ?? [WD, WD2],
    });
    const confirmed: ConfirmedApprovalRequest[] = [];
    const dispatched: PlannedAction[] = [];
    const consent: ConsentChannel = {
      requestApproval: async () => true,
      requestConfirmedApproval: async (req) => {
        confirmed.push(req);
        return opts.answer?.(req) ?? { approved: true, typed: req.confirmText };
      },
    };
    const dispatcher: ConnectorDispatcher = {
      dispatch: async (a: PlannedAction) => {
        dispatched.push(a);
        if (isPrepareActionType(a.type)) return { planId: "p".repeat(32) };
        return { ok: true, queued: a.type };
      },
      boundWriteCapabilities: {
        preflight: async () =>
          opts.preflightReason === undefined
            ? { ok: true, release: () => {} }
            : { ok: false, reason: opts.preflightReason },
        settle: async (_id, ctx) => {
          if (opts.settleThrowsReason !== undefined) {
            const { PrepareRefusedError } = await import("../../engine/prepare-step.ts");
            throw new PrepareRefusedError(opts.settleThrowsReason);
          }
          return ctx.settle === "iac-terraform"
            ? {
                values: { planFile: "/runs/approved/r/p/plan.tfplan", planSha256: "a".repeat(64) },
                fields: [{ label: "Plan SHA-256", value: "a".repeat(64) }],
                plan: PLAN,
                cleanup: async () => {},
              }
            : {
                values: { changeSetId: ARN },
                fields: [{ label: "Stack", value: "prod-stack" }],
                plan: PLAN,
                cleanup: async () => {},
              };
        },
      },
    };
    const exec = new ToolExecutor(
      consent,
      { recordAudit: () => {} } as AuditSink,
      dispatcher,
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      undefined,
      createBeforeStateRunner(),
    );
    const tools = await buildConnectorWriteAgentTools(
      src,
      () => exec,
      (_s, _t, d) => d,
      new Set(),
    );
    return {
      confirmed,
      dispatched,
      tools,
      offered: Object.keys(tools).sort((x, y) => x.localeCompare(y)),
      call: async (name: string, input: Record<string, unknown>) => {
        const t = tools[name] as
          | { execute?: (i: unknown, ctx: unknown) => Promise<unknown> }
          | undefined;
        if (t?.execute === undefined) throw new Error(`${name} is not offered`);
        return await t.execute(input, {});
      },
    };
  }
  const APPLY = "iac__iac_terraform_apply";
  const DEPLOY = "iac__iac_cloudformation_deploy";
  const enableBoth = (): void => {
    setModelWriteEnablement(db, "iac", 4, 1, ["iac_terraform_apply", "iac_cloudformation_deploy"]);
  };
  const writes = (d: { dispatched: PlannedAction[] }) =>
    d.dispatched.filter((a) => !isPrepareActionType(a.type));

  test("exactly the apply and the deploy are offered at wave 4, each under a name that fits", async () => {
    enableBoth();
    const d = await door();
    expect(d.offered).toEqual([DEPLOY, APPLY].sort((a, b) => a.localeCompare(b)));
    for (const n of d.offered) expect(n.length).toBeLessThanOrEqual(CONNECTOR_WRITE_TOOL_NAME_MAX);
  });

  test("the destroy, the Pulumi apply and the discard are never offered, whatever the owner approved by name", async () => {
    setModelWriteEnablement(
      db,
      "iac",
      4,
      1,
      CONNECTOR_WRITE_ROWS.filter((r) => r.actionType.startsWith("iac.")).map((r) => r.toolId),
    );
    const d = await door();
    expect(d.offered).toEqual([DEPLOY, APPLY].sort((a, b) => a.localeCompare(b)));
  });

  test("an earlier opt-in (nothing approved by name) and max_wave 3 offer neither", async () => {
    setModelWriteEnablement(db, "iac", 4, 1, []);
    expect((await door()).offered).toEqual([]);
    setModelWriteEnablement(db, "iac", 3, 1, ["iac_terraform_apply", "iac_cloudformation_deploy"]);
    expect((await door()).offered).toEqual([]);
  });

  test("a prepare tool missing from the listing withholds that row only", async () => {
    enableBoth();
    expect((await door({ omit: ["iac_terraform_plan"] })).offered).toEqual([DEPLOY]);
    expect((await door({ omit: ["iac_cloudformation_changeset_create"] })).offered).toEqual([
      APPLY,
    ]);
    expect((await door({ omit: ["iac_terraform_show_json"] })).offered).toEqual([DEPLOY]);
  });

  test("with no approved working directory the Terraform apply is not offered (the deploy still is)", async () => {
    enableBoth();
    expect((await door({ workdirs: [] })).offered).toEqual([DEPLOY]);
  });

  test("the offered schemas carry none of the bound keys, in properties or required", async () => {
    enableBoth();
    const d = await door();
    for (const [name, bound] of [
      [APPLY, ["planFile", "planSha256"]],
      [DEPLOY, ["changeSetId"]],
    ] as const) {
      const tool = d.tools[name] as { inputSchema: unknown };
      const json = readListedJsonSchema(tool.inputSchema) as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      for (const key of bound) {
        expect(Object.keys(json.properties)).not.toContain(key);
        expect(json.required ?? []).not.toContain(key);
      }
    }
  });

  test("the apply's description is the gateway's own: it lists the approved directories and names no plan file or hash", async () => {
    enableBoth();
    const d = await door();
    const text = (d.tools[APPLY] as { description: string }).description;
    expect(text).toContain(WD);
    expect(text).toContain(WD2);
    expect(text).toMatch(/exactly one of/u);
    expect(text).toContain("never supply");
    expect(text).not.toMatch(/planFile|planSha256|plan file|hash/iu);
    expect(text).not.toContain("the connector's");
    expect(text.length).toBeLessThanOrEqual(1000);
    const deploy = (d.tools[DEPLOY] as { description: string }).description;
    expect(deploy).not.toMatch(/changeSetId|change set id/iu);
    expect(deploy).toMatch(/IAM/u);
  });

  test("a long list of directories is cut to fit the description cap and says how many were left out", async () => {
    enableBoth();
    const many = Array.from({ length: 80 }, (_, i) => `/srv/infra/environment-number-${String(i)}`);
    const text = ((await door({ workdirs: many })).tools[APPLY] as { description: string })
      .description;
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toMatch(/and \d+ more/u);
  });

  test("an apply call reaches the typed prompt as the model's, and writes with the gateway's plan", async () => {
    enableBoth();
    const d = await door();
    const out = await d.call(APPLY, { workingDirectory: WD });
    expect(out).toEqual({ ok: true, queued: "iac.terraform.apply" });
    const req = d.confirmed[0];
    expect(req?.confirmText).toBe(`iac/apply ${WD}`);
    expect(req?.prompt).toContain("Requested by: the model");
    expect(req?.prompt).toContain("End of plan: 1 changes (0 deletes, 0 replaces)");
    const w = writes(d)[0];
    expect(w?.origin).toBe("model");
    expect(((w as PlannedAction).payload as { input: Record<string, unknown> }).input).toEqual({
      workingDirectory: WD,
      planFile: "/runs/approved/r/p/plan.tfplan",
      planSha256: "a".repeat(64),
    });
  });

  test("a call that supplies a plan file, hash or change set id is refused before any read or prompt", async () => {
    enableBoth();
    const d = await door();
    expect(await d.call(APPLY, { workingDirectory: WD, planFile: "/tmp/x.tfplan" })).toEqual({
      refused: PREPARE_REFUSALS.callerBound,
    });
    expect(
      await d.call(DEPLOY, { stackName: "s", templateBody: TEMPLATE, changeSetId: ARN }),
    ).toEqual({ refused: PREPARE_REFUSALS.callerBound });
    expect(d.dispatched).toEqual([]);
    expect(d.confirmed).toEqual([]);
  });

  test("CAPABILITY_IAM and CAPABILITY_NAMED_IAM are refused with a fixed text before ANY read; AUTO_EXPAND and none pass", async () => {
    enableBoth();
    const d = await door();
    for (const capabilities of [
      ["CAPABILITY_IAM"],
      ["CAPABILITY_NAMED_IAM"],
      ["CAPABILITY_AUTO_EXPAND", "CAPABILITY_NAMED_IAM"],
    ]) {
      expect(
        await d.call(DEPLOY, { stackName: "prod-stack", templateBody: TEMPLATE, capabilities }),
      ).toEqual({ refused: IAC_MODEL_REFUSALS.iamCapability });
    }
    expect(d.dispatched).toEqual([]);
    expect(d.confirmed).toEqual([]);
    const ok = await door();
    expect(
      await ok.call(DEPLOY, {
        stackName: "prod-stack",
        templateBody: TEMPLATE,
        capabilities: ["CAPABILITY_AUTO_EXPAND"],
      }),
    ).toEqual({ ok: true, queued: "iac.cloudformation.deploy" });
    expect(ok.confirmed[0]?.confirmText).toBe("iac/deploy prod-stack");
  });

  test("an input, preflight or settle refusal is { refused } with its fixed text, never { declined }", async () => {
    enableBoth();
    expect(await (await door()).call(APPLY, { workingDirectory: "relative/dir" })).toEqual({
      refused: IAC_INPUT_REFUSALS.workdirNotAbsolute,
    });
    const notApproved = await door({
      preflightReason: IAC_PREFLIGHT_REFUSALS.notApprovedDirectory,
    });
    expect(await notApproved.call(APPLY, { workingDirectory: "/srv/other" })).toEqual({
      refused: IAC_PREFLIGHT_REFUSALS.notApprovedDirectory,
    });
    expect(notApproved.dispatched).toEqual([]);
    const nothing = await door({ settleThrowsReason: PREPARE_REFUSALS.nothingToApply });
    expect(await nothing.call(APPLY, { workingDirectory: WD })).toEqual({
      refused: PREPARE_REFUSALS.nothingToApply,
    });
    expect(nothing.confirmed).toEqual([]);
    expect(writes(nothing)).toEqual([]);
  });

  test("every runner preflight refusal (shutdown, no run, region, unreadable record) is { refused }, never { declined } (review)", async () => {
    enableBoth();
    for (const reason of Object.values(IAC_PREFLIGHT_REFUSALS)) {
      const d = await door({ preflightReason: reason });
      expect(await d.call(APPLY, { workingDirectory: WD })).toEqual({ refused: reason });
      expect(d.dispatched).toEqual([]);
    }
  });

  test("a mismatched text or a denial is declined and writes nothing", async () => {
    enableBoth();
    const mismatch = await door({ answer: () => ({ approved: true, typed: "iac/apply /other" }) });
    expect(await mismatch.call(APPLY, { workingDirectory: WD })).toEqual({
      declined: DECLINED_RESULT_TEXT,
    });
    expect(writes(mismatch)).toEqual([]);
  });
});
