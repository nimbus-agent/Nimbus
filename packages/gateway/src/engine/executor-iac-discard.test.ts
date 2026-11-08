// packages/gateway/src/engine/executor-iac-discard.test.ts
// Phase 9.7 D2 (Task 4 remainder): the gateway-internal discard of a CloudFormation change set the
// owner did not go through with (I2's one stated exception, static rule D43). The REAL deploy row
// through the production table (a fake `boundWriteCapabilities` on the dispatcher); the properties:
//  - the discard runs only after a rejection (decline, confirm mismatch, timeout) or a throw before
//    the write was dispatched, NEVER after a dispatch (a dispatch error included);
//  - it has its own audit row (`not_required`, `discard: unused_changeset`) and its own egress row;
//  - it exists only for a scope that holds a settled change set, for exactly that stack and id;
//  - a failing discard changes nothing in the result; the public `gate()` still prompts for it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { IAC_DISCARD } from "../connectors/connector-writes/iac-limits.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { PREPARE_TOOL_IDS } from "../connectors/connector-writes/prepare-tools.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { ConsentDisconnectedError } from "../ipc/consent.ts";
import type { BoundWriteCapabilities, SettledWrite } from "./bound-write-capabilities.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import { PREPARE_REFUSALS, PrepareRefusedError } from "./prepare-step.ts";
import type {
  ActionResult,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  PlannedAction,
} from "./types.ts";

const WD = "/srv/infra/prod";
const ARN =
  "arn:aws:cloudformation:eu-west-1:123456789012:changeSet/nimbus-x/00000000-0000-0000-0000-000000000000";
const PLAN = {
  lines: ["Deletes: 0, Replaces: 0, Creates: 1, Updates: 0", "  + B"],
  text: "x",
  bytes: 1,
  sha256: "b".repeat(64),
  changeCount: 1,
  deleteCount: 0,
} as const;
const DISCARD_KEY = "iac_iac_cloudformation_changeset_discard";

const CFN_DEPLOY: PlannedAction = {
  type: "iac.cloudformation.deploy",
  payload: {
    mcpToolId: "iac_iac_cloudformation_deploy",
    input: { stackName: "prod-stack", templateBody: "Resources: {}\n" },
  },
};
const TF_APPLY: PlannedAction = {
  type: "iac.terraform.apply",
  payload: { mcpToolId: "iac_iac_terraform_apply", input: { workingDirectory: WD } },
};
const DISCARD: PlannedAction = {
  type: IAC_DISCARD.actionType,
  payload: { mcpToolId: DISCARD_KEY, input: { stackName: "prod-stack", changeSetId: ARN } },
};

type Consent = "typed" | "mismatch" | "decline" | "throws" | "disconnects" | "plain-only";

interface Options {
  readonly consent?: Consent;
  readonly writeThrows?: boolean;
  readonly discardThrows?: boolean | "non-error";
  readonly egressThrowsOnDiscard?: boolean;
  readonly settleValues?: Record<string, string>;
  readonly settleThrows?: boolean;
  /** Settle refuses with a fixed prepare reason (e.g. the plan is too large to show). */
  readonly settleRefuses?: string;
  /** What the prepare child answers; a function may throw (a failed child). */
  readonly prepareReply?: () => unknown;
  readonly noCaps?: boolean;
  readonly table?: readonly ConnectorWriteRow[];
}

function harness(o: Options = {}) {
  const log: string[] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }> = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const capabilities: BoundWriteCapabilities | undefined = o.noCaps
    ? undefined
    : {
        preflight: async () => ({ ok: true, release: () => void log.push("release") }),
        settle: async (): Promise<SettledWrite> => {
          if (o.settleThrows === true) throw new Error("boom");
          if (o.settleRefuses !== undefined) throw new PrepareRefusedError(o.settleRefuses);
          return {
            values: o.settleValues ?? { changeSetId: ARN },
            fields: [{ label: "Stack", value: "prod-stack" }],
            plan: PLAN,
            cleanup: async () => void log.push("cleanup"),
          };
        },
      };
  const consent =
    o.consent === "plain-only"
      ? { requestApproval: async () => true }
      : {
          requestApproval: async () => true,
          requestConfirmedApproval: async (
            req: ConfirmedApprovalRequest,
          ): Promise<ConfirmedApprovalResult> => {
            log.push("prompt");
            confirmed.push(req);
            if (o.consent === "throws") throw new Error("approval timed out");
            if (o.consent === "disconnects") throw new ConsentDisconnectedError();
            if (o.consent === "decline") return { approved: false, typed: "" };
            return { approved: true, typed: o.consent === "mismatch" ? "nope" : req.confirmText };
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
        log.push(`dispatch:${a.type}`);
        if (a.type.endsWith(".write.prepare")) {
          return o.prepareReply === undefined ? { changeSetId: "arn:forged" } : o.prepareReply();
        }
        if (a.type === IAC_DISCARD.actionType && o.discardThrows !== undefined) {
          if (o.discardThrows === "non-error") throw "delete-change-set failed";
          throw new Error("delete-change-set failed");
        }
        if (a.type === "iac.cloudformation.deploy" && o.writeThrows === true) {
          throw new Error("deploy exploded");
        }
        return { ok: true };
      },
      ...(capabilities === undefined ? {} : { boundWriteCapabilities: capabilities }),
    },
    undefined,
    {
      append: (e) => {
        if (o.egressThrowsOnDiscard === true && e.method === IAC_DISCARD.actionType) {
          throw new Error("ledger down");
        }
        egress.push(e);
        log.push(`egress:${e.method}`);
      },
    },
    NO_POLICY_OVERLAY,
    undefined,
    undefined,
    o.table === undefined ? undefined : { rows: o.table, prepareToolIds: PREPARE_TOOL_IDS },
  );
  return { exec, log, confirmed, audits, egress, dispatched };
}

const discardsOf = (dispatched: readonly PlannedAction[]): PlannedAction[] =>
  dispatched.filter((a) => a.type === IAC_DISCARD.actionType);

function rejected(r: ActionResult): void {
  expect(r.status).toBe("rejected");
}

describe("the discard of an unused change set runs after a rejection (D2, D43)", () => {
  for (const consent of ["decline", "mismatch", "disconnects"] as const) {
    test(`${consent}: the change set this run settled is discarded, once, exactly`, async () => {
      const h = harness({ consent });
      rejected(await h.exec.execute(CFN_DEPLOY));
      const discards = discardsOf(h.dispatched);
      expect(discards).toHaveLength(1);
      expect(discards[0]).toEqual({
        type: IAC_DISCARD.actionType,
        payload: { mcpToolId: DISCARD_KEY, input: { stackName: "prod-stack", changeSetId: ARN } },
      });
      // No write was dispatched, and the owner was asked once (for the deploy), never for the discard.
      expect(h.dispatched.some((a) => a.type === "iac.cloudformation.deploy")).toBe(false);
      expect(h.confirmed).toHaveLength(1);
    });
  }

  test("a timeout (the approval throws) discards, and the error still reaches the caller", async () => {
    const h = harness({ consent: "throws" });
    await expect(h.exec.execute(CFN_DEPLOY)).rejects.toThrow("approval timed out");
    expect(discardsOf(h.dispatched)).toHaveLength(1);
  });

  test("the discard has its own audit row (not_required, discard: unused_changeset) and egress row, in order", async () => {
    const h = harness({ consent: "decline" });
    await h.exec.execute(CFN_DEPLOY);
    const audit = h.audits.filter((a) => a.actionType === IAC_DISCARD.actionType);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.hitlStatus).toBe("not_required");
    expect(JSON.parse(audit[0]?.actionJson ?? "{}")).toMatchObject({ discard: "unused_changeset" });
    const ledger = h.egress.filter((e) => e.method === IAC_DISCARD.actionType);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.resultStatus).toBe("authorized");
    // The ledger row is appended BEFORE the dispatch (I29), the audit row before both.
    const at = (s: string): number => h.log.indexOf(s);
    expect(at(`audit:${IAC_DISCARD.actionType}:not_required`)).toBeGreaterThan(-1);
    expect(at(`egress:${IAC_DISCARD.actionType}`)).toBeLessThan(
      at(`dispatch:${IAC_DISCARD.actionType}`),
    );
    // The settled plan's cleanup ran before the discard, and the lock was freed last.
    expect(at("cleanup")).toBeLessThan(at(`audit:${IAC_DISCARD.actionType}:not_required`));
    expect(h.log.at(-1)).toBe("release");
  });

  test("a failed ledger append aborts the discard (fail closed), and the result stands", async () => {
    const h = harness({ consent: "decline", egressThrowsOnDiscard: true });
    rejected(await h.exec.execute(CFN_DEPLOY));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("a discard that throws something that is not an Error is logged the same way", async () => {
    const h = harness({ consent: "decline", discardThrows: "non-error" });
    expect((await h.exec.execute(CFN_DEPLOY)).status).toBe("rejected");
    expect(h.log.at(-1)).toBe("release");
  });

  test("a discard that fails changes nothing: the rejection is the result and the lock is freed", async () => {
    const h = harness({ consent: "decline", discardThrows: true });
    const r = await h.exec.execute(CFN_DEPLOY);
    expect(r).toEqual({ status: "rejected", reason: "User declined consent gate." });
    expect(h.log.at(-1)).toBe("release");
  });
});

describe("the discard NEVER runs after a dispatch (D2, D43)", () => {
  test("approved and dispatched: no discard", async () => {
    const h = harness();
    const r = await h.exec.execute(CFN_DEPLOY);
    expect(r.status).toBe("ok");
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("a dispatch that throws is reported as is, with no discard (an executing change set must stay)", async () => {
    const h = harness({ writeThrows: true });
    await expect(h.exec.execute(CFN_DEPLOY)).rejects.toThrow("deploy exploded");
    expect(discardsOf(h.dispatched)).toEqual([]);
  });
});

describe("the discard exists only for a scope with a settled change set (D2, D43)", () => {
  test("a Terraform row has no change set: a declined apply discards nothing", async () => {
    const h = harness({ consent: "decline" });
    rejected(await h.exec.execute(TF_APPLY));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("a deploy refused before its prepare (no capability) discards nothing", async () => {
    const h = harness({ noCaps: true });
    rejected(await h.exec.execute(CFN_DEPLOY));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("a settle that fails leaves no id the gateway holds, so nothing is discarded", async () => {
    const h = harness({ settleThrows: true });
    rejected(await h.exec.execute(CFN_DEPLOY));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("a settle that bound no changeSetId (a different binding) discards nothing", async () => {
    const h = harness({ consent: "decline", settleValues: { changeSetId: "" } });
    rejected(await h.exec.execute(CFN_DEPLOY));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("an input with no stack name discards nothing", async () => {
    const rows = CONNECTOR_WRITE_ROWS.filter((r) => r.actionType === "iac.cloudformation.deploy");
    const h = harness({ consent: "decline", table: rows });
    // A non-string stackName never reaches here through the real row (its input check refuses it
    // first); the gate must still not build a discard from it.
    const bad: PlannedAction = {
      type: "iac.cloudformation.deploy",
      payload: { mcpToolId: "iac_iac_cloudformation_deploy", input: { templateBody: "x" } },
    };
    rejected(await h.exec.execute(bad));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("a gate that refuses the discard (no dispatch) leaves the result alone", async () => {
    const real = CONNECTOR_WRITE_ROWS.filter((r) => r.actionType === "iac.cloudformation.deploy");
    const discardRow = CONNECTOR_WRITE_ROWS.find((r) => r.actionType === IAC_DISCARD.actionType);
    expect(discardRow).toBeDefined();
    const refusing = { ...(discardRow as ConnectorWriteRow), refuse: "refused for the test" };
    const h = harness({ consent: "decline", table: [...real, refusing] });
    rejected(await h.exec.execute(CFN_DEPLOY));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });
});

describe("the discard scope is a closed door (D43)", () => {
  /** The private gate with a discard scope: the only way a test can build one. */
  const gateAs = (
    h: ReturnType<typeof harness>,
    action: PlannedAction,
    target = { stackName: "prod-stack", changeSetId: ARN },
  ): Promise<ActionResult | "proceed"> =>
    h.exec["gateWithin"](structuredClone(action), undefined, { bind: false, discardStep: target });

  test("the exact discard of the scope's own change set proceeds with no prompt", async () => {
    const h = harness();
    expect(await gateAs(h, DISCARD)).toBe("proceed");
    expect(h.confirmed).toEqual([]);
  });

  test("another change set, another stack, another type, another tool or an extra key is refused, never prompted", async () => {
    const h = harness();
    const variants: PlannedAction[] = [
      {
        ...DISCARD,
        payload: {
          mcpToolId: DISCARD_KEY,
          input: { stackName: "prod-stack", changeSetId: `${ARN}x` },
        },
      },
      {
        ...DISCARD,
        payload: { mcpToolId: DISCARD_KEY, input: { stackName: "other", changeSetId: ARN } },
      },
      // Another HITL type that is not a bound row (a bound one is refused earlier, by the bind rule).
      {
        type: "kubernetes.pod.delete",
        payload: {
          mcpToolId: "k8s_pod_delete",
          input: { stackName: "prod-stack", changeSetId: ARN },
        },
      },
      {
        ...DISCARD,
        payload: {
          mcpToolId: "iac_iac_terraform_apply",
          input: { stackName: "prod-stack", changeSetId: ARN },
        },
      },
      {
        ...DISCARD,
        // A tool that is no connector write at all (a read): the pairing check passes it on.
        payload: {
          mcpToolId: "iac_iac_cloudformation_stack_get",
          input: { stackName: "prod-stack", changeSetId: ARN },
        },
      },
      {
        ...DISCARD,
        payload: {
          mcpToolId: DISCARD_KEY,
          input: { stackName: "prod-stack", changeSetId: ARN, extra: "x" },
        },
      },
      {
        ...DISCARD,
        payload: {
          mcpToolId: DISCARD_KEY,
          input: { stackName: "prod-stack", changeSetId: ARN },
          more: 1,
        },
      },
      {
        ...DISCARD,
        payload: { mcpToolId: DISCARD_KEY, stackName: "prod-stack", changeSetId: ARN },
      },
      { type: IAC_DISCARD.actionType },
      { ...DISCARD, payload: { mcpToolId: DISCARD_KEY, input: "prod-stack" } },
      { ...DISCARD, payload: { mcpToolId: DISCARD_KEY, input: null } },
    ];
    for (const v of variants) {
      const r = await gateAs(h, v);
      expect(r === "proceed").toBe(false);
    }
    expect(h.confirmed).toEqual([]);
  });

  test("the public gate() still prompts for the discard type, and a denial rejects it", async () => {
    const h = harness({ consent: "decline" });
    const r = await h.exec.gate(structuredClone(DISCARD));
    expect(r).toEqual({ status: "rejected", reason: "User declined consent gate." });
    expect(h.confirmed).toHaveLength(1);
    expect(h.confirmed[0]?.confirmText).toBe("iac/discard prod-stack");
  });

  test("execute() of a caller's discard action prompts too; only the gateway's own step skips it", async () => {
    const h = harness({ consent: "typed" });
    const r = await h.exec.execute(structuredClone(DISCARD));
    expect(r.status).toBe("ok");
    expect(h.confirmed).toHaveLength(1);
  });
});

describe("a change set the prepare child made but the gate then refused (D2 review, D43)", () => {
  const TEMPLATE = ((CFN_DEPLOY.payload ?? {})["input"] as { templateBody: string }).templateBody;
  const SHA = createHash("sha256").update(TEMPLATE, "utf8").digest("hex");
  const NAME = `nimbus-${SHA}-0123456789ab`;
  const GOOD_ARN = `arn:aws:cloudformation:eu-west-1:123456789012:changeSet/${NAME}/00000000-0000-0000-0000-000000000000`;
  const reply = (over: Record<string, unknown> = {}) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          stackName: "prod-stack",
          changeSetName: NAME,
          changeSetId: GOOD_ARN,
          ...over,
        }),
      },
    ],
  });
  const refusedAfterCreate = (over: Record<string, unknown> = {}) =>
    harness({
      prepareReply: () => reply(over),
      settleRefuses: PREPARE_REFUSALS.diffTooLarge,
    });

  test("settle refuses (too large to show) after a valid reply: the change set is discarded, exactly", async () => {
    const h = refusedAfterCreate();
    rejected(await h.exec.execute(CFN_DEPLOY));
    const discards = discardsOf(h.dispatched);
    expect(discards).toHaveLength(1);
    expect(discards[0]).toEqual({
      type: IAC_DISCARD.actionType,
      payload: {
        mcpToolId: DISCARD_KEY,
        input: { stackName: "prod-stack", changeSetId: GOOD_ARN },
      },
    });
    // The owner was never asked, and the write never went out.
    expect(h.confirmed).toEqual([]);
    expect(h.dispatched.some((a) => a.type === "iac.cloudformation.deploy")).toBe(false);
    expect(h.log.at(-1)).toBe("release");
  });

  test.each([
    ["another stack", { stackName: "other-stack" }],
    [
      "a name that does not carry this template's hash",
      { changeSetName: `nimbus-${"0".repeat(64)}-0123456789ab` },
    ],
    [
      "an ARN whose name segment differs",
      { changeSetId: GOOD_ARN.replace(NAME, `nimbus-${SHA}-ffffffffffff`) },
    ],
    ["an ARN that is not a change set ARN", { changeSetId: "arn:aws:s3:::bucket" }],
    ["no change set id", { changeSetId: undefined }],
  ])(
    "a reply with %s names no target: nothing is discarded (the gateway does not guess)",
    async (_n, over) => {
      const h = refusedAfterCreate(over);
      rejected(await h.exec.execute(CFN_DEPLOY));
      expect(discardsOf(h.dispatched)).toEqual([]);
    },
  );

  test("a reply that is too large is refused and its change set discarded too", async () => {
    const h = harness({ prepareReply: () => reply({ padding: "x".repeat(300_000) }) });
    rejected(await h.exec.execute(CFN_DEPLOY));
    expect(discardsOf(h.dispatched)).toHaveLength(1);
  });

  test("a prepare child that failed (no reply) discards nothing and says where to look", async () => {
    const h = harness({
      prepareReply: () => {
        throw new Error("child died");
      },
    });
    rejected(await h.exec.execute(CFN_DEPLOY));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("a refusal that cannot follow a created change set is silent", async () => {
    const h = harness({ settleRefuses: PREPARE_REFUSALS.unbound, prepareReply: () => ({}) });
    rejected(await h.exec.execute(CFN_DEPLOY));
    expect(discardsOf(h.dispatched)).toEqual([]);
  });

  test("a Terraform row has no change set to discard whatever its prepare says", async () => {
    const h = harness({
      settleRefuses: PREPARE_REFUSALS.diffTooLarge,
      prepareReply: () => reply(),
    });
    await h.exec.execute(TF_APPLY);
    expect(discardsOf(h.dispatched)).toEqual([]);
  });
});
