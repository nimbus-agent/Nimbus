// packages/gateway/src/engine/executor-iac.test.ts
// Phase 9.7 D2: the preflight phase and the settle hand-off of a bound IaC write (I54, static D42).
// Every branch they add to `executor.ts` (pinned at 100%) is covered here. SYNTHETIC rows through the
// constructor's `writeTable` seam, and a fake `boundWriteCapabilities` on the dispatcher (round-2
// fix 1: the capabilities reach the gate only through the dispatcher argument).
import { describe, expect, test } from "bun:test";
import {
  SYNTH_PREPARE_IDS,
  SYNTH_REPLY,
  synthBound,
  synthBoundRow,
} from "../connectors/connector-writes/bound-fixtures.test-helpers.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { ConsentDisconnectedError } from "../ipc/consent.ts";
import type {
  BoundWriteCapabilities,
  PreflightOutcome,
  SettleContext,
  SettledWrite,
} from "./bound-write-capabilities.ts";
import {
  CONFIRM_UNSUPPORTED_REASON,
  NO_POLICY_OVERLAY,
  PREFLIGHT_FAILED_REASON,
  PREFLIGHT_NO_CONFIRM_REASON,
  ToolExecutor,
} from "./executor.ts";
import { PREPARE_REFUSALS } from "./prepare-step.ts";
import type {
  ActionResult,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  PlannedAction,
} from "./types.ts";

const DIR = "prod";
const CONFIRM_TEXT = "iac/prod";
const PLAN = {
  lines: [
    "Deletes: 1, Replaces: 0, Creates: 2, Updates: 0",
    "  - aws_s3_bucket.logs",
    "End of plan: 3 changes (1 deletes, 0 replaces)",
  ],
  text: "Deletes: 1, Replaces: 0, Creates: 2, Updates: 0\n  - aws_s3_bucket.logs\nEnd of plan: 3 changes (1 deletes, 0 replaces)",
  bytes: 70,
  sha256: "c".repeat(64),
  changeCount: 3,
  deleteCount: 1,
} as const;

const ACTION: PlannedAction = {
  type: "iac.terraform.apply",
  payload: { mcpToolId: "iac_synth_apply", input: { dir: DIR } },
};

/** A bound row on the real `iac.terraform.apply` type whose binds name `changeSetId`. */
function iacRow(
  o: { wave?: 3 | 4; preflight?: boolean; settle?: boolean } = {},
): ConnectorWriteRow {
  const base = synthBound({
    ...(o.preflight === false ? {} : { preflight: "iac" as const }),
    ...(o.settle === false ? {} : { settle: "iac-cfn" as const }),
  });
  return synthBoundRow(o.wave ?? 4, {
    ...base,
    binds: [{ field: "changeSetId", from: (r) => (r as { digest?: string }).digest }],
  });
}

interface CapOptions {
  readonly preflight?: () => Promise<PreflightOutcome> | PreflightOutcome;
  readonly settle?: (ctx: SettleContext) => Promise<SettledWrite>;
}

interface Harness {
  readonly exec: ToolExecutor;
  readonly log: string[];
  readonly prompts: string[];
  readonly details: unknown[];
  readonly audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }>;
  readonly egress: EgressEntry[];
  readonly dispatched: PlannedAction[];
  readonly preflightInputs: Array<Record<string, unknown>>;
  readonly settleCalls: SettleContext[];
}

interface HarnessOptions {
  readonly row?: ConnectorWriteRow;
  readonly approve?: boolean;
  readonly typed?: string;
  readonly channel?: "typed" | "plain-only";
  /** `undefined` = the dispatcher carries no capabilities at all. */
  readonly caps?: CapOptions | "none";
  readonly writeThrows?: boolean;
  /** The typed prompt never answers: it throws this (an approval timeout, a disconnect). */
  readonly promptThrows?: Error;
  readonly prepareReply?: () => unknown;
}

function harness(o: HarnessOptions = {}): Harness {
  const row = o.row ?? iacRow();
  const log: string[] = [];
  const prompts: string[] = [];
  const details: unknown[] = [];
  const audits: Harness["audits"] = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const preflightInputs: Array<Record<string, unknown>> = [];
  const settleCalls: SettleContext[] = [];
  const caps: CapOptions = o.caps === "none" ? {} : (o.caps ?? {});
  const capabilities: BoundWriteCapabilities | undefined =
    o.caps === "none"
      ? undefined
      : {
          preflight: async (id, input) => {
            log.push(`preflight:${id}`);
            preflightInputs.push({ ...input });
            return caps.preflight === undefined
              ? {
                  ok: true,
                  release: () => {
                    log.push("release");
                  },
                }
              : caps.preflight();
          },
          settle: async (id, ctx) => {
            log.push(`settle:${id}`);
            settleCalls.push(ctx);
            if (caps.settle !== undefined) return caps.settle(ctx);
            return {
              values: { changeSetId: "arn:settled" },
              fields: [{ label: "Stack", value: "prod" }],
              plan: PLAN,
              cleanup: async () => {
                log.push("cleanup");
              },
            };
          },
        };
  const consent =
    o.channel === "plain-only"
      ? {
          requestApproval: async (p: string, d?: Record<string, unknown>) => {
            log.push("prompt");
            prompts.push(p);
            details.push(d);
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
            details.push(req.details);
            if (o.promptThrows !== undefined) throw o.promptThrows;
            return { approved: o.approve ?? true, typed: o.typed ?? CONFIRM_TEXT };
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
          return o.prepareReply === undefined ? SYNTH_REPLY : o.prepareReply();
        }
        if (o.writeThrows === true) throw new Error("apply exploded");
        return { applied: true };
      },
      ...(capabilities === undefined ? {} : { boundWriteCapabilities: capabilities }),
    },
    undefined,
    {
      append: (e) => {
        egress.push(e);
        log.push(`egress:${e.destination}:${e.resultStatus}`);
      },
    },
    NO_POLICY_OVERLAY,
    undefined,
    undefined,
    { rows: [row], prepareToolIds: SYNTH_PREPARE_IDS },
  );
  return {
    exec,
    log,
    prompts,
    details,
    audits,
    egress,
    dispatched,
    preflightInputs,
    settleCalls,
  };
}

function rejectedWith(r: ActionResult, reason: string): void {
  expect(r.status).toBe("rejected");
  if (r.status === "rejected") expect(r.reason).toBe(reason);
}

const prepares = (h: Harness): PlannedAction[] =>
  h.dispatched.filter((a) => a.type.endsWith(".write.prepare"));
const writes = (h: Harness): PlannedAction[] =>
  h.dispatched.filter((a) => !a.type.endsWith(".write.prepare"));

describe("preflightPhase: a row with the iac tag refuses before any child exists (D2)", () => {
  test("a channel with no typed prompt (ChatOps) is refused before the capability, the prepare and any prompt", async () => {
    const h = harness({ channel: "plain-only" });
    const r = await h.exec.execute(ACTION);
    rejectedWith(r, CONFIRM_UNSUPPORTED_REASON);
    expect(h.dispatched).toEqual([]);
    expect(h.log.some((l) => l.startsWith("preflight:"))).toBe(false);
    expect(h.prompts).toEqual([]);
    expect(JSON.parse(h.audits.at(-1)?.actionJson ?? "{}")).toMatchObject({
      confirm: "unsupported_channel",
    });
  });

  test("an input the typed confirm cannot render is refused before the capability and the prepare", async () => {
    const h = harness();
    const r = await h.exec.execute({
      type: "iac.terraform.apply",
      payload: { mcpToolId: "iac_synth_apply", input: { dir: "pro d" + " " } },
    });
    expect(r.status).toBe("rejected");
    expect(h.dispatched).toEqual([]);
    expect(h.log.some((l) => l.startsWith("preflight:"))).toBe(false);
  });

  test("a row with the tag but no typed confirm target is refused", async () => {
    const h = harness({ row: iacRow({ wave: 3 }) });
    rejectedWith(await h.exec.execute(ACTION), PREFLIGHT_NO_CONFIRM_REASON);
    expect(h.dispatched).toEqual([]);
  });

  test("a dispatcher without the capability refuses the row (fail closed, never skipped)", async () => {
    const h = harness({ caps: "none" });
    rejectedWith(await h.exec.execute(ACTION), PREPARE_REFUSALS.capabilityMissing);
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

  test("the capability's refusal is the gate's reason; nothing is prepared or asked", async () => {
    const h = harness({
      caps: {
        preflight: () => ({
          ok: false,
          reason: "iac: the working directory is not an approved directory",
        }),
      },
    });
    rejectedWith(
      await h.exec.execute(ACTION),
      "iac: the working directory is not an approved directory",
    );
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.log).not.toContain("release");
  });

  test("a capability that throws refuses with the fixed reason, never its text", async () => {
    const h = harness({
      caps: {
        preflight: () => {
          throw new Error("/secret/grant/table exploded");
        },
      },
    });
    const r = await h.exec.execute(ACTION);
    rejectedWith(r, PREFLIGHT_FAILED_REASON);
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(h.dispatched).toEqual([]);
  });

  test("the capability gets the row's tool id and the caller's input, and runs before the prepare read", async () => {
    const h = harness();
    await h.exec.execute(ACTION);
    expect(h.preflightInputs).toEqual([{ dir: DIR }]);
    expect(h.log.indexOf("preflight:synth_apply")).toBeGreaterThanOrEqual(0);
    expect(h.log.indexOf("preflight:synth_apply")).toBeLessThan(
      h.log.indexOf("dispatch:iac.write.prepare"),
    );
  });

  test("a row without the tag is untouched: no capability call, no lock", async () => {
    const h = harness({ row: iacRow({ preflight: false, settle: false }) });
    const r = await h.exec.execute(ACTION);
    expect(r.status).toBe("ok");
    expect(h.log.some((l) => l.startsWith("preflight:") || l === "release")).toBe(false);
  });
});

describe("the lock the preflight took is freed on every exit path (D2)", () => {
  test("approved and dispatched: freed after the write, not before", async () => {
    const h = harness();
    expect((await h.exec.execute(ACTION)).status).toBe("ok");
    expect(h.log.filter((l) => l === "release")).toHaveLength(1);
    expect(h.log.indexOf("release")).toBeGreaterThan(h.log.indexOf("dispatch:iac.terraform.apply"));
  });

  test("declined by the owner", async () => {
    const h = harness({ approve: false });
    expect((await h.exec.execute(ACTION)).status).toBe("rejected");
    expect(h.log.filter((l) => l === "release")).toHaveLength(1);
    expect(writes(h)).toEqual([]);
  });

  test("a confirm mismatch", async () => {
    const h = harness({ typed: "iac/other" });
    expect((await h.exec.execute(ACTION)).status).toBe("rejected");
    expect(h.log.filter((l) => l === "release")).toHaveLength(1);
    expect(writes(h)).toEqual([]);
  });

  test("a prepare failure", async () => {
    const h = harness({
      prepareReply: () => {
        throw new Error("down");
      },
    });
    rejectedWith(await h.exec.execute(ACTION), PREPARE_REFUSALS.failed);
    expect(h.log.filter((l) => l === "release")).toHaveLength(1);
  });

  test("an approval that times out (the prompt throws) frees the lock and runs the cleanup; the error reaches the caller", async () => {
    const h = harness({ promptThrows: new Error("approval timed out") });
    await expect(h.exec.execute(ACTION)).rejects.toThrow("approval timed out");
    expect(h.log.filter((l) => l === "release")).toHaveLength(1);
    expect(h.log.filter((l) => l === "cleanup")).toHaveLength(1);
    expect(writes(h)).toEqual([]);
  });

  test("an owner who disconnects mid-prompt is a rejection, and the lock is freed", async () => {
    const h = harness({ promptThrows: new ConsentDisconnectedError() });
    expect((await h.exec.execute(ACTION)).status).toBe("rejected");
    expect(h.log.filter((l) => l === "release")).toHaveLength(1);
  });

  test("two runs in turn on the same capability each take and free the lock once", async () => {
    const h = harness();
    await h.exec.execute(ACTION);
    await h.exec.execute(ACTION);
    expect(h.log.filter((l) => l === "release")).toHaveLength(2);
    expect(h.log.filter((l) => l.startsWith("preflight:"))).toHaveLength(2);
  });

  test("a dispatch that throws still frees the lock, and the error reaches the caller", async () => {
    const h = harness({ writeThrows: true });
    await expect(h.exec.execute(ACTION)).rejects.toThrow("apply exploded");
    expect(h.log.filter((l) => l === "release")).toHaveLength(1);
  });
});

describe("the settle hand-off: the gateway's values, its plan, its cleanup (D2, I54)", () => {
  test("the write carries the settler's value, not the prepare reply's, and the plan is in the prompt", async () => {
    const h = harness();
    const r = await h.exec.execute(ACTION);
    expect(r.status).toBe("ok");
    const sent = writes(h)[0]?.payload?.["input"] as Record<string, unknown>;
    expect(sent).toEqual({ dir: DIR, changeSetId: "arn:settled" });
    expect(JSON.stringify(writes(h))).not.toContain(SYNTH_REPLY.digest);
    expect(h.prompts[0]).toContain("aws_s3_bucket.logs");
    expect(h.prompts[0]).toContain("End of plan: 3 changes (1 deletes, 0 replaces)");
    expect(h.prompts[0]?.split("End of plan").length).toBe(2);
    const shown = h.details[0] as { plan?: { sha256?: string } };
    expect(shown.plan?.sha256).toBe(PLAN.sha256);
    expect(h.settleCalls[0]?.settle).toBe("iac-cfn");
    expect(h.settleCalls[0]?.reply).toEqual(SYNTH_REPLY);
  });

  test("the audit row carries the plan digest as diffSha256 and the settled values digest, never the plan text", async () => {
    const h = harness();
    await h.exec.execute(ACTION);
    const write = JSON.parse(h.audits.at(-1)?.actionJson ?? "{}") as Record<string, unknown>;
    expect(write["diffSha256"]).toBe(PLAN.sha256);
    expect(typeof write["boundValuesSha256"]).toBe("string");
    expect(h.audits.at(-1)?.actionJson).not.toContain("aws_s3_bucket.logs");
  });

  test("the prompt adds no footer of its own: a plan without one shows none", async () => {
    const h = harness({
      caps: {
        settle: async () => ({
          values: { changeSetId: "arn:settled" },
          fields: [{ label: "Stack", value: "prod" }],
          plan: { lines: ["a", "b"], text: "a\nb", bytes: 3, sha256: "d".repeat(64) },
          cleanup: async () => undefined,
        }),
      },
    });
    await h.exec.execute(ACTION);
    expect(h.prompts[0]).toContain("a\nb");
    expect(h.prompts[0]).not.toContain("End of plan");
    expect(h.prompts[0]).not.toContain(" lines");
  });

  test("a settle with no plan shows only the prepared facts", async () => {
    const h = harness({
      caps: {
        settle: async () => ({
          values: { changeSetId: "arn:settled" },
          fields: [{ label: "Stack", value: "prod" }],
          cleanup: async () => undefined,
        }),
      },
    });
    await h.exec.execute(ACTION);
    expect(h.prompts[0]).not.toContain("End of plan");
    const audit = JSON.parse(h.audits.at(-1)?.actionJson ?? "{}") as Record<string, unknown>;
    expect(audit["diffSha256"]).toBeUndefined();
  });

  test("cleanup runs after the dispatch, after a decline and after a mismatch", async () => {
    for (const o of [{}, { approve: false }, { typed: "iac/other" }] as const) {
      const h = harness(o);
      await h.exec.execute(ACTION);
      expect(h.log.filter((l) => l === "cleanup")).toHaveLength(1);
      expect(h.log.indexOf("cleanup")).toBeLessThan(h.log.lastIndexOf("release"));
    }
  });

  test("a cleanup that throws is swallowed: the result stands and the lock is still freed", async () => {
    const h = harness({
      caps: {
        settle: async () => ({
          values: { changeSetId: "arn:settled" },
          fields: [{ label: "Stack", value: "prod" }],
          cleanup: async () => {
            throw new Error("rm failed");
          },
        }),
      },
    });
    expect((await h.exec.execute(ACTION)).status).toBe("ok");
    expect(h.log).toContain("release");
  });

  test("a settle that refuses ends the gate with its fixed reason; nothing is asked or written", async () => {
    const h = harness({
      caps: {
        settle: async () => {
          throw new Error("boom");
        },
      },
    });
    rejectedWith(await h.exec.execute(ACTION), PREPARE_REFUSALS.settleFailed);
    expect(h.prompts).toEqual([]);
    expect(writes(h)).toEqual([]);
    expect(h.log).toContain("release");
  });

  test("a settled row with no capability is refused at the preflight, before the prepare read (a row cannot declare a settle without a preflight)", async () => {
    expect(() => iacRow({ preflight: false })).toThrow("a settled row must declare preflight");
    const h = harness({ caps: "none" });
    rejectedWith(await h.exec.execute(ACTION), PREPARE_REFUSALS.capabilityMissing);
    expect(prepares(h)).toEqual([]);
  });

  test("the public gate() still never binds, with or without the capability", async () => {
    const h = harness();
    const r = await h.exec.gate(ACTION);
    expect(r).not.toBe("proceed");
    expect(h.log.some((l) => l.startsWith("preflight:") || l.startsWith("settle:"))).toBe(false);
  });
});
