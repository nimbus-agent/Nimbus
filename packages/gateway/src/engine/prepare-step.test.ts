// packages/gateway/src/engine/prepare-step.test.ts
// Phase 9.7 D0b: the prepare step of a bound write (I54). Fake ops, fake timers, synthetic rows:
// no production row is bound yet.
import { describe, expect, test } from "bun:test";
import {
  SYNTH_PREPARE_IDS,
  SYNTH_PREPARE_TOOL,
  SYNTH_REPLY,
  synthBound,
  synthBoundRow,
} from "../connectors/connector-writes/bound-fixtures.test-helpers.ts";
import { BEFORE_STATE_MAX_FIELDS } from "../connectors/connector-writes/types.ts";
import {
  boundInputRefusal,
  injectBoundFields,
  isPrepareActionType,
  PREPARE_REFUSALS,
  type PrepareOps,
  PrepareRefusedError,
  runPrepareStep,
} from "./prepare-step.ts";
import type { PlannedAction } from "./types.ts";

const ROW = synthBoundRow();
const BOUND = synthBound();
const ACTION: PlannedAction = {
  type: "iac.terraform.apply",
  payload: { mcpToolId: "iac_synth_apply", input: { dir: "prod" } },
};

interface FakeTimers {
  readonly timers: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
  fire(): void;
  readonly cleared: unknown[];
  readonly delays: number[];
}

function fakeTimers(): FakeTimers {
  let pending: (() => void) | undefined;
  const cleared: unknown[] = [];
  const delays: number[] = [];
  return {
    timers: {
      set: (fn, ms) => {
        pending = fn;
        delays.push(ms);
        return "h1";
      },
      clear: (h) => cleared.push(h),
    },
    fire: () => pending?.(),
    cleared,
    delays,
  };
}

interface Calls {
  readonly log: string[];
  readonly gated: PlannedAction[];
  readonly dispatched: PlannedAction[];
}

function opsOf(
  over: Partial<PrepareOps> = {},
  reply: unknown = SYNTH_REPLY,
): { ops: PrepareOps; calls: Calls } {
  const calls: Calls = { log: [], gated: [], dispatched: [] };
  const ops: PrepareOps = {
    gate: async (a) => {
      calls.log.push("gate");
      calls.gated.push(a);
      return "proceed";
    },
    dispatch: async (a) => {
      calls.log.push("dispatch");
      calls.dispatched.push(a);
      return reply;
    },
    ...over,
  };
  return { ops, calls };
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PrepareRefusedError) return e.reason;
    throw e;
  }
  throw new Error("expected a PrepareRefusedError");
}

describe("isPrepareActionType", () => {
  test("is the one suffix", () => {
    expect(isPrepareActionType("iac.write.prepare")).toBe(true);
    expect(isPrepareActionType("iac.terraform.apply")).toBe(false);
    expect(isPrepareActionType("iac.before.read")).toBe(false);
  });
});

describe("boundInputRefusal", () => {
  test("a clean object input passes", () => {
    expect(boundInputRefusal(BOUND, ACTION)).toBeUndefined();
  });

  test("a flat payload input passes too", () => {
    expect(
      boundInputRefusal(BOUND, { type: "iac.terraform.apply", payload: { dir: "p" } }),
    ).toBeUndefined();
  });

  test("no payload at all: the input is {} and passes", () => {
    expect(boundInputRefusal(BOUND, { type: "iac.terraform.apply" })).toBeUndefined();
  });

  test("a non-object input is refused", () => {
    const a: PlannedAction = { type: "iac.terraform.apply", payload: { input: "x" } };
    expect(boundInputRefusal(BOUND, a)).toBe(PREPARE_REFUSALS.notObject);
  });

  test("a bound field at the payload root (beside input) is refused", () => {
    const a: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { planDigest: "forged", input: { dir: "prod" } },
    };
    expect(boundInputRefusal(BOUND, a)).toBe(PREPARE_REFUSALS.callerBound);
  });

  test("a bound field inside payload.input is refused", () => {
    const a: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { input: { dir: "prod", planDigest: "forged" } },
    };
    expect(boundInputRefusal(BOUND, a)).toBe(PREPARE_REFUSALS.callerBound);
  });

  test("a flat payload carrying a bound field is refused", () => {
    const a: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { dir: "p", planDigest: "x" },
    };
    expect(boundInputRefusal(BOUND, a)).toBe(PREPARE_REFUSALS.callerBound);
  });

  test("a bound field that is falsy or empty still counts (own key, not truthiness)", () => {
    const a: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { input: { planDigest: "" } },
    };
    expect(boundInputRefusal(BOUND, a)).toBe(PREPARE_REFUSALS.callerBound);
  });

  test("an own __proto__ key named as a bound field counts", () => {
    const bound = {
      ...BOUND,
      binds: [{ field: "__proto__", from: () => "x" }],
    };
    const payload = JSON.parse('{"input":{"dir":"p","__proto__":"x"}}') as Record<string, unknown>;
    expect(boundInputRefusal(bound, { type: "iac.terraform.apply", payload })).toBe(
      PREPARE_REFUSALS.callerBound,
    );
  });

  test("an input over the row's cap is refused; at the cap it passes", () => {
    const small = synthBound({ maxInputBytes: JSON.stringify({ dir: "prod" }).length });
    expect(boundInputRefusal(small, ACTION)).toBeUndefined();
    const tiny = synthBound({ maxInputBytes: 5 });
    expect(boundInputRefusal(tiny, ACTION)).toBe(PREPARE_REFUSALS.inputTooLarge);
  });

  test("an input that cannot be serialised is over every cap", () => {
    const input: Record<string, unknown> = { dir: "p" };
    input["self"] = input;
    const a: PlannedAction = { type: "iac.terraform.apply", payload: { input } };
    expect(boundInputRefusal(BOUND, a)).toBe(PREPARE_REFUSALS.inputTooLarge);
  });
});

describe("injectBoundFields", () => {
  const values = { planDigest: "sha256:abc123" };

  test("nested: the value lands in payload.input; routing keys survive; the original is untouched", () => {
    const out = injectBoundFields(ACTION, BOUND.binds, values);
    expect(out.payload).toEqual({
      mcpToolId: "iac_synth_apply",
      input: { dir: "prod", planDigest: "sha256:abc123" },
    });
    expect(ACTION.payload).toEqual({ mcpToolId: "iac_synth_apply", input: { dir: "prod" } });
  });

  test("flat: the value lands at the payload root", () => {
    const out = injectBoundFields({ type: "t", payload: { dir: "prod" } }, BOUND.binds, values);
    expect(out.payload).toEqual({ dir: "prod", planDigest: "sha256:abc123" });
  });

  test("no payload: the value lands in a fresh flat payload", () => {
    expect(injectBoundFields({ type: "t" }, BOUND.binds, values).payload).toEqual(values);
  });

  test("a bound key at BOTH levels is stripped and replaced by the gateway's value", () => {
    const a: PlannedAction = {
      type: "t",
      payload: { planDigest: "forged-root", input: { dir: "p", planDigest: "forged-in" } },
    };
    const out = injectBoundFields(a, BOUND.binds, values);
    expect(out.payload).toEqual({ input: { dir: "p", planDigest: "sha256:abc123" } });
  });

  test("a non-object input is not treated as the tool input: the flat shape is used", () => {
    const out = injectBoundFields({ type: "t", payload: { input: "x" } }, BOUND.binds, values);
    expect(out.payload).toEqual({ input: "x", planDigest: "sha256:abc123" });
  });

  test("a value the step did not produce throws", () => {
    expect(() => injectBoundFields(ACTION, BOUND.binds, {})).toThrow("prepare step");
  });

  test("an own __proto__ key is data, never a prototype", () => {
    const payload = JSON.parse('{"input":{"dir":"p","__proto__":{"polluted":true}}}') as Record<
      string,
      unknown
    >;
    const bound = { ...BOUND, binds: [{ field: "__proto__", from: () => "x" }] };
    const out = injectBoundFields({ type: "t", payload }, bound.binds, { ["__proto__"]: "x" });
    const input = (out.payload as { input: Record<string, unknown> }).input;
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect(Object.hasOwn(input, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("runPrepareStep", () => {
  const options = { prepareToolIds: SYNTH_PREPARE_IDS };

  test("ok: gates the prepare type, then dispatches it; returns the values and the facts", async () => {
    const { ops, calls } = opsOf();
    const prepared = await runPrepareStep(ops, ROW, BOUND, ACTION, options);
    expect(calls.log).toEqual(["gate", "dispatch"]);
    expect(calls.gated[0]).toEqual({
      type: "iac.write.prepare",
      payload: { mcpToolId: `iac_${SYNTH_PREPARE_TOOL}`, input: { dir: "prod" } },
    });
    expect(calls.dispatched[0]).toBe(calls.gated[0] as PlannedAction);
    expect(prepared.values).toEqual({ planDigest: "sha256:abc123" });
    expect(prepared.fields).toEqual([{ label: "Plan", value: "3 to add, 0 to change" }]);
    expect(prepared.notShown).toBeUndefined();
    expect(prepared.binds).toBe(BOUND.binds);
  });

  test("the prepare tool gets only the row's declared argKeys", async () => {
    const { ops, calls } = opsOf();
    const a: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { input: { dir: "prod", extra: "never-sent" } },
    };
    await runPrepareStep(ops, ROW, BOUND, a, options);
    expect(calls.gated[0]?.payload?.["input"]).toEqual({ dir: "prod" });
  });

  test("a tool the table does not declare is refused before anything runs", async () => {
    const { ops, calls } = opsOf();
    const reason = await refusalOf(
      runPrepareStep(ops, ROW, BOUND, ACTION, { prepareToolIds: new Set() }),
    );
    expect(reason).toBe(PREPARE_REFUSALS.toolNotAllowed);
    expect(calls.log).toEqual([]);
  });

  test("a tool missing from the listing is refused before anything runs", async () => {
    const { ops, calls } = opsOf();
    const reason = await refusalOf(
      runPrepareStep(ops, ROW, BOUND, ACTION, { ...options, toolUnlisted: true }),
    );
    expect(reason).toBe(PREPARE_REFUSALS.toolUnavailable);
    expect(calls.log).toEqual([]);
  });

  test("args() that throws, or returns a non-object, refuses", async () => {
    const throwing = synthBound({
      args: () => {
        throw new Error("boom secret");
      },
    });
    const bad = synthBound({ args: () => "nope" as unknown as Record<string, unknown> });
    for (const b of [throwing, bad]) {
      const { ops, calls } = opsOf();
      expect(await refusalOf(runPrepareStep(ops, ROW, b, ACTION, options))).toBe(
        PREPARE_REFUSALS.argsFailed,
      );
      expect(calls.log).toEqual([]);
    }
  });

  test("a gate refusal refuses the write and dispatches nothing", async () => {
    const { ops, calls } = opsOf({
      gate: async () => ({ status: "rejected", reason: "policy requires approval" }),
    });
    expect(await refusalOf(runPrepareStep(ops, ROW, BOUND, ACTION, options))).toBe(
      PREPARE_REFUSALS.refused,
    );
    expect(calls.dispatched).toEqual([]);
  });

  test("a dispatch failure is the fixed 'failed' reason, never the error text", async () => {
    const { ops } = opsOf({
      dispatch: async () => {
        throw new Error("secret token leaked in message");
      },
    });
    const reason = await refusalOf(runPrepareStep(ops, ROW, BOUND, ACTION, options));
    expect(reason).toBe(PREPARE_REFUSALS.failed);
    expect(reason).not.toContain("secret");
  });

  test("a non-Error throw is 'failed' too", async () => {
    const { ops } = opsOf({
      dispatch: async () => {
        throw "plain string";
      },
    });
    expect(await refusalOf(runPrepareStep(ops, ROW, BOUND, ACTION, options))).toBe(
      PREPARE_REFUSALS.failed,
    );
  });

  test("'Tool not found' is 'tool unavailable'", async () => {
    const { ops } = opsOf({
      dispatch: async () => {
        throw new Error("Tool not found");
      },
    });
    expect(await refusalOf(runPrepareStep(ops, ROW, BOUND, ACTION, options))).toBe(
      PREPARE_REFUSALS.toolUnavailable,
    );
  });

  test("a timeout refuses, the late reply is dropped, and the timer is set to the row's budget and cleared", async () => {
    const t = fakeTimers();
    let release: (v: unknown) => void = () => undefined;
    const { ops } = opsOf({
      dispatch: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const run = runPrepareStep(ops, ROW, BOUND, ACTION, { ...options, timers: t.timers });
    await Promise.resolve();
    await Promise.resolve();
    t.fire();
    expect(await refusalOf(run)).toBe(PREPARE_REFUSALS.timeout);
    release(SYNTH_REPLY);
    expect(t.delays).toEqual([1000]);
    expect(t.cleared).toEqual(["h1"]);
  });

  test("a late failure after the timeout is handled (no unhandled rejection)", async () => {
    const t = fakeTimers();
    let fail: (e: unknown) => void = () => undefined;
    const { ops } = opsOf({
      dispatch: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });
    const run = runPrepareStep(ops, ROW, BOUND, ACTION, { ...options, timers: t.timers });
    await Promise.resolve();
    await Promise.resolve();
    t.fire();
    const refusal = await refusalOf(run);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      fail(new Error("late"));
      // A rejection nobody handles is reported once the microtask queue drains and the loop turns.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    // The late failure changes nothing about the answer already given.
    expect(refusal).toBe(PREPARE_REFUSALS.timeout);
    expect(await refusalOf(run)).toBe(PREPARE_REFUSALS.timeout);
  });

  test("a gate that resolves after the budget ran out never dispatches", async () => {
    const t = fakeTimers();
    let open: (v: "proceed") => void = () => undefined;
    const { ops, calls } = opsOf({
      gate: () =>
        new Promise<"proceed">((resolve) => {
          open = resolve;
        }),
    });
    const run = runPrepareStep(ops, ROW, BOUND, ACTION, { ...options, timers: t.timers });
    await Promise.resolve();
    t.fire();
    expect(await refusalOf(run)).toBe(PREPARE_REFUSALS.timeout);
    open("proceed");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.dispatched).toEqual([]);
  });

  test("the real timers are used when none are injected", async () => {
    const { ops } = opsOf();
    const prepared = await runPrepareStep(ops, ROW, BOUND, ACTION, options);
    expect(prepared.values["planDigest"]).toBe("sha256:abc123");
  });

  test("a reply of undefined has no bound value and refuses", async () => {
    const { ops } = opsOf({ dispatch: async () => undefined });
    expect(await refusalOf(runPrepareStep(ops, ROW, BOUND, ACTION, options))).toBe(
      PREPARE_REFUSALS.unbound,
    );
  });

  test("a reply over the cap refuses; one that cannot be serialised does too", async () => {
    const big = { ...SYNTH_REPLY, pad: "x".repeat(2000) };
    const { ops } = opsOf({}, big);
    expect(await refusalOf(runPrepareStep(ops, ROW, BOUND, ACTION, options))).toBe(
      PREPARE_REFUSALS.replyTooLarge,
    );
    const circular: Record<string, unknown> = { ...SYNTH_REPLY };
    circular["self"] = circular;
    const { ops: ops2 } = opsOf({}, circular);
    expect(await refusalOf(runPrepareStep(ops2, ROW, BOUND, ACTION, options))).toBe(
      PREPARE_REFUSALS.replyTooLarge,
    );
  });

  test("a reply with no value for a bound field refuses (undefined, empty, non-string, throw)", async () => {
    const replies: unknown[] = [
      { summary: "s" },
      { summary: "s", digest: "" },
      { summary: "s", digest: 5 },
    ];
    for (const reply of replies) {
      const { ops } = opsOf({}, reply);
      expect(await refusalOf(runPrepareStep(ops, ROW, BOUND, ACTION, options))).toBe(
        PREPARE_REFUSALS.unbound,
      );
    }
    const throwing = {
      ...BOUND,
      binds: [
        {
          field: "planDigest",
          from: () => {
            throw new Error("x");
          },
        },
      ],
    };
    const { ops } = opsOf();
    expect(await refusalOf(runPrepareStep(ops, ROW, throwing, ACTION, options))).toBe(
      PREPARE_REFUSALS.unbound,
    );
  });

  test("a reply the row cannot show refuses (select throws, non-array, empty, bad entries)", async () => {
    const selects: Array<(r: unknown) => never | unknown> = [
      () => {
        throw new Error("x");
      },
      () => "nope",
      // I54: an empty selection would reach approval showing no prepared fact.
      () => [],
      () => [null],
      () => [{ label: 1, value: "v" }],
      () => [{ label: "l", value: 2 }],
    ];
    for (const select of selects) {
      const b = synthBound({ select: select as never });
      const { ops } = opsOf();
      expect(await refusalOf(runPrepareStep(ops, ROW, b, ACTION, options))).toBe(
        PREPARE_REFUSALS.unshowable,
      );
    }
  });

  test("shown facts are sanitised and capped, the overflow counted", async () => {
    const many = Array.from({ length: BEFORE_STATE_MAX_FIELDS + 3 }, (_, i) => ({
      label: `l${i}`,
      value: i === 0 ? "a\u001b[31mred" : "v",
    }));
    const b = synthBound({ select: () => many });
    const { ops } = opsOf();
    const prepared = await runPrepareStep(ops, ROW, b, ACTION, options);
    expect(prepared.fields).toHaveLength(BEFORE_STATE_MAX_FIELDS);
    expect(prepared.fields[0]?.value).toBe(String.raw`a\u{001B}[31mred`);
    expect(prepared.notShown).toBe(3);
  });

  test("a refusal error is a PrepareRefusedError carrying its reason", () => {
    const e = new PrepareRefusedError("r");
    expect(e.name).toBe("PrepareRefusedError");
    expect(e.reason).toBe("r");
  });
});
