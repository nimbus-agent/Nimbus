// packages/gateway/src/engine/executor-bound.test.ts
// Phase 9.7 D0b: the gate phases of a bound write (I54, static D42). Every branch the phases add to
// `executor.ts` is covered here (the file is pinned at 100%). SYNTHETIC rows only, passed through
// the constructor's `writeTable` seam: no production row is bound.
import { describe, expect, test } from "bun:test";
import {
  SYNTH_PREPARE_IDS,
  SYNTH_REPLY,
  synthBound,
  synthBoundRow,
} from "../connectors/connector-writes/bound-fixtures.test-helpers.ts";
import {
  type ConnectorWriteRow,
  row as makeRow,
  textField,
  withBound,
  withPreview,
} from "../connectors/connector-writes/types.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import {
  BOUND_NOT_HITL_REASON,
  BOUND_ROW_MISMATCH_REASON,
  BOUND_VIA_GATE_REASON,
  CONFIRM_MISMATCH_REASON,
  type ExecuteOptions,
  type ExecutorDelegationDep,
  type ExecutorPolicyDep,
  NO_POLICY_OVERLAY,
  ToolExecutor,
  type WriteTable,
} from "./executor.ts";
import { PREPARE_HITL_REFUSAL, PREPARE_REFUSALS } from "./prepare-step.ts";
import type {
  ActionResult,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  PlannedAction,
} from "./types.ts";

const DIR = "prod";
const DIGEST = SYNTH_REPLY.digest;
const CONFIRM_TEXT = "iac/prod";

/** The act door's shape. */
const NESTED: PlannedAction = {
  type: "iac.terraform.apply",
  payload: { mcpToolId: "iac_synth_apply", input: { dir: DIR } },
};
/** A flat payload (found by type alone). */
const FLAT: PlannedAction = { type: "iac.terraform.apply", payload: { dir: DIR } };

interface Harness {
  readonly exec: ToolExecutor;
  readonly log: string[];
  readonly prompts: string[];
  readonly details: unknown[];
  readonly confirmed: ConfirmedApprovalRequest[];
  readonly audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }>;
  readonly egress: EgressEntry[];
  readonly dispatched: PlannedAction[];
}

interface HarnessOptions {
  readonly row?: ConnectorWriteRow;
  readonly extraRows?: readonly ConnectorWriteRow[];
  readonly approve?: boolean;
  readonly typed?: string;
  readonly prepareReply?: () => Promise<unknown> | unknown;
  readonly writeReply?: unknown;
  readonly delegation?: ExecutorDelegationDep;
  readonly policy?: ExecutorPolicyDep;
  readonly table?: WriteTable | "none";
}

function harness(o: HarnessOptions = {}): Harness {
  const row = o.row ?? synthBoundRow(3);
  const log: string[] = [];
  const prompts: string[] = [];
  const details: unknown[] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const audits: Harness["audits"] = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const table: WriteTable | undefined =
    o.table === "none"
      ? undefined
      : (o.table ?? { rows: [row, ...(o.extraRows ?? [])], prepareToolIds: SYNTH_PREPARE_IDS });
  const sink: EgressSink = {
    append: (e) => {
      egress.push(e);
      log.push(`egress:${e.destination}:${e.resultStatus}`);
    },
  };
  const consent = {
    requestApproval: async (prompt: string, d?: Record<string, unknown>) => {
      log.push("prompt");
      prompts.push(prompt);
      details.push(d);
      return o.approve ?? true;
    },
    requestConfirmedApproval: async (
      req: ConfirmedApprovalRequest,
    ): Promise<ConfirmedApprovalResult> => {
      log.push("prompt:confirmed");
      confirmed.push(req);
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
        return o.writeReply ?? { applied: true };
      },
    },
    o.delegation,
    sink,
    o.policy ?? NO_POLICY_OVERLAY,
    undefined,
    undefined,
    table,
  );
  return { exec, log, prompts, details, confirmed, audits, egress, dispatched };
}

/** The write's dispatches (everything that is not a prepare read). */
function writesOf(h: Harness): PlannedAction[] {
  return h.dispatched.filter((a) => !a.type.endsWith(".write.prepare"));
}

function inputOf(a: PlannedAction | undefined): Record<string, unknown> {
  const p = a?.payload;
  if (p === undefined) throw new Error("no payload");
  const nested = p["input"];
  return (typeof nested === "object" && nested !== null ? nested : p) as Record<string, unknown>;
}

function rejectedWith(r: ActionResult, reason: string): void {
  expect(r.status).toBe("rejected");
  if (r.status === "rejected") expect(r.reason).toBe(reason);
}

function lastAuditJson(h: Harness): Record<string, unknown> {
  const last = h.audits.at(-1);
  if (last === undefined) throw new Error("no audit row");
  return JSON.parse(last.actionJson) as Record<string, unknown>;
}

describe("a bound write prepares and binds on every door shape", () => {
  for (const [name, action] of [
    ["the act door's nested payload", NESTED],
    ["a flat payload", FLAT],
    ["a model-origin action", { ...NESTED, origin: "model" } as PlannedAction],
  ] as const) {
    test(`${name}: the prepare read runs, the gateway's value is injected, the reply stays out`, async () => {
      const h = harness();
      const r = await h.exec.execute(action);
      expect(r).toEqual({ status: "ok", result: { applied: true } });
      const sent = writesOf(h);
      expect(sent).toHaveLength(1);
      expect(inputOf(sent[0])).toEqual({ dir: DIR, planDigest: DIGEST });
      // The prepare reply (`summary`) is nowhere in the write's input or its result.
      expect(JSON.stringify(sent[0])).not.toContain(SYNTH_REPLY.summary);
      expect(JSON.stringify(r)).not.toContain(SYNTH_REPLY.summary);
    });
  }

  test("the injected action keeps its type, its routing key and its origin", async () => {
    const h = harness();
    await h.exec.execute({ ...NESTED, origin: "model" });
    expect(writesOf(h)[0]).toEqual({
      type: "iac.terraform.apply",
      origin: "model",
      payload: { mcpToolId: "iac_synth_apply", input: { dir: DIR, planDigest: DIGEST } },
    });
  });

  test("the prepare read is audited and ledgered BEFORE the write's own rows (I29)", async () => {
    const h = harness();
    await h.exec.execute(NESTED);
    expect(h.log).toEqual([
      "audit:iac.write.prepare:not_required", // the prepare read's own audit and egress rows...
      "egress:iac:authorized",
      "dispatch:iac.write.prepare",
      "prompt",
      "audit:iac.terraform.apply:approved", // ...then the write's
      "egress:iac:authorized",
      "dispatch:iac.terraform.apply",
    ]);
    expect(h.audits.map((a) => a.actionType)).toEqual(["iac.write.prepare", "iac.terraform.apply"]);
    expect(h.audits.map((a) => a.hitlStatus)).toEqual(["not_required", "approved"]);
  });

  test("the prepare read runs through the executor's own dispatch as <service>.write.prepare", async () => {
    const h = harness();
    await h.exec.execute(NESTED);
    expect(h.dispatched[0]).toEqual({
      type: "iac.write.prepare",
      payload: { mcpToolId: "iac_synth_plan", input: { dir: DIR } },
    });
  });

  test("the prompt shows the prepared facts, never the bound value or the raw reply", async () => {
    const h = harness();
    await h.exec.execute(NESTED);
    expect(h.prompts[0]).toContain("Prepared:");
    expect(h.prompts[0]).toContain(`Plan: ${SYNTH_REPLY.summary}`);
    expect(h.prompts[0]).not.toContain(DIGEST);
    const shown = h.details[0] as { prepared?: { status: string; fields: unknown[] } };
    expect(shown.prepared?.status).toBe("ok");
  });

  test("facts past the display cap are counted in the preview", async () => {
    const many = Array.from({ length: 22 }, (_, i) => ({ label: `f${i}`, value: "v" }));
    const h = harness({ row: synthBoundRow(3, synthBound({ select: () => many })) });
    await h.exec.execute(NESTED);
    expect(h.prompts[0]).toContain("(2 more fields not shown)");
  });

  test("an owner decline dispatches no write, injects nothing; the prepare rows remain", async () => {
    const h = harness({ approve: false });
    const r = await h.exec.execute(NESTED);
    expect(r.status).toBe("rejected");
    expect(writesOf(h)).toEqual([]);
    expect(h.audits.map((a) => `${a.actionType}:${a.hitlStatus}`)).toEqual([
      "iac.write.prepare:not_required",
      "iac.terraform.apply:rejected",
    ]);
    expect(h.egress.at(-1)?.resultStatus).toBe("blocked");
  });

  test("an ordinary (non-bound) write is dispatched as the very same action object", async () => {
    const plain = withPreview(makeRow("plain_apply", "iac.pulumi.up", "write", 3), {
      target: "{dir}",
      summary: "Up {dir}",
      fields: [textField("dir")],
    });
    const h = harness({ row: synthBoundRow(3), extraRows: [plain] });
    const action: PlannedAction = { type: "iac.pulumi.up", payload: { input: { dir: DIR } } };
    await h.exec.execute(action);
    expect(h.dispatched).toEqual([action]);
    expect(h.dispatched[0]).toBe(action);
  });
});

describe("prepare runs before ANY approval, a delegate included (fix 1)", () => {
  const store = {
    activeDelegateePeer: () => "peer:bob",
    activeDelegateFor: (_k: string, _v: string, peer: string) => peer === "peer:bob",
  };

  test("a delegate's approval of a bound write comes after the prepare read, and the write is bound", async () => {
    let h: Harness | undefined;
    const delegation: ExecutorDelegationDep = {
      store,
      isOperatorValid: () => true,
      requestRemote: async () => {
        h?.log.push("remote-asked");
        return { kind: "answered", peerId: "peer:bob", approved: true };
      },
    };
    h = harness({ delegation });
    const r = await h.exec.execute(NESTED);
    expect(r.status).toBe("ok");
    expect(h.log.indexOf("dispatch:iac.write.prepare")).toBeLessThan(h.log.indexOf("remote-asked"));
    expect(h.prompts).toEqual([]);
    expect(inputOf(writesOf(h)[0])["planDigest"]).toBe(DIGEST);
  });

  test("a failed prepare means the delegate is never asked", async () => {
    let asked = 0;
    const delegation: ExecutorDelegationDep = {
      store,
      isOperatorValid: () => true,
      requestRemote: async () => {
        asked += 1;
        return { kind: "answered", peerId: "peer:bob", approved: true };
      },
    };
    const h = harness({
      delegation,
      prepareReply: () => {
        throw new Error("down");
      },
    });
    const r = await h.exec.execute(NESTED);
    rejectedWith(r, PREPARE_REFUSALS.failed);
    expect(asked).toBe(0);
  });

  test("a delegate declining leaves the write undispatched", async () => {
    const delegation: ExecutorDelegationDep = {
      store,
      isOperatorValid: () => true,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: false }),
    };
    const h = harness({ delegation });
    const r = await h.exec.execute(NESTED);
    expect(r.status).toBe("rejected");
    expect(writesOf(h)).toEqual([]);
  });
});

describe("every prepare failure refuses with no prompt, on every shape (fix 8)", () => {
  const cases: Array<[string, HarnessOptions, string]> = [
    [
      "the prepare read throws",
      {
        prepareReply: () => {
          throw new Error("connector exploded with secret-token-123");
        },
      },
      PREPARE_REFUSALS.failed,
    ],
    [
      "the prepare read times out",
      {
        row: synthBoundRow(3, synthBound({ budgetMs: 15 })),
        prepareReply: () => new Promise(() => undefined),
      },
      PREPARE_REFUSALS.timeout,
    ],
    [
      "the reply is oversized",
      { prepareReply: () => ({ ...SYNTH_REPLY, pad: "x".repeat(5000) }) },
      PREPARE_REFUSALS.replyTooLarge,
    ],
    [
      "the reply lacks a bound value",
      { prepareReply: () => ({ summary: "s" }) },
      PREPARE_REFUSALS.unbound,
    ],
    [
      "the reply cannot be shown",
      { row: synthBoundRow(3, synthBound({ select: () => "nope" as never })) },
      PREPARE_REFUSALS.unshowable,
    ],
    [
      "the table does not declare the prepare tool",
      { table: { rows: [synthBoundRow(3)], prepareToolIds: new Set() } },
      PREPARE_REFUSALS.toolNotAllowed,
    ],
    [
      "no table is supplied, so the production (empty) prepare set decides",
      { table: "none", row: synthBoundRow(3) },
      PREPARE_REFUSALS.toolNotAllowed,
    ],
    [
      "the prepare read would need approval (policy)",
      {
        policy: { isHitlRequiredByPolicy: (t) => t === "iac.write.prepare" },
      },
      PREPARE_REFUSALS.refused,
    ],
  ];

  for (const [name, opts, reason] of cases) {
    for (const [shape, action] of [
      ["nested", NESTED],
      ["flat", FLAT],
    ] as const) {
      test(`${name} (${shape})`, async () => {
        // The "no table" case reads the rows from a runner-less executor: give it the rows via the
        // before-state runner seam by building it directly.
        const h = opts.table === "none" ? harnessWithRunnerRows(opts) : harness(opts);
        const r = await h.exec.execute(action);
        rejectedWith(r, reason);
        expect(h.prompts).toEqual([]);
        expect(h.confirmed).toEqual([]);
        expect(writesOf(h)).toEqual([]);
        expect(JSON.stringify(r)).not.toContain("secret-token");
        const audit = lastAuditJson(h);
        expect(audit["hitlRejectReason"]).toBe(reason);
        expect(h.audits.at(-1)?.hitlStatus).toBe("rejected");
        expect(h.egress.at(-1)?.resultStatus).toBe("blocked");
      });
    }
  }

  test("a prepare tool missing from the listing is refused at the gate (door option)", async () => {
    const h = harness();
    const opts: ExecuteOptions = { prepareToolUnlisted: true };
    const r = await h.exec.execute(NESTED, opts);
    rejectedWith(r, PREPARE_REFUSALS.toolUnavailable);
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

  test("the prepare type's own refusal is reasoned PREPARE_HITL_REFUSAL in its audit row", async () => {
    const h = harness({ policy: { isHitlRequiredByPolicy: (t) => t === "iac.write.prepare" } });
    await h.exec.execute(NESTED);
    const prepareAudit = JSON.parse(h.audits[0]?.actionJson ?? "{}") as Record<string, unknown>;
    expect(h.audits[0]?.actionType).toBe("iac.write.prepare");
    expect(prepareAudit["hitlRejectReason"]).toBe(PREPARE_HITL_REFUSAL);
  });
});

/** An executor whose rows come from the before-state runner and whose write table is ABSENT. */
function harnessWithRunnerRows(o: HarnessOptions): Harness {
  const base = harness({ ...o, table: undefined });
  const row = o.row ?? synthBoundRow(3);
  const exec = new ToolExecutor(
    { requestApproval: async () => true },
    {
      recordAudit: (e) =>
        base.audits.push({
          actionType: e.actionType,
          hitlStatus: e.hitlStatus,
          actionJson: e.actionJson,
        }),
    },
    {
      dispatch: async (a) => {
        base.dispatched.push(a);
        return SYNTH_REPLY;
      },
    },
    undefined,
    { append: (e) => base.egress.push(e) },
    NO_POLICY_OVERLAY,
    undefined,
    { rows: [row], read: async () => undefined },
  );
  return { ...base, exec };
}

describe("a caller can never supply a bound field (fix 3)", () => {
  const forged: Array<[string, PlannedAction]> = [
    [
      "at the payload root, beside input",
      { type: "iac.terraform.apply", payload: { planDigest: "x", input: { dir: DIR } } },
    ],
    [
      "inside payload.input",
      { type: "iac.terraform.apply", payload: { input: { dir: DIR, planDigest: "x" } } },
    ],
    ["in a flat payload", { type: "iac.terraform.apply", payload: { dir: DIR, planDigest: "x" } }],
    [
      "with a routing key and a nested copy",
      {
        type: "iac.terraform.apply",
        payload: { mcpToolId: "iac_synth_apply", input: { dir: DIR, planDigest: "" } },
      },
    ],
  ];
  for (const [name, action] of forged) {
    test(`${name}: refused before any read or prompt`, async () => {
      const h = harness();
      const r = await h.exec.execute(action);
      rejectedWith(r, PREPARE_REFUSALS.callerBound);
      expect(h.dispatched).toEqual([]);
      expect(h.prompts).toEqual([]);
      expect(h.audits.map((a) => a.actionType)).toEqual(["iac.terraform.apply"]);
    });
  }

  test("an input over the row's cap is refused before any read", async () => {
    const h = harness({ row: synthBoundRow(3, synthBound({ maxInputBytes: 5 })) });
    rejectedWith(await h.exec.execute(NESTED), PREPARE_REFUSALS.inputTooLarge);
    expect(h.dispatched).toEqual([]);
  });

  test("a non-object input is refused before any read", async () => {
    const h = harness();
    const r = await h.exec.execute({ type: "iac.terraform.apply", payload: { input: "text" } });
    rejectedWith(r, PREPARE_REFUSALS.notObject);
    expect(h.dispatched).toEqual([]);
  });

  test("an action of a bound type naming another tool is refused", async () => {
    const h = harness();
    const r = await h.exec.execute({
      type: "iac.terraform.apply",
      payload: { mcpToolId: "iac_something_else", input: { dir: DIR } },
    });
    rejectedWith(r, BOUND_ROW_MISMATCH_REASON);
    expect(h.dispatched).toEqual([]);
  });

  test("a sibling non-bound row of the same type cannot ride the bound type", async () => {
    const sibling = withPreview(makeRow("sibling_apply", "iac.terraform.apply", "write", 3), {
      target: "{dir}",
      summary: "x",
      fields: [textField("dir")],
    });
    const h = harness({ extraRows: [sibling] });
    const r = await h.exec.execute({
      type: "iac.terraform.apply",
      payload: { mcpToolId: "iac_sibling_apply", input: { dir: DIR } },
    });
    rejectedWith(r, BOUND_ROW_MISMATCH_REASON);
    expect(h.dispatched).toEqual([]);
  });
});

describe("a bound row never reaches dispatch except through execute() (fix 1 / D42(e))", () => {
  test("the public gate() refuses a bound row: audited, ledgered blocked, nothing dispatched", async () => {
    const h = harness();
    const r = await h.exec.gate(NESTED);
    rejectedWith(r as ActionResult, BOUND_VIA_GATE_REASON);
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.hitlStatus).toBe("rejected");
    expect(h.egress[0]?.resultStatus).toBe("blocked");
  });

  test("a bound row whose action type needs no approval is refused (fail closed)", async () => {
    const plain = withBound(
      withPreview(makeRow("plain_bound", "iac.plain.apply", "write", 3), {
        target: "{dir}",
        summary: "x",
        fields: [textField("dir")],
      }),
      synthBound(),
      SYNTH_PREPARE_IDS,
    );
    const h = harness({ row: plain });
    const r = await h.exec.execute({ type: "iac.plain.apply", payload: { dir: DIR } });
    rejectedWith(r, BOUND_NOT_HITL_REASON);
    expect(h.dispatched).toEqual([]);
  });

  test("the prepare read is gated through gate() (not through execute()) and never binds", async () => {
    // The prepare action is an ordinary type: it proceeds under the public gate.
    const h = harness();
    const r = await h.exec.gate({
      type: "iac.write.prepare",
      payload: { mcpToolId: "iac_synth_plan", input: { dir: DIR } },
    });
    expect(r).toBe("proceed");
  });
});

describe("Wave 4 composes with the bound write (D0a)", () => {
  test("prepare runs before the typed prompt, which shows the facts; the typed check still decides", async () => {
    const h = harness({ row: synthBoundRow(4) });
    const r = await h.exec.execute(NESTED);
    expect(r.status).toBe("ok");
    expect(h.log.indexOf("dispatch:iac.write.prepare")).toBeLessThan(
      h.log.indexOf("prompt:confirmed"),
    );
    expect(h.confirmed[0]?.confirmText).toBe(CONFIRM_TEXT);
    expect(h.confirmed[0]?.prompt).toContain("Prepared:");
    expect(inputOf(writesOf(h)[0])["planDigest"]).toBe(DIGEST);
  });

  test("a wrong typed text: prepared, asked, rejected, nothing bound or dispatched", async () => {
    const h = harness({ row: synthBoundRow(4), typed: "iac/PROD" });
    const r = await h.exec.execute(NESTED);
    rejectedWith(r, CONFIRM_MISMATCH_REASON);
    expect(writesOf(h)).toEqual([]);
    expect(h.dispatched).toHaveLength(1);
  });

  test("an unrenderable confirm target is refused AFTER the prepare read ran, before any prompt", async () => {
    const h = harness({ row: synthBoundRow(4) });
    const r = await h.exec.execute({
      type: "iac.terraform.apply",
      payload: { input: { dir: "" } },
    });
    expect(r.status).toBe("rejected");
    expect(h.confirmed).toEqual([]);
    expect(writesOf(h)).toEqual([]);
  });
});
