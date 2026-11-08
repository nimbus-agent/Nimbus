// packages/gateway/src/engine/executor-iac-rows.test.ts
// Phase 9.7 D2: the REAL bound IaC rows (Terraform apply and destroy, CloudFormation deploy) and
// the Pulumi refusal through the production write table: no `writeTable` seam. The capabilities are
// a fake on the dispatcher (the production settlers are tested in `iac-settle.test.ts`); what is
// proven here is the gate's behaviour on the real rows.
import { describe, expect, test } from "bun:test";
import { IAC_INPUT_REFUSALS } from "../connectors/connector-writes/iac-limits.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import type { BoundWriteCapabilities, SettledWrite } from "./bound-write-capabilities.ts";
import {
  BOUND_VIA_GATE_REASON,
  CONFIRM_UNSUPPORTED_REASON,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "./executor.ts";
import { PREPARE_REFUSALS } from "./prepare-step.ts";
import type {
  ActionResult,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  PlannedAction,
} from "./types.ts";

const WD = "/srv/infra/prod";
const PLAN_FILE = "/runs/approved/r1/p1/plan.tfplan";
const PLAN_HASH = "a".repeat(64);
const ARN =
  "arn:aws:cloudformation:eu-west-1:123456789012:changeSet/nimbus-x/00000000-0000-0000-0000-000000000000";
const PLAN = {
  lines: [
    "Deletes: 1, Replaces: 0, Creates: 0, Updates: 0",
    "  - aws_s3_bucket.old",
    "End of plan: 1 changes (1 deletes, 0 replaces)",
  ],
  text: "x",
  bytes: 1,
  sha256: "b".repeat(64),
  changeCount: 1,
  deleteCount: 1,
} as const;

const TF_APPLY: PlannedAction = {
  type: "iac.terraform.apply",
  payload: { mcpToolId: "iac_iac_terraform_apply", input: { workingDirectory: WD } },
};
const TF_DESTROY: PlannedAction = {
  type: "iac.terraform.destroy",
  payload: { mcpToolId: "iac_iac_terraform_destroy", input: { workingDirectory: WD } },
};
const TEMPLATE_50K = `# ${"x".repeat(50_000)}\nResources:\n  B:\n    Type: AWS::S3::Bucket\n`;
const CFN_DEPLOY: PlannedAction = {
  type: "iac.cloudformation.deploy",
  payload: {
    mcpToolId: "iac_iac_cloudformation_deploy",
    input: {
      stackName: "prod-stack",
      templateBody: TEMPLATE_50K,
      capabilities: ["CAPABILITY_IAM"],
    },
  },
};
const PULUMI: PlannedAction = {
  type: "iac.pulumi.up",
  payload: { mcpToolId: "iac_iac_pulumi_up", input: { workingDirectory: WD } },
};

interface Harness {
  readonly exec: ToolExecutor;
  readonly log: string[];
  readonly prompts: string[];
  readonly confirmed: ConfirmedApprovalRequest[];
  readonly audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }>;
  readonly egress: EgressEntry[];
  readonly dispatched: PlannedAction[];
  readonly settleWorkdirs: Array<string | undefined>;
  readonly preflightInputs: Array<Record<string, unknown>>;
}

interface Options {
  readonly approve?: boolean;
  readonly typed?: string;
  readonly channel?: "typed" | "plain-only";
  readonly caps?: "none";
  /** The real path the preflight capability resolved the working directory to. */
  readonly resolved?: string;
  readonly prepareReply?: (a: PlannedAction) => unknown;
  readonly settleThrows?: boolean;
  readonly cleanup?: () => Promise<void>;
}

function harness(o: Options = {}): Harness {
  const log: string[] = [];
  const prompts: string[] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const audits: Harness["audits"] = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const settleWorkdirs: Array<string | undefined> = [];
  const preflightInputs: Array<Record<string, unknown>> = [];
  const defaultReply = (a: PlannedAction): unknown => {
    const tool = String(a.payload?.["mcpToolId"]);
    if (tool.endsWith("show_json")) return { planJson: "{}", planSha256: PLAN_HASH };
    if (tool.endsWith("changeset_create")) return { changeSetId: "arn:forged" };
    return {
      planId: "p".repeat(32),
      planFile: "/staging/forged.tfplan",
      planSha256: "f".repeat(64),
    };
  };
  const capabilities: BoundWriteCapabilities | undefined =
    o.caps === "none"
      ? undefined
      : {
          preflight: async (_id, input) => {
            preflightInputs.push(structuredClone({ ...input }));
            return {
              ok: true,
              release: () => log.push("release"),
              ...(o.resolved === undefined ? {} : { workingDirectory: o.resolved }),
            };
          },
          settle: async (id, ctx): Promise<SettledWrite> => {
            log.push(`settle:${id}`);
            settleWorkdirs.push(ctx.workingDirectory);
            if (o.settleThrows === true) throw new Error("boom");
            const cleanup = o.cleanup ?? (async () => void log.push("cleanup"));
            if (ctx.settle === "iac-terraform") {
              await ctx.showPlan?.({ workingDirectory: WD, planFile: PLAN_FILE });
              return {
                values: { planFile: PLAN_FILE, planSha256: PLAN_HASH },
                fields: [{ label: "Plan SHA-256", value: PLAN_HASH }],
                plan: PLAN,
                cleanup,
              };
            }
            return {
              values: { changeSetId: ARN },
              fields: [{ label: "Stack", value: "prod-stack" }],
              plan: PLAN,
              cleanup,
            };
          },
        };
  const consent =
    o.channel === "plain-only"
      ? {
          requestApproval: async (p: string) => {
            log.push("prompt");
            prompts.push(p);
            return true;
          },
        }
      : {
          requestApproval: async () => true,
          requestConfirmedApproval: async (
            req: ConfirmedApprovalRequest,
          ): Promise<ConfirmedApprovalResult> => {
            log.push("prompt:confirmed");
            prompts.push(req.prompt);
            confirmed.push(req);
            return { approved: o.approve ?? true, typed: o.typed ?? req.confirmText };
          },
        };
  const exec = new ToolExecutor(
    consent,
    {
      recordAudit: (e) => {
        audits.push({
          actionType: e.actionType,
          hitlStatus: e.hitlStatus,
          actionJson: e.actionJson,
        });
        log.push(`audit:${e.actionType}:${e.hitlStatus}`);
      },
    },
    {
      dispatch: async (a) => {
        dispatched.push(a);
        log.push(`dispatch:${a.type}:${String(a.payload?.["mcpToolId"])}`);
        if (a.type.endsWith(".write.prepare")) return (o.prepareReply ?? defaultReply)(a);
        return { ok: true };
      },
      ...(capabilities === undefined ? {} : { boundWriteCapabilities: capabilities }),
    },
    undefined,
    {
      append: (e) => {
        egress.push(e);
      },
    },
    NO_POLICY_OVERLAY,
  );
  return {
    exec,
    log,
    prompts,
    confirmed,
    audits,
    egress,
    dispatched,
    settleWorkdirs,
    preflightInputs,
  };
}

const writesOf = (h: Harness): PlannedAction[] =>
  h.dispatched.filter((a) => !a.type.endsWith(".write.prepare"));
const inputOf = (a: PlannedAction | undefined): Record<string, unknown> =>
  (a?.payload?.["input"] ?? {}) as Record<string, unknown>;

function rejectedWith(r: ActionResult, reason: string): void {
  expect(r.status).toBe("rejected");
  if (r.status === "rejected") expect(r.reason).toBe(reason);
}

describe("Terraform apply and destroy through the production table (D2, I54)", () => {
  for (const [name, action, planTool, text] of [
    ["apply", TF_APPLY, "iac_iac_terraform_plan", `iac/apply ${WD}`],
    ["destroy", TF_DESTROY, "iac_iac_terraform_destroy_plan", `iac/destroy ${WD}`],
  ] as const) {
    test(`${name}: plan, show, then the write with the GATEWAY's file and hash; typed confirm; ledger order`, async () => {
      const h = harness();
      const r = await h.exec.execute(action);
      expect(r).toEqual({ status: "ok", result: { ok: true } });
      expect(h.dispatched.map((a) => String(a.payload?.["mcpToolId"]))).toEqual([
        planTool,
        "iac_iac_terraform_show_json",
        String(action.payload?.["mcpToolId"]),
      ]);
      expect(h.dispatched.map((a) => a.type)).toEqual([
        "iac.write.prepare",
        "iac.write.prepare",
        action.type,
      ]);
      // The write carries the settled file and hash, never the plan child's.
      expect(inputOf(writesOf(h)[0])).toEqual({
        workingDirectory: WD,
        planFile: PLAN_FILE,
        planSha256: PLAN_HASH,
      });
      expect(JSON.stringify(writesOf(h))).not.toContain("forged");
      // The audit and the ledger saw the prepare, the show and the write in that order.
      expect(h.audits.map((a) => a.actionType)).toEqual([
        "iac.write.prepare",
        "iac.write.prepare",
        action.type,
      ]);
      expect(h.egress.map((e) => e.resultStatus)).toEqual([
        "authorized",
        "authorized",
        "authorized",
      ]);
      // One typed prompt, with the plan in it, naming the canonical directory.
      expect(h.confirmed).toHaveLength(1);
      expect(h.confirmed[0]?.confirmText).toBe(text);
      expect(h.prompts[0]).toContain("aws_s3_bucket.old");
      // Exactly one footer: the renderer's own, never a second one added by the prompt builder.
      expect(h.prompts[0]).toContain("End of plan: 1 changes (1 deletes, 0 replaces)");
      expect(h.prompts[0]?.split("End of plan").length).toBe(2);
      const audit = JSON.parse(h.audits.at(-1)?.actionJson ?? "{}") as Record<string, unknown>;
      expect(audit["diffSha256"]).toBe(PLAN.sha256);
      expect(typeof audit["boundValuesSha256"]).toBe("string");
      expect(h.log).toContain("cleanup");
      expect(h.log.at(-1)).toBe("release");
    });
  }

  test("a caller-supplied planFile or planSha256 is refused before any read, at the root and in input", async () => {
    for (const forged of [
      { workingDirectory: WD, planFile: "/tmp/evil.tfplan" },
      { workingDirectory: WD, planSha256: "c".repeat(64) },
    ]) {
      for (const shape of ["nested", "root"] as const) {
        const h = harness();
        const action: PlannedAction =
          shape === "nested"
            ? {
                type: "iac.terraform.apply",
                payload: { mcpToolId: "iac_iac_terraform_apply", input: forged },
              }
            : { type: "iac.terraform.apply", payload: { ...forged } };
        rejectedWith(await h.exec.execute(action), PREPARE_REFUSALS.callerBound);
        expect(h.dispatched).toEqual([]);
        expect(h.prompts).toEqual([]);
        expect(h.log.some((l) => l.startsWith("settle:"))).toBe(false);
      }
    }
  });

  test("a working directory that is not a plain absolute path is refused before any read", async () => {
    for (const dir of ["relative/dir", "/a/../b", "\\\\server\\share"]) {
      const h = harness();
      const r = await h.exec.execute({
        type: "iac.terraform.apply",
        payload: { mcpToolId: "iac_iac_terraform_apply", input: { workingDirectory: dir } },
      });
      expect(r.status).toBe("rejected");
      expect(h.dispatched).toEqual([]);
    }
    const h = harness();
    rejectedWith(
      await h.exec.execute({
        type: "iac.terraform.apply",
        payload: {
          mcpToolId: "iac_iac_terraform_apply",
          input: { workingDirectory: WD, extra: 1 },
        },
      }),
      IAC_INPUT_REFUSALS.fieldNotTaken,
    );
  });

  test("the public gate() never binds one of these rows", async () => {
    const h = harness();
    rejectedWith((await h.exec.gate(TF_APPLY)) as ActionResult, BOUND_VIA_GATE_REASON);
    expect(h.dispatched).toEqual([]);
  });

  test("a channel with no typed prompt (ChatOps) is refused before the plan runs, for all three rows", async () => {
    for (const action of [TF_APPLY, TF_DESTROY, CFN_DEPLOY]) {
      const h = harness({ channel: "plain-only" });
      rejectedWith(await h.exec.execute(action), CONFIRM_UNSUPPORTED_REASON);
      expect(h.dispatched).toEqual([]);
      expect(h.prompts).toEqual([]);
    }
  });

  test("a dispatcher with no capabilities refuses all three rows before any child", async () => {
    for (const action of [TF_APPLY, TF_DESTROY, CFN_DEPLOY]) {
      const h = harness({ caps: "none" });
      rejectedWith(await h.exec.execute(action), PREPARE_REFUSALS.capabilityMissing);
      expect(h.dispatched).toEqual([]);
    }
  });

  test("a failed settle, an oversize prepare reply and a failed prepare refuse with their fixed reasons and no prompt", async () => {
    const settle = harness({ settleThrows: true });
    rejectedWith(await settle.exec.execute(TF_APPLY), PREPARE_REFUSALS.settleFailed);
    expect(settle.prompts).toEqual([]);
    expect(writesOf(settle)).toEqual([]);

    const big = harness({ prepareReply: () => ({ planFile: "x".repeat(70_000) }) });
    rejectedWith(await big.exec.execute(TF_APPLY), PREPARE_REFUSALS.replyTooLarge);
    expect(big.prompts).toEqual([]);

    const down = harness({
      prepareReply: () => {
        throw new Error("terraform exploded at /srv/secret");
      },
    });
    const r = await down.exec.execute(TF_APPLY);
    rejectedWith(r, PREPARE_REFUSALS.failed);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  test("a decline and a confirm mismatch dispatch no write, and the settled plan is cleaned up", async () => {
    for (const o of [{ approve: false }, { typed: `iac/apply ${WD}x` }] as const) {
      const h = harness(o);
      expect((await h.exec.execute(TF_APPLY)).status).toBe("rejected");
      expect(writesOf(h)).toEqual([]);
      expect(h.log).toContain("cleanup");
      expect(h.log.at(-1)).toBe("release");
    }
  });
});

describe("the gateway-resolved working directory is the one every child and the prompt use (D2 review)", () => {
  const REAL = "/mnt/real/infra/prod";

  test("plan, show, the write, the confirm text and the prompt all carry the resolved path; the caller's string reaches only the preflight", async () => {
    const h = harness({ resolved: REAL });
    const r = await h.exec.execute(structuredClone(TF_APPLY));
    expect(r.status).toBe("ok");
    expect(h.preflightInputs[0]?.["workingDirectory"]).toBe(WD);
    const dirs = h.dispatched.map((a) => inputOf(a)["workingDirectory"]);
    expect(dirs).toEqual([REAL, REAL, REAL]);
    expect(h.settleWorkdirs).toEqual([REAL]);
    expect(h.confirmed[0]?.confirmText).toBe(`iac/apply ${REAL}`);
    expect(h.prompts[0]).toContain(REAL);
    expect(h.prompts[0]).not.toContain(WD);
  });

  test.each([
    ["a non-ASCII character", "/mnt/café/infra"],
    ["a device form", "\\?C:infra"],
    ["a parent segment", "/mnt/real/../infra"],
    ["more than 180 characters", `/${"a".repeat(200)}`],
    ["a relative path", "infra/prod"],
  ])(
    "a resolved path with %s is refused BEFORE the plan child runs (same refusal on the pinned path)",
    async (_n, bad) => {
      const h = harness({ resolved: bad });
      const r = await h.exec.execute(structuredClone(TF_APPLY));
      expect(r.status).not.toBe("ok");
      expect(h.dispatched).toEqual([]);
      expect(h.prompts).toEqual([]);
      expect(h.confirmed).toEqual([]);
      // the lock the preflight took is still freed
      expect(h.log).toContain("release");
      expect(h.log.some((l) => l.startsWith("settle"))).toBe(false);
    },
  );

  test("a flat payload is pinned too", async () => {
    const h = harness({ resolved: REAL });
    const flat: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { mcpToolId: "iac_iac_terraform_apply", workingDirectory: WD },
    };
    expect((await h.exec.execute(flat)).status).toBe("ok");
    expect(
      h.dispatched.map((a) => a.payload?.["workingDirectory"] ?? inputOf(a)["workingDirectory"]),
    ).toEqual([REAL, REAL, REAL]);
  });

  test("a preflight that resolves no directory (CloudFormation) changes nothing", async () => {
    const h = harness();
    expect((await h.exec.execute(structuredClone(CFN_DEPLOY))).status).toBe("ok");
    expect(h.settleWorkdirs).toEqual([undefined]);
    expect(JSON.stringify(h.dispatched)).not.toContain("workingDirectory");
  });

  test("the caller's own object is not touched", async () => {
    const h = harness({ resolved: REAL });
    const mine = structuredClone(TF_APPLY);
    await h.exec.execute(mine);
    expect(inputOf(mine)["workingDirectory"]).toBe(WD);
  });
});

describe("CloudFormation deploy through the production table (D2, I54)", () => {
  test("prepare, then the write with the GATEWAY's change set id; the template is sent as the caller wrote it", async () => {
    const h = harness();
    const r = await h.exec.execute(CFN_DEPLOY);
    expect(r.status).toBe("ok");
    expect(h.dispatched.map((a) => String(a.payload?.["mcpToolId"]))).toEqual([
      "iac_iac_cloudformation_changeset_create",
      "iac_iac_cloudformation_deploy",
    ]);
    expect(inputOf(h.dispatched[0])).toEqual({
      stackName: "prod-stack",
      templateBody: TEMPLATE_50K,
      capabilities: ["CAPABILITY_IAM"],
    });
    expect(inputOf(writesOf(h)[0])).toEqual({
      stackName: "prod-stack",
      templateBody: TEMPLATE_50K,
      capabilities: ["CAPABILITY_IAM"],
      changeSetId: ARN,
    });
    expect(h.confirmed[0]?.confirmText).toBe("iac/deploy prod-stack");
    // The connector's own changeSetId claim never reaches the write.
    expect(JSON.stringify(writesOf(h))).not.toContain("arn:forged");
  });

  test("the audit rows and the egress ledger hold the template's size and hash, never its text", async () => {
    const h = harness();
    await h.exec.execute(CFN_DEPLOY);
    const sha = (await import("node:crypto"))
      .createHash("sha256")
      .update(TEMPLATE_50K)
      .digest("hex");
    expect(h.audits.map((a) => a.actionType)).toEqual([
      "iac.write.prepare",
      "iac.cloudformation.deploy",
    ]);
    for (const a of h.audits) {
      expect(a.actionJson).not.toContain("xxxxxxxxxx");
      expect(a.actionJson).toContain("templateBytes");
    }
    expect(h.audits[0]?.actionJson).toContain(sha);
    for (const e of h.egress) {
      expect(JSON.stringify(e)).not.toContain("xxxxxxxxxx");
    }
    // The prompt itself shows the template in full (the owner approves what is sent).
    expect(h.prompts[0]).toContain("xxxxxxxxxx");
  });

  test("a template over the cap, a duplicate capability and a bad stack name are refused before any child", async () => {
    const bad = [
      { stackName: "s", templateBody: "x".repeat(51_201) },
      {
        stackName: "s",
        templateBody: "Resources: {}",
        capabilities: ["CAPABILITY_IAM", "CAPABILITY_IAM"],
      },
      { stackName: "1bad name", templateBody: "Resources: {}" },
    ];
    for (const input of bad) {
      const h = harness();
      const r = await h.exec.execute({
        type: "iac.cloudformation.deploy",
        payload: { mcpToolId: "iac_iac_cloudformation_deploy", input },
      });
      expect(r.status).toBe("rejected");
      expect(h.dispatched).toEqual([]);
    }
  });

  test("a caller-supplied changeSetId is refused before any read", async () => {
    const h = harness();
    rejectedWith(
      await h.exec.execute({
        type: "iac.cloudformation.deploy",
        payload: {
          mcpToolId: "iac_iac_cloudformation_deploy",
          input: { stackName: "s", templateBody: "Resources: {}", changeSetId: ARN },
        },
      }),
      PREPARE_REFUSALS.callerBound,
    );
    expect(h.dispatched).toEqual([]);
  });
});

describe("the Pulumi apply is refused on every door before any prompt (D2)", () => {
  const REASON = "iac.pulumi.up: refused (saved update plans are experimental, OR-W34-2)";

  test("execute: refused, audited rejected, ledgered blocked, nothing read, shown or dispatched", async () => {
    for (const action of [PULUMI, { ...PULUMI, origin: "model" } as PlannedAction]) {
      const h = harness();
      rejectedWith(await h.exec.execute(action), REASON);
      expect(h.dispatched).toEqual([]);
      expect(h.prompts).toEqual([]);
      expect(h.audits.map((a) => `${a.actionType}:${a.hitlStatus}`)).toEqual([
        "iac.pulumi.up:rejected",
      ]);
      expect(h.egress.map((e) => e.resultStatus)).toEqual(["blocked"]);
    }
  });

  test("the public gate() and a flat payload are refused the same way", async () => {
    const h = harness();
    rejectedWith((await h.exec.gate(PULUMI)) as ActionResult, REASON);
    rejectedWith(
      await h.exec.execute({ type: "iac.pulumi.up", payload: { workingDirectory: WD } }),
      REASON,
    );
    // Found by TYPE: a payload naming another tool does not lift it.
    rejectedWith(
      await h.exec.execute({
        type: "iac.pulumi.up",
        payload: { mcpToolId: "iac_iac_terraform_plan", input: { workingDirectory: WD } },
      }),
      REASON,
    );
    expect(h.dispatched).toEqual([]);
  });

  test("a type that merely resembles it is not refused by the row", async () => {
    const h = harness();
    const r = await h.exec.execute({
      type: "iac.terraform.apply",
      payload: { mcpToolId: "iac_iac_terraform_apply", input: { workingDirectory: WD } },
    });
    expect(r.status).toBe("ok");
  });
});
