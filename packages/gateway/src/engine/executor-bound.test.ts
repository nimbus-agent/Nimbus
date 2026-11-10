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
  PREPARE_OUTSIDE_STEP_REASON,
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
      return { approved: o.approve ?? true, answerSource: "human" as const };
    },
    requestConfirmedApproval: async (
      req: ConfirmedApprovalRequest,
    ): Promise<ConfirmedApprovalResult> => {
      log.push("prompt:confirmed");
      confirmed.push(req);
      return {
        approved: o.approve ?? true,
        typed: o.typed ?? CONFIRM_TEXT,
        answerSource: "human" as const,
      };
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

  test("an ordinary (non-bound) write is dispatched as an equal copy of the action", async () => {
    const plain = withPreview(makeRow("plain_apply", "iac.pulumi.up", "write", 3), {
      target: "{dir}",
      summary: "Up {dir}",
      fields: [textField("dir")],
    });
    const h = harness({ row: synthBoundRow(3), extraRows: [plain] });
    const action: PlannedAction = { type: "iac.pulumi.up", payload: { input: { dir: DIR } } };
    await h.exec.execute(action);
    expect(h.dispatched).toEqual([action]);
  });
});

describe("a bound write is never delegated: the local owner sees the prepared facts (I20/I54)", () => {
  function delegationWith(calls: string[]): ExecutorDelegationDep {
    return {
      store: {
        activeDelegateePeer: () => {
          calls.push("store");
          return "peer:bob";
        },
        activeDelegateFor: () => {
          calls.push("store");
          return true;
        },
      },
      isOperatorValid: () => true,
      requestRemote: async () => {
        calls.push("remote");
        return { kind: "answered", peerId: "peer:bob", approved: true };
      },
      requestRemoteConfirmed: async () => {
        calls.push("remote-confirmed");
        return { kind: "answered", peerId: "peer:bob", approved: true, typed: CONFIRM_TEXT };
      },
    };
  }

  for (const wave of [3, 4] as const) {
    test(`wave ${wave}: the delegate stub is never asked; the owner's prompt shows the facts and the write is bound`, async () => {
      const calls: string[] = [];
      const h = harness({ row: synthBoundRow(wave), delegation: delegationWith(calls) });
      const r = await h.exec.execute(NESTED);
      expect(r.status).toBe("ok");
      expect(calls).toEqual([]);
      const owner = wave === 3 ? h.prompts : h.confirmed.map((c) => c.prompt);
      expect(owner).toHaveLength(1);
      expect(owner[0]).toContain("Prepared:");
      expect(inputOf(writesOf(h)[0])["planDigest"]).toBe(DIGEST);
    });
  }

  test("a delegate-eligible ORDINARY write is still delegated (the fallback is scoped to bound rows)", async () => {
    const calls: string[] = [];
    const plain = withPreview(makeRow("plain_apply", "iac.pulumi.up", "write", 3), {
      target: "{dir}",
      summary: "Up {dir}",
      fields: [textField("dir")],
    });
    const h = harness({ extraRows: [plain], delegation: delegationWith(calls) });
    await h.exec.execute({ type: "iac.pulumi.up", payload: { input: { dir: DIR } } });
    expect(calls).toContain("remote");
    expect(h.prompts).toEqual([]);
  });

  test("a failed prepare means nobody is asked, the owner included", async () => {
    const calls: string[] = [];
    const h = harness({
      delegation: delegationWith(calls),
      prepareReply: () => {
        throw new Error("down");
      },
    });
    const r = await h.exec.execute(NESTED);
    rejectedWith(r, PREPARE_REFUSALS.failed);
    expect(calls).toEqual([]);
    expect(h.prompts).toEqual([]);
  });
});

describe("a prepare type is the step's own read, never a caller's (D42(f))", () => {
  const PREPARE_CALL: PlannedAction = {
    type: "iac.write.prepare",
    payload: { mcpToolId: "iac_synth_plan", input: { dir: DIR } },
  };

  for (const door of ["execute", "gate"] as const) {
    test(`${door}(): refused with a fixed reason, audited, ledgered blocked, nothing dispatched`, async () => {
      const h = harness();
      const r =
        door === "execute" ? await h.exec.execute(PREPARE_CALL) : await h.exec.gate(PREPARE_CALL);
      rejectedWith(r as ActionResult, PREPARE_OUTSIDE_STEP_REASON);
      expect(h.dispatched).toEqual([]);
      expect(h.prompts).toEqual([]);
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]?.hitlStatus).toBe("rejected");
      expect(lastAuditJson(h)["hitlRejectReason"]).toBe(PREPARE_OUTSIDE_STEP_REASON);
      expect(h.egress.at(-1)?.resultStatus).toBe("blocked");
    });
  }

  test("a prepare type with no declared tool in the table is refused the same way", async () => {
    const h = harness({ table: { rows: [synthBoundRow(3)], prepareToolIds: new Set() } });
    rejectedWith(await h.exec.execute(PREPARE_CALL), PREPARE_OUTSIDE_STEP_REASON);
    expect(h.dispatched).toEqual([]);
  });

  test("the step's own read still runs (its private scope is the only way in)", async () => {
    const h = harness();
    expect((await h.exec.execute(NESTED)).status).toBe("ok");
    expect(h.dispatched[0]?.type).toBe("iac.write.prepare");
  });
});

describe("the gate fails closed where prepared facts and a preview could part (fix 3)", () => {
  test("prepared facts with no preview to carry them: refused as unshowable before any prompt", async () => {
    // A row the constructors would never build: bound, with its typed preview gone.
    const { preview: _gone, ...rest } = synthBoundRow(3);
    const noPreview: ConnectorWriteRow = rest;
    const h = harness({ row: noPreview });
    const r = await h.exec.execute(NESTED);
    rejectedWith(r, PREPARE_REFUSALS.unshowable);
    expect(h.prompts).toEqual([]);
    expect(writesOf(h)).toEqual([]);
    expect(h.egress.at(-1)?.resultStatus).toBe("blocked");
  });

  test("dispatchBoundPhase throws when a bound row has no prepared values", () => {
    const h = harness();
    const phase = (
      h.exec as unknown as {
        dispatchBoundPhase(a: PlannedAction, scope: { bind: boolean }): PlannedAction;
      }
    ).dispatchBoundPhase.bind(h.exec);
    expect(() => phase(NESTED, { bind: true })).toThrow("without its prepare step");
    // An ordinary action passes through untouched.
    const plain: PlannedAction = { type: "iac.pulumi.up", payload: { dir: DIR } };
    expect(phase(plain, { bind: true })).toBe(plain);
  });
});

describe("the audit row reconciles what was bound without carrying it (fix 4)", () => {
  test("a SHA-256 of the canonical JSON of the injected values is in the write's audit row", async () => {
    const h = harness();
    await h.exec.execute(NESTED);
    const want = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify([["planDigest", DIGEST]]))
      .digest("hex");
    const audit = lastAuditJson(h);
    expect(audit["boundValuesSha256"]).toBe(want);
    expect(h.audits.at(-1)?.actionJson).not.toContain(DIGEST);
  });

  test("the digest is the same whatever order the values were bound in (keys sorted)", async () => {
    const binds = (order: readonly string[]) =>
      order.map((field) => ({ field, from: () => `v-${field}` }));
    const digestFor = async (order: readonly string[]): Promise<unknown> => {
      const h = harness({ row: synthBoundRow(3, { ...synthBound(), binds: binds(order) }) });
      await h.exec.execute(NESTED);
      return lastAuditJson(h)["boundValuesSha256"];
    };
    const want = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify([
          ["alpha", "v-alpha"],
          ["mid", "v-mid"],
          ["zeta", "v-zeta"],
        ]),
      )
      .digest("hex");
    expect(await digestFor(["zeta", "alpha", "mid"])).toBe(want);
    expect(await digestFor(["alpha", "mid", "zeta"])).toBe(want);
  });

  test("the digest orders keys by code unit, so case and integer-like keys are stable", async () => {
    const binds = (order: readonly string[]) =>
      order.map((field) => ({ field, from: () => `v-${field}` }));
    const digestFor = async (order: readonly string[]): Promise<unknown> => {
      const h = harness({ row: synthBoundRow(3, { ...synthBound(), binds: binds(order) }) });
      await h.exec.execute(NESTED);
      return lastAuditJson(h)["boundValuesSha256"];
    };
    // Code-unit order: "10" < "9" < "B" < "a"; localeCompare would put "a" before "B".
    const want = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify([
          ["10", "v-10"],
          ["9", "v-9"],
          ["B", "v-B"],
          ["a", "v-a"],
        ]),
      )
      .digest("hex");
    expect(await digestFor(["a", "B", "9", "10"])).toBe(want);
  });

  test("a declined write still records the digest; an ordinary write records none", async () => {
    const declined = harness({ approve: false });
    await declined.exec.execute(NESTED);
    expect(lastAuditJson(declined)["boundValuesSha256"]).toBeString();
    const plain = withPreview(makeRow("plain_apply", "iac.pulumi.up", "write", 3), {
      target: "{dir}",
      summary: "Up {dir}",
      fields: [textField("dir")],
    });
    const h = harness({ extraRows: [plain] });
    await h.exec.execute({ type: "iac.pulumi.up", payload: { input: { dir: DIR } } });
    expect(lastAuditJson(h)["boundValuesSha256"]).toBeUndefined();
  });
});

describe("execute() works on a private copy of the action (fix 5)", () => {
  test("mutating the caller's object while the prompt is pending changes nothing dispatched", async () => {
    const action: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { mcpToolId: "iac_synth_apply", input: { dir: DIR } },
    };
    const h = harness();
    // Mutate from inside the consent prompt: after the checks and the prepare read, before dispatch.
    const input = (action.payload as { input: Record<string, unknown> }).input;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          input["dir"] = "evil";
          input["planDigest"] = "forged";
          return { approved: true, answerSource: "human" as const };
        },
      },
      { recordAudit: () => undefined },
      {
        dispatch: async (a) => {
          h.dispatched.push(a);
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
    const r = await exec.execute(action);
    expect(r.status).toBe("ok");
    expect(inputOf(writesOf(h)[0])).toEqual({ dir: DIR, planDigest: DIGEST });
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
  const base = harness({ ...o, table: "none" });
  const row = o.row ?? synthBoundRow(3);
  const exec = new ToolExecutor(
    { requestApproval: async () => ({ approved: true, answerSource: "human" as const }) },
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

describe("a bound write with a diff shows it and records its digest (D1c)", () => {
  const FILES_INPUT = {
    dir: DIR,
    files: [
      { path: "a.txt", content: "A2\n" },
      { path: "b.txt", content: "fresh\n" },
    ],
  };
  const DIFF_ACTION: PlannedAction = {
    type: "iac.terraform.apply",
    payload: { mcpToolId: "iac_synth_apply", input: FILES_INPUT },
  };
  const diffReply = () => ({
    ...SYNTH_REPLY,
    files: [
      { path: "a.txt", exists: true, oldContent: "A1\n" },
      { path: "b.txt", exists: false },
    ],
    diff: "FORGED-BY-CONNECTOR",
  });
  function diffRow(): ConnectorWriteRow {
    const base = withPreview(makeRow("synth_apply", "iac.terraform.apply", "write", 3), {
      target: "{dir}",
      summary: "Apply {dir}",
      fields: [textField("dir"), { key: "files", label: "Files", kind: "diff" }],
    });
    const bound = synthBound({
      argKeys: ["dir", "files"],
      args: (input) => ({ dir: input["dir"], files: input["files"] }),
      maxReplyBytes: 100_000,
      maxInputBytes: 100_000,
      diff: {
        maxOldBytes: 1000,
        maxDiffBytes: 5000,
        files: (picked, reply) => {
          const inFiles = picked["files"] as Array<{ path: string; content: string }>;
          const got = (reply as ReturnType<typeof diffReply>).files;
          if (got.length !== inFiles.length) return undefined;
          return inFiles.map((f, i) => ({
            path: f.path,
            oldContent: got[i]?.exists === true ? got[i]?.oldContent : undefined,
            newContent: f.content,
          }));
        },
      },
    });
    return withBound(base, bound, SYNTH_PREPARE_IDS);
  }

  test("the preview carries the gateway's diff, and the prompt text contains it", async () => {
    const h = harness({ row: diffRow(), prepareReply: diffReply });
    const r = await h.exec.execute(DIFF_ACTION);
    expect(r.status).toBe("ok");
    const shown = h.details[0] as { diff?: { files: Array<{ path: string; state: string }> } };
    expect(shown.diff?.files.map((f) => [f.path, f.state])).toEqual([
      ["a.txt", "modified"],
      ["b.txt", "new"],
    ]);
    expect(h.prompts[0]).toContain("=== a.txt (modified)");
    expect(h.prompts[0]).toContain("-A1");
    expect(h.prompts[0]).toContain("+A2");
    expect(h.prompts[0]).toContain("+fresh");
    expect(h.prompts[0]).toContain("End of diff: 2 files, +2 -1");
    expect(h.prompts[0]).not.toContain("FORGED-BY-CONNECTOR");
    // The diff is the last thing in the prompt body.
    expect(h.prompts[0]?.trimEnd().endsWith("End of diff: 2 files, +2 -1")).toBe(true);
  });

  test("the audit row carries diffSha256 of the rendered diff; the diff itself is not stored", async () => {
    const h = harness({ row: diffRow(), prepareReply: diffReply });
    await h.exec.execute(DIFF_ACTION);
    const shown = h.details[0] as { diff?: { sha256: string } };
    const audit = lastAuditJson(h);
    expect(audit["diffSha256"]).toBe(shown.diff?.sha256);
    expect(audit["diffSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h.audits.at(-1)?.actionJson).not.toContain("-A1");
  });

  test("a declined write still records the digest of what was shown", async () => {
    const h = harness({ row: diffRow(), prepareReply: diffReply, approve: false });
    await h.exec.execute(DIFF_ACTION);
    expect(lastAuditJson(h)["diffSha256"]).toBeString();
  });

  test("a row without a diff shows none and records no digest", async () => {
    const h = harness();
    await h.exec.execute(NESTED);
    expect(h.details[0]).not.toHaveProperty("diff");
    expect(h.prompts[0]).not.toContain("End of diff");
    expect(lastAuditJson(h)["diffSha256"]).toBeUndefined();
  });

  test("a diff the step cannot make refuses before any prompt", async () => {
    const h = harness({ row: diffRow(), prepareReply: () => ({ ...diffReply(), files: [] }) });
    const r = await h.exec.execute(DIFF_ACTION);
    expect(r.status).toBe("rejected");
    expect(h.prompts).toEqual([]);
    expect(writesOf(h)).toEqual([]);
  });
});
