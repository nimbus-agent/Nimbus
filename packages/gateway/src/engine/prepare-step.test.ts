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
import { IAC_LIMITS } from "../connectors/connector-writes/iac-limits.ts";
import { BEFORE_STATE_MAX_FIELDS, type BoundWrite } from "../connectors/connector-writes/types.ts";
import type { SettleContext, SettledWrite } from "./bound-write-capabilities.ts";
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

describe("boundInputRefusal: the row's input hook (D1c)", () => {
  test("the hook's reason is the refusal, after the cap, and before any read", () => {
    const calls: unknown[] = [];
    const b = synthBound({
      inputRefusal: (input) => {
        calls.push(input);
        return "hook: too many files";
      },
    });
    expect(boundInputRefusal(b, ACTION)).toBe("hook: too many files");
    expect(calls).toEqual([{ dir: "prod" }]);
  });

  test("the hook runs last: a caller-bound field or an over-cap input is refused first", () => {
    let ran = false;
    const b = synthBound({
      maxInputBytes: 5,
      inputRefusal: () => {
        ran = true;
        return "hook";
      },
    });
    expect(boundInputRefusal(b, ACTION)).toBe(PREPARE_REFUSALS.inputTooLarge);
    const forged: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { input: { dir: "p", planDigest: "x" } },
    };
    expect(boundInputRefusal(b, forged)).toBe(PREPARE_REFUSALS.callerBound);
    expect(ran).toBe(false);
  });

  test("a hook that returns undefined passes; one that throws or returns a non-string refuses (fail closed)", () => {
    expect(
      boundInputRefusal(synthBound({ inputRefusal: () => undefined }), ACTION),
    ).toBeUndefined();
    const throwing = synthBound({
      inputRefusal: () => {
        throw new Error("secret detail");
      },
    });
    expect(boundInputRefusal(throwing, ACTION)).toBe(PREPARE_REFUSALS.notObject);
    const odd = synthBound({ inputRefusal: () => 5 as unknown as string });
    expect(boundInputRefusal(odd, ACTION)).toBe(PREPARE_REFUSALS.notObject);
  });

  test("a row with no hook behaves as before", () => {
    expect(boundInputRefusal(BOUND, ACTION)).toBeUndefined();
  });
});

describe("runPrepareStep: the diff (D1c, D42(g))", () => {
  const options = { prepareToolIds: SYNTH_PREPARE_IDS };
  const FILES_ACTION: PlannedAction = {
    type: "iac.terraform.apply",
    payload: {
      mcpToolId: "iac_synth_apply",
      input: {
        dir: "prod",
        files: [
          { path: "a.txt", content: "A2\n" },
          { path: "b.txt", content: "fresh\n" },
        ],
      },
    },
  };
  const reply = (over: Record<string, unknown> = {}) => ({
    summary: "2 files",
    digest: "sha256:abc123",
    files: [
      { path: "a.txt", exists: true, oldContent: "A1\n" },
      { path: "b.txt", exists: false },
    ],
    ...over,
  });
  type Picked = Readonly<Record<string, unknown>>;
  const pair = (picked: Picked, r: unknown) => {
    const inFiles = picked["files"] as Array<{ path: string; content: string }>;
    const got = (r as { files?: Array<{ path: string; exists: boolean; oldContent?: string }> })
      .files;
    if (got === undefined || got.length !== inFiles.length) return undefined;
    const out: Array<{ path: string; oldContent: string | undefined; newContent: string }> = [];
    for (const [i, f] of inFiles.entries()) {
      const e = got[i];
      if (e === undefined || e.path !== f.path) return undefined;
      out.push({
        path: f.path,
        oldContent: e.exists ? e.oldContent : undefined,
        newContent: f.content,
      });
    }
    return out;
  };
  const withDiff = (over: Partial<BoundWrite["prepare"]> = {}) =>
    synthBound({
      argKeys: ["dir", "files"],
      args: (input) => ({ dir: input["dir"], files: input["files"] }),
      diff: { files: pair, maxOldBytes: 1000, maxDiffBytes: 5000 },
      maxReplyBytes: 100_000,
      ...over,
    });

  test("the diff is computed from the caller's text and the reply's old text", async () => {
    const { ops } = opsOf({}, reply());
    const prepared = await runPrepareStep(ops, ROW, withDiff(), FILES_ACTION, options);
    expect(prepared.diff?.files.map((f) => [f.path, f.state])).toEqual([
      ["a.txt", "modified"],
      ["b.txt", "new"],
    ]);
    expect(prepared.diff?.additions).toBe(2);
    expect(prepared.diff?.deletions).toBe(1);
  });

  test("nothing the reply says about the change is shown: forged diff, preview and hunks are never read", async () => {
    const forged = reply({
      diff: "+++ FORGED-DIFF",
      preview: "FORGED-PREVIEW",
      hunks: [{ lines: [{ op: "+", text: "FORGED-HUNK" }] }],
      patch: "FORGED-PATCH",
    });
    const { ops } = opsOf({}, forged);
    const prepared = await runPrepareStep(ops, ROW, withDiff(), FILES_ACTION, options);
    const shown = JSON.stringify(prepared.diff);
    for (const word of ["FORGED-DIFF", "FORGED-PREVIEW", "FORGED-HUNK", "FORGED-PATCH"]) {
      expect(shown).not.toContain(word);
    }
    // The plus lines are exactly the caller's new text.
    const plus = prepared.diff?.files.flatMap((f) =>
      f.hunks.flatMap((h) => h.lines.filter((l) => l.op === "+").map((l) => l.text)),
    );
    expect(plus).toEqual(["A2", "fresh"]);
  });

  test("a reply the row cannot pair refuses as unshowable (and a throwing pairer too)", async () => {
    const bad = [
      reply({ files: [] }),
      reply({
        files: [
          { path: "zzz", exists: false },
          { path: "b.txt", exists: false },
        ],
      }),
    ];
    for (const r of bad) {
      const { ops } = opsOf({}, r);
      expect(await refusalOf(runPrepareStep(ops, ROW, withDiff(), FILES_ACTION, options))).toBe(
        PREPARE_REFUSALS.unshowable,
      );
    }
    const throwing = withDiff({
      diff: {
        files: () => {
          throw new Error("boom");
        },
        maxOldBytes: 1000,
        maxDiffBytes: 5000,
      },
    });
    expect(
      await refusalOf(runPrepareStep(opsOf({}, reply()).ops, ROW, throwing, FILES_ACTION, options)),
    ).toBe(PREPARE_REFUSALS.unshowable);
    const empty = withDiff({ diff: { files: () => [], maxOldBytes: 1000, maxDiffBytes: 5000 } });
    expect(
      await refusalOf(runPrepareStep(opsOf({}, reply()).ops, ROW, empty, FILES_ACTION, options)),
    ).toBe(PREPARE_REFUSALS.unshowable);
  });

  test("old text over the cap refuses as a too-large reply; at the cap it passes", async () => {
    const r = reply({
      files: [
        { path: "a.txt", exists: true, oldContent: "x".repeat(10) },
        { path: "b.txt", exists: false },
      ],
    });
    const at = withDiff({ diff: { files: pair, maxOldBytes: 10, maxDiffBytes: 5000 } });
    await runPrepareStep(opsOf({}, r).ops, ROW, at, FILES_ACTION, options);
    const over = withDiff({ diff: { files: pair, maxOldBytes: 9, maxDiffBytes: 5000 } });
    expect(
      await refusalOf(runPrepareStep(opsOf({}, r).ops, ROW, over, FILES_ACTION, options)),
    ).toBe(PREPARE_REFUSALS.replyTooLarge);
    // Multi-byte text is counted in UTF-8.
    const wide = reply({
      files: [
        { path: "a.txt", exists: true, oldContent: "€€€€" },
        { path: "b.txt", exists: false },
      ],
    });
    expect(
      await refusalOf(runPrepareStep(opsOf({}, wide).ops, ROW, over, FILES_ACTION, options)),
    ).toBe(PREPARE_REFUSALS.replyTooLarge);
  });

  test("a rendered diff over the cap refuses as diffTooLarge", async () => {
    const small = withDiff({ diff: { files: pair, maxOldBytes: 1000, maxDiffBytes: 40 } });
    expect(
      await refusalOf(runPrepareStep(opsOf({}, reply()).ops, ROW, small, FILES_ACTION, options)),
    ).toBe(PREPARE_REFUSALS.diffTooLarge);
  });

  test("a change in which every file is unchanged refuses as nothingToCommit", async () => {
    const action: PlannedAction = {
      type: "iac.terraform.apply",
      payload: { input: { dir: "prod", files: [{ path: "a.txt", content: "A1\n" }] } },
    };
    const r = reply({ files: [{ path: "a.txt", exists: true, oldContent: "A1\n" }] });
    expect(
      await refusalOf(runPrepareStep(opsOf({}, r).ops, ROW, withDiff(), action, options)),
    ).toBe(PREPARE_REFUSALS.nothingToCommit);
  });

  test("a row with no diff returns none", async () => {
    const { ops } = opsOf();
    expect((await runPrepareStep(ops, ROW, BOUND, ACTION, options)).diff).toBeUndefined();
  });

  test("the new reasons are fixed text", () => {
    for (const k of ["diffTooLarge", "nothingToCommit"] as const) {
      expect(PREPARE_REFUSALS[k]).toMatch(/^prepare: /);
    }
  });
});

describe("PREPARE_REFUSALS (D2)", () => {
  test("carries the nothingToApply and settleFailed reasons, frozen, all distinct", () => {
    expect(PREPARE_REFUSALS.nothingToApply).toBe("prepare: the plan would change nothing");
    expect(PREPARE_REFUSALS.settleFailed).toBe("prepare: the plan could not be fixed and shown");
    expect(Object.isFrozen(PREPARE_REFUSALS)).toBe(true);
    const all = Object.values(PREPARE_REFUSALS);
    expect(new Set(all).size).toBe(all.length);
  });

  test("no reason is built from input: every one is a fixed `prepare: ` sentence without a placeholder", () => {
    for (const reason of Object.values(PREPARE_REFUSALS)) {
      expect(reason.startsWith("prepare: ")).toBe(true);
      expect(reason).not.toMatch(/[{}$]/u);
    }
  });
});

describe("runPrepareStep: the settle step (D2, I54)", () => {
  const SHOW = "synth_show";
  const IDS: ReadonlySet<string> = new Set([SYNTH_PREPARE_TOOL, SHOW]);
  const bindOf = (field: string) => ({
    field,
    from: (r: unknown) => (r as Record<string, string>)[field],
  });
  const cfnBound = (): BoundWrite => ({
    ...synthBound({ settle: "iac-cfn" }),
    binds: [bindOf("changeSetId")],
  });
  const tfBound = (): BoundWrite => ({
    ...synthBound({ settle: "iac-terraform", settleTool: SHOW }),
    binds: [bindOf("planFile"), bindOf("planSha256")],
  });
  const PLAN = {
    lines: ["Deletes: 0"],
    text: "Deletes: 0",
    bytes: 10,
    sha256: "a".repeat(64),
  } as const;
  const settled = (over: Partial<SettledWrite> = {}): SettledWrite => ({
    values: { changeSetId: "arn-settled" },
    fields: [{ label: "Stack", value: "prod" }],
    plan: PLAN,
    cleanup: async () => undefined,
    ...over,
  });

  test("a settle row with no settle capability is refused before any read or gate", async () => {
    const { ops, calls } = opsOf();
    const reason = await refusalOf(
      runPrepareStep(ops, ROW, cfnBound(), ACTION, { prepareToolIds: IDS }),
    );
    expect(reason).toBe(PREPARE_REFUSALS.capabilityMissing);
    expect(calls.log).toEqual([]);
  });

  test("a settle tool that is not a declared prepare tool is refused before any read", async () => {
    const { ops, calls } = opsOf({ settle: async () => settled() });
    const reason = await refusalOf(
      runPrepareStep(ops, ROW, tfBound(), ACTION, { prepareToolIds: SYNTH_PREPARE_IDS }),
    );
    expect(reason).toBe(PREPARE_REFUSALS.toolNotAllowed);
    expect(calls.log).toEqual([]);
  });

  test("the settler values and facts are bound and shown, never the prepare reply", async () => {
    const seen: Array<{ id: string; ctx: SettleContext }> = [];
    let cleaned = 0;
    const { ops } = opsOf(
      {
        settle: async (id, ctx) => {
          seen.push({ id, ctx });
          return settled({
            // A key the row does not bind is dropped, not injected.
            values: { changeSetId: "arn-settled", extra: "x" },
            cleanup: async () => {
              cleaned += 1;
            },
          });
        },
      },
      { summary: "forged", digest: "d", changeSetId: "arn-forged" },
    );
    const out = await runPrepareStep(ops, ROW, cfnBound(), ACTION, { prepareToolIds: IDS });
    expect(out.values).toEqual({ changeSetId: "arn-settled" });
    expect(out.fields).toEqual([{ label: "Stack", value: "prod" }]);
    expect(out.plan).toEqual(PLAN);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(ROW.toolId);
    expect(seen[0]?.ctx.settle).toBe("iac-cfn");
    expect(seen[0]?.ctx.input).toEqual({ dir: "prod" });
    expect(seen[0]?.ctx.reply).toMatchObject({ changeSetId: "arn-forged" });
    // A CloudFormation settle has no show tool.
    expect(seen[0]?.ctx.showPlan).toBeUndefined();
    expect(cleaned).toBe(0);
    await out.cleanup?.();
    expect(cleaned).toBe(1);
  });

  test("a settled result without a plan has none", async () => {
    const { plan: _plan, ...noPlan } = settled();
    const { ops } = opsOf({ settle: async () => noPlan });
    const out = await runPrepareStep(ops, ROW, cfnBound(), ACTION, { prepareToolIds: IDS });
    expect(out.plan).toBeUndefined();
  });

  test("settled facts are sanitised and capped, the overflow counted with the settler own", async () => {
    const many = Array.from({ length: BEFORE_STATE_MAX_FIELDS + 2 }, (_, i) => ({
      label: `L${String(i)}`,
      value: i === 0 ? "a‮b" : "v",
    }));
    const { ops } = opsOf({ settle: async () => settled({ fields: many, notShown: 3 }) });
    const out = await runPrepareStep(ops, ROW, cfnBound(), ACTION, { prepareToolIds: IDS });
    expect(out.fields).toHaveLength(BEFORE_STATE_MAX_FIELDS);
    expect(out.fields[0]?.value).not.toContain("‮");
    expect(out.notShown).toBe(5);
  });

  test("a settler refusal passes through; any other failure is the fixed settleFailed", async () => {
    const refused = opsOf({
      settle: async () => {
        throw new PrepareRefusedError(PREPARE_REFUSALS.nothingToApply);
      },
    });
    expect(
      await refusalOf(
        runPrepareStep(refused.ops, ROW, cfnBound(), ACTION, { prepareToolIds: IDS }),
      ),
    ).toBe(PREPARE_REFUSALS.nothingToApply);
    const boom = opsOf({
      settle: async () => {
        throw new Error("/secret/path leaked");
      },
    });
    expect(
      await refusalOf(runPrepareStep(boom.ops, ROW, cfnBound(), ACTION, { prepareToolIds: IDS })),
    ).toBe(PREPARE_REFUSALS.settleFailed);
  });

  test("a settled result missing a bound value, or showing nothing, is refused after its cleanup", async () => {
    let cleaned = 0;
    const cleanup = async () => {
      cleaned += 1;
    };
    for (const bad of [{ values: {} }, { values: { changeSetId: "" } }]) {
      const { ops } = opsOf({ settle: async () => settled({ ...bad, cleanup }) });
      expect(
        await refusalOf(runPrepareStep(ops, ROW, cfnBound(), ACTION, { prepareToolIds: IDS })),
      ).toBe(PREPARE_REFUSALS.unbound);
    }
    const { ops } = opsOf({ settle: async () => settled({ fields: [], cleanup }) });
    expect(
      await refusalOf(runPrepareStep(ops, ROW, cfnBound(), ACTION, { prepareToolIds: IDS })),
    ).toBe(PREPARE_REFUSALS.unshowable);
    expect(cleaned).toBe(3);
  });

  test("the settler show read is one more prepare read: own gate, own dispatch, the show tool, the show budget", async () => {
    const clock = fakeTimers();
    let shown: unknown;
    const { ops, calls } = opsOf({
      settle: async (_id, ctx) => {
        shown = await ctx.showPlan?.({ workingDirectory: "/w", planFile: "/p/plan.tfplan" });
        return settled({ values: { planFile: "/p/plan.tfplan", planSha256: "h" } });
      },
    });
    const out = await runPrepareStep(ops, ROW, tfBound(), ACTION, {
      prepareToolIds: IDS,
      timers: clock.timers,
    });
    expect(out.values).toEqual({ planFile: "/p/plan.tfplan", planSha256: "h" });
    expect(shown).toEqual(SYNTH_REPLY);
    expect(calls.gated.map((a) => a.type)).toEqual(["iac.write.prepare", "iac.write.prepare"]);
    expect(calls.gated[1]?.payload).toEqual({
      mcpToolId: "iac_synth_show",
      input: { workingDirectory: "/w", planFile: "/p/plan.tfplan" },
    });
    expect(clock.delays).toEqual([1000, IAC_LIMITS.showBudgetMs]);
  });

  test("a show read the gate refuses surfaces as the fixed refused reason", async () => {
    let seen = "";
    const { ops } = opsOf({
      gate: async (a) =>
        String(a.payload?.["mcpToolId"]).endsWith(SHOW)
          ? { status: "rejected", reason: "policy requires approval" }
          : "proceed",
      settle: async (_id, ctx) => {
        try {
          await ctx.showPlan?.({ workingDirectory: "/w", planFile: "/p" });
        } catch (e) {
          seen = (e as PrepareRefusedError).reason;
          throw e;
        }
        return settled();
      },
    });
    expect(
      await refusalOf(runPrepareStep(ops, ROW, tfBound(), ACTION, { prepareToolIds: IDS })),
    ).toBe(PREPARE_REFUSALS.refused);
    expect(seen).toBe(PREPARE_REFUSALS.refused);
  });
});
