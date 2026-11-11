/**
 * The before-state reader (spec § 5.4) on its own and through the real `ToolExecutor`. The rows
 * are SYNTHETIC except the last two blocks, which run B2's real `linear_issue_update` guard and
 * `jira_issue_transition` two-read reader; the production selectors are tested in
 * `before-reader.test.ts`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  KNOWLEDGE_BASE_CHILD_REFUSAL,
  LINEAR_ASSIGNEE_REFUSAL,
} from "../connectors/connector-writes/model-write-refusals.ts";
import {
  type BeforeGuardContext,
  type BeforeStateGuard,
  type BeforeStateReader,
  type ConnectorWriteRow,
  row,
  withBefore,
  withPreview,
} from "../connectors/connector-writes/types.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type LocalBaseline, PolicyGate } from "../policy/policy-gate.ts";
import { signPolicy } from "../policy/policy-signing.ts";
import { PolicyStore } from "../policy/policy-store.ts";
import { isHitlRequiredByPolicy } from "../policy/quorum-override.ts";
import { encodeBase64 } from "../util/base64.ts";
import { generateEd25519Keypair } from "../util/ed25519.ts";
import {
  BEFORE_READ_HITL_REFUSAL,
  BEFORE_STATE_TIMEOUT_MS,
  type BeforeReadOps,
  type BeforeStateRunnerOptions,
  classifyBeforeStateError,
  createBeforeStateRunner,
  isBeforeReadActionType,
  WAVE4_BEFORE_REFUSAL,
} from "./before-state.ts";
import { type ExecutorPolicyDep, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

const REPLY_MARK = "BEFORE-REPLY-MARKER-7f3a";

const READER: BeforeStateReader = {
  tool: "jira_issue_get",
  argKeys: ["issueKey"],
  args: (input) => ({ issueKey: input["issueKey"] }),
  select: (reply) => {
    const r = reply as { summary?: unknown };
    return [{ label: "Summary", value: String(r.summary) }];
  },
};

function rowWith(reader: BeforeStateReader, wave: 2 | 3 | 4 = 2): ConnectorWriteRow {
  return withBefore(
    withPreview(row("jira_issue_update", "jira.issue.update", "mesh", wave), {
      target: "{issueKey}",
      summary: "Update {issueKey}",
      fields: [{ key: "summary", label: "Summary", kind: "text" }],
    }),
    reader,
  );
}

const WRITE: PlannedAction = {
  type: "jira.issue.update",
  origin: "model",
  payload: { mcpToolId: "jira_jira_issue_update", input: { issueKey: "NIM-1", summary: "new" } },
};

/** Timers the test fires by hand; `active` is what is still scheduled. */
function manualTimers() {
  const active = new Map<number, () => void>();
  let next = 1;
  return {
    active,
    fire(): void {
      for (const [h, fn] of [...active]) {
        active.delete(h);
        fn();
      }
    },
    timers: {
      set: (fn: () => void): unknown => {
        const h = next++;
        active.set(h, fn);
        return h;
      },
      clear: (h: unknown): void => {
        active.delete(h as number);
      },
    } satisfies NonNullable<BeforeStateRunnerOptions["timers"]>,
  };
}

function opsReturning(reply: unknown, seen: PlannedAction[] = []): BeforeReadOps {
  return {
    gate: async (a) => {
      seen.push(a);
      return "proceed";
    },
    dispatch: async () => reply,
  };
}

describe("before-state runner", () => {
  test("a before-read type is recognised (the runner's own type is asserted below)", () => {
    expect(isBeforeReadActionType("jira.before.read")).toBe(true);
    expect(isBeforeReadActionType("jira.issue.update")).toBe(false);
    expect(BEFORE_STATE_TIMEOUT_MS).toBe(5000);
  });

  test("reads through the ops with the row's own read key and the argKeys only", async () => {
    const seen: PlannedAction[] = [];
    let argsSaw: unknown;
    const runner = createBeforeStateRunner({
      rows: [
        rowWith({
          ...READER,
          args: (input) => {
            argsSaw = { ...input };
            return { issueKey: input["issueKey"] };
          },
        }),
      ],
    });
    const out = await runner.read(WRITE, opsReturning({ summary: "old" }, seen));
    expect(out).toEqual({ status: "ok", fields: [{ label: "Summary", value: "old" }] });
    expect(seen).toEqual([
      {
        type: "jira.before.read",
        payload: { mcpToolId: "jira_jira_issue_get", input: { issueKey: "NIM-1" } },
      },
    ]);
    // `summary` (a new value the model sent) never reaches args.
    expect(argsSaw).toEqual({ issueKey: "NIM-1" });
  });

  test("no row, no reader, or not a model action: no before-state at all", async () => {
    const runner = createBeforeStateRunner({ rows: [rowWith(READER)] });
    const ops = opsReturning({ summary: "old" });
    expect(await runner.read({ ...WRITE, type: "jira.comment.add" }, ops)).toBeUndefined();
    const { origin: _o, ...notModel } = WRITE;
    expect(await runner.read(notModel, ops)).toBeUndefined();
    const { before: _b, ...noReader } = rowWith(READER);
    const plain = createBeforeStateRunner({ rows: [noReader] });
    expect(await plain.read(WRITE, ops)).toBeUndefined();
  });

  test("readsEveryOrigin (the workflow write step's runner) reads an action with no origin; the door's runner does not", async () => {
    const { origin: _o, ...ownerAction } = WRITE;
    const ops = opsReturning({ summary: "old" });
    const workflow = createBeforeStateRunner({ rows: [rowWith(READER)], readsEveryOrigin: true });
    expect(await workflow.read(ownerAction, ops)).toEqual({
      status: "ok",
      fields: [{ label: "Summary", value: "old" }],
    });
    // A row with no reader is still not read, whatever the origin.
    expect(await workflow.read({ ...ownerAction, type: "jira.comment.add" }, ops)).toBeUndefined();
    const door = createBeforeStateRunner({ rows: [rowWith(READER)] });
    expect(await door.read(ownerAction, ops)).toBeUndefined();
  });

  test("a reader tool the door found unlisted: failed, and no read runs", async () => {
    const seen: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [rowWith(READER)] });
    const out = await runner.read(WRITE, opsReturning({}, seen), { readerUnlisted: true });
    expect(out).toEqual({ status: "unavailable", reason: "failed" });
    expect(seen).toEqual([]);
  });

  test("args or select throwing, args returning undefined, or a malformed select: failed", async () => {
    const cases: BeforeStateReader[] = [
      {
        ...READER,
        args: () => {
          throw new Error("args boom");
        },
      },
      { ...READER, args: () => undefined },
      {
        ...READER,
        select: () => {
          throw new Error("select boom");
        },
      },
      { ...READER, select: () => "nope" as unknown as [] },
      { ...READER, select: () => ["not an object"] as unknown as [] },
      { ...READER, select: () => [{ label: "x", value: 1 as unknown as string }] },
    ];
    for (const reader of cases) {
      const runner = createBeforeStateRunner({ rows: [rowWith(reader)] });
      expect(await runner.read(WRITE, opsReturning({ summary: "old" }))).toEqual({
        status: "unavailable",
        reason: "failed",
      });
    }
  });

  test("a non-object write input: failed, nothing read", async () => {
    const seen: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [rowWith(READER)] });
    const odd: PlannedAction = {
      ...WRITE,
      payload: { mcpToolId: "jira_jira_issue_update", input: 7 },
    };
    expect(await runner.read(odd, opsReturning({}, seen))).toEqual({
      status: "unavailable",
      reason: "failed",
    });
    expect(seen).toEqual([]);
  });

  test("values are sanitised and kept whole; fields past 20 are counted, not shown", async () => {
    const esc = String.fromCodePoint(0x1b);
    const long = "v".repeat(5000);
    const reader: BeforeStateReader = {
      ...READER,
      select: () =>
        Array.from({ length: 23 }, (_, i) => ({
          label: i === 0 ? `L${esc}[31m` : `L${i}`,
          value: i === 0 ? long : `v${i}`,
        })),
    };
    const runner = createBeforeStateRunner({ rows: [rowWith(reader)] });
    const out = await runner.read(WRITE, opsReturning({}));
    if (out?.status !== "ok") throw new Error("expected ok");
    expect(out.fields).toHaveLength(20);
    expect(out.notShown).toBe(3);
    expect(out.fields[0]?.label).toBe(String.raw`L\u{001B}[31m`);
    expect(out.fields[0]?.value).toBe(long);
  });

  test("a gate refusal is 'policy requires approval'", async () => {
    const runner = createBeforeStateRunner({ rows: [rowWith(READER)] });
    const ops: BeforeReadOps = {
      gate: async () => ({ status: "rejected", reason: BEFORE_READ_HITL_REFUSAL }),
      dispatch: async () => {
        throw new Error("must not dispatch");
      },
    };
    expect(await runner.read(WRITE, ops)).toEqual({
      status: "unavailable",
      reason: "policy requires approval",
    });
  });

  test("a dispatch failure maps to a fixed reason, never its text", async () => {
    expect(classifyBeforeStateError(new Error("Tool not found"))).toBe("not configured");
    expect(classifyBeforeStateError(new Error("secret upstream text"))).toBe("failed");
    expect(classifyBeforeStateError("not an error")).toBe("failed");
    for (const [msg, reason] of [
      ["Tool not found", "not configured"],
      ["ECONNRESET token=abc", "failed"],
    ] as const) {
      const runner = createBeforeStateRunner({ rows: [rowWith(READER)] });
      const ops: BeforeReadOps = {
        gate: async () => "proceed",
        dispatch: async () => {
          throw new Error(msg);
        },
      };
      expect(await runner.read(WRITE, ops)).toEqual({ status: "unavailable", reason });
    }
  });

  test("the timer is cleared whichever wins (success and failure)", async () => {
    const t = manualTimers();
    const runner = createBeforeStateRunner({ rows: [rowWith(READER)], timers: t.timers });
    await runner.read(WRITE, opsReturning({ summary: "old" }));
    expect(t.active.size).toBe(0);
    const failing: BeforeReadOps = {
      gate: async () => "proceed",
      dispatch: async () => {
        throw new Error("x");
      },
    };
    await runner.read(WRITE, failing);
    expect(t.active.size).toBe(0);
  });

  test("timeout: the prompt is not held, a late reply is dropped, a late failure is handled", async () => {
    const t = manualTimers();
    const runner = createBeforeStateRunner({ rows: [rowWith(READER)], timers: t.timers });
    let resolveReply: (v: unknown) => void = () => {};
    let rejectReply: (e: unknown) => void = () => {};
    const replies = [
      new Promise<unknown>((res) => {
        resolveReply = res;
      }),
      new Promise<unknown>((_res, rej) => {
        rejectReply = rej;
      }),
    ];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const [i, reply] of replies.entries()) {
        const pending = runner.read(WRITE, {
          gate: async () => "proceed",
          dispatch: () => reply,
        });
        // Let the read reach dispatch, then fire the cap.
        await Bun.sleep(0);
        t.fire();
        expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
        if (i === 0) resolveReply({ summary: REPLY_MARK });
        else rejectReply(new Error("late"));
        await Bun.sleep(0);
      }
      await Bun.sleep(5);
      expect(unhandled).toEqual([]);
      expect(t.active.size).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("with no options the runner previews over the production write table", () => {
    expect(createBeforeStateRunner().rows).toBe(CONNECTOR_WRITE_ROWS);
  });

  test("production defaults: the real timer resolves a fast read with nothing left scheduled", async () => {
    const runner = createBeforeStateRunner({ rows: [rowWith(READER)], timeoutMs: 50 });
    const out = await runner.read(WRITE, opsReturning({ summary: "old" }));
    expect(out?.status).toBe("ok");
    const slow = await runner.read(WRITE, {
      gate: async () => "proceed",
      dispatch: () => new Promise(() => {}),
    });
    expect(slow).toEqual({ status: "unavailable", reason: "timeout" });
  });
});

// ---- through the real executor -------------------------------------------------------------

interface Seen {
  prompts: string[];
  details: Array<Record<string, unknown> | undefined>;
  dispatched: PlannedAction[];
  audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }>;
  egress: EgressEntry[];
}

function executorHarness(opts: {
  rows?: readonly ConnectorWriteRow[];
  withRunner?: boolean;
  policy?: ExecutorPolicyDep;
  readReply?: unknown;
  runner?: BeforeStateRunnerOptions;
}) {
  const seen: Seen = { prompts: [], details: [], dispatched: [], audits: [], egress: [] };
  const consent: ConsentChannel = {
    requestApproval: async (prompt, details) => {
      seen.prompts.push(prompt);
      seen.details.push(details);
      return { approved: true, answerSource: "human" as const };
    },
  };
  const audit: AuditSink = {
    recordAudit: (r) => {
      seen.audits.push({
        actionType: r.actionType,
        hitlStatus: r.hitlStatus,
        actionJson: r.actionJson,
      });
    },
  };
  const connectors: ConnectorDispatcher = {
    dispatch: async (a) => {
      seen.dispatched.push(a);
      return isBeforeReadActionType(a.type)
        ? (opts.readReply ?? { summary: `old ${REPLY_MARK}` })
        : { updated: true };
    },
  };
  const exec = new ToolExecutor(
    consent,
    audit,
    connectors,
    undefined,
    { append: (e) => void seen.egress.push(e) },
    opts.policy ?? NO_POLICY_OVERLAY,
    undefined,
    {
      beforeState:
        opts.withRunner === false
          ? undefined
          : createBeforeStateRunner({ rows: opts.rows ?? [rowWith(READER)], ...opts.runner }),
    },
  );
  return { exec, seen };
}

describe("before-state through the door's ToolExecutor", () => {
  test("the read is gated, audited and ledgered before the prompt, and the preview carries it", async () => {
    const { exec, seen } = executorHarness({});
    const out = await exec.execute(WRITE);
    expect(out).toEqual({ status: "ok", result: { updated: true } });
    expect(seen.dispatched.map((a) => a.type)).toEqual(["jira.before.read", "jira.issue.update"]);
    expect(seen.audits.map((a) => [a.actionType, a.hitlStatus])).toEqual([
      ["jira.before.read", "not_required"],
      ["jira.issue.update", "approved"],
    ]);
    expect(seen.egress.map((e) => [e.destination, e.resultStatus])).toEqual([
      ["jira", "authorized"],
      ["jira", "authorized"],
    ]);
    expect(seen.prompts).toHaveLength(1);
    expect(seen.details[0]?.["before"]).toEqual({
      status: "ok",
      fields: [{ label: "Summary", value: `old ${REPLY_MARK}` }],
    });
  });

  test("the read's reply never reaches the result handed back, the write's audit row or any egress row", async () => {
    const { exec, seen } = executorHarness({});
    const out = await exec.execute(WRITE);
    expect(JSON.stringify(out)).not.toContain(REPLY_MARK);
    for (const a of seen.audits) expect(a.actionJson).not.toContain(REPLY_MARK);
    for (const e of seen.egress) expect(JSON.stringify(e)).not.toContain(REPLY_MARK);
    // The control: the reply DID reach the owner's prompt details.
    expect(JSON.stringify(seen.details[0])).toContain(REPLY_MARK);
  });

  test("without a runner (every other executor): no read, and the prompt has no before", async () => {
    const { exec, seen } = executorHarness({ withRunner: false });
    await exec.execute(WRITE);
    expect(seen.dispatched.map((a) => a.type)).toEqual(["jira.issue.update"]);
    expect(seen.audits).toHaveLength(1);
    expect(seen.details[0]?.["before"]).toBeUndefined();
  });

  test("a HITL action that is not a connector-write row: no preview, no read, the plain prompt", async () => {
    const { exec, seen } = executorHarness({});
    await exec.execute({ type: "egress.prune", payload: {} });
    expect(seen.dispatched.map((a) => a.type)).toEqual(["egress.prune"]);
    expect(seen.prompts).toHaveLength(1);
    expect(seen.details[0]?.["before"]).toBeUndefined();
  });

  test("the door's unlisted-reader option: failed, no read runs", async () => {
    const { exec, seen } = executorHarness({});
    await exec.execute(WRITE, { beforeReaderUnlisted: true });
    expect(seen.dispatched.map((a) => a.type)).toEqual(["jira.issue.update"]);
    expect(seen.details[0]?.["before"]).toEqual({ status: "unavailable", reason: "failed" });
  });

  test("a read that times out shows timeout and the prompt still proceeds", async () => {
    const t = manualTimers();
    const seen: Seen = { prompts: [], details: [], dispatched: [], audits: [], egress: [] };
    const exec = new ToolExecutor(
      {
        requestApproval: async (prompt, details) => {
          seen.prompts.push(prompt);
          seen.details.push(details);
          return { approved: true, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      {
        dispatch: (a) => {
          seen.dispatched.push(a);
          return isBeforeReadActionType(a.type) ? new Promise(() => {}) : Promise.resolve("done");
        },
      },
      undefined,
      { append: () => {} },
      NO_POLICY_OVERLAY,
      undefined,
      { beforeState: createBeforeStateRunner({ rows: [rowWith(READER)], timers: t.timers }) },
    );
    const pending = exec.execute(WRITE);
    await Bun.sleep(0);
    t.fire();
    expect(await pending).toEqual({ status: "ok", result: "done" });
    expect(seen.details[0]?.["before"]).toEqual({ status: "unavailable", reason: "timeout" });
  });
});

describe("a before-state read never raises a prompt (structural refusal in gate())", () => {
  const baseline: LocalBaseline = {
    retentionDays: 7,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    capabilitiesDisabled: new Set(),
  };

  /** A REAL signed org policy whose `[policy.hitl] require` names the read's type. */
  function signedPolicyRequiring(types: readonly string[]): {
    policy: ExecutorPolicyDep;
    db: Database;
  } {
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=1\norg="acme"\n[policy.hitl]\nrequire=${JSON.stringify(types)}\n`;
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(encodeBase64(kp.pubkey), "manual", 1);
    store.persist({
      toml,
      sig: signPolicy(toml, encodeBase64(kp.privkey)),
      org: "acme",
      version: 1,
      source: "peer",
      fetchedAt: 1,
    });
    const gate = new PolicyGate(store, baseline);
    expect(gate.status().signatureValid).toBe(true);
    return {
      policy: { isHitlRequiredByPolicy: (t) => isHitlRequiredByPolicy(gate.enforced(), t) },
      db,
    };
  }

  test("a policy requiring HITL for jira.before.read: one prompt (the write's), no read dispatched", async () => {
    const { policy, db } = signedPolicyRequiring(["jira.before.read"]);
    const { exec, seen } = executorHarness({ policy });
    const out = await exec.execute(WRITE);
    expect(out.status).toBe("ok");
    expect(seen.prompts).toHaveLength(1);
    expect(seen.prompts[0]).toContain("jira.issue.update");
    expect(seen.dispatched.map((a) => a.type)).toEqual(["jira.issue.update"]);
    const readAudit = seen.audits.find((a) => a.actionType === "jira.before.read");
    expect(readAudit?.hitlStatus).toBe("rejected");
    expect(readAudit?.actionJson).toContain(BEFORE_READ_HITL_REFUSAL);
    expect(seen.egress.map((e) => [e.destination, e.resultStatus])).toEqual([
      ["jira", "blocked"],
      ["jira", "authorized"],
    ]);
    expect(seen.details[0]?.["before"]).toEqual({
      status: "unavailable",
      reason: "policy requires approval",
    });
    db.close();
  });

  test("control: the same signed policy naming nothing lets the read run", async () => {
    const { policy, db } = signedPolicyRequiring([]);
    const { exec, seen } = executorHarness({ policy });
    await exec.execute(WRITE);
    expect(seen.dispatched.map((a) => a.type)).toEqual(["jira.before.read", "jira.issue.update"]);
    db.close();
  });

  test("a before-read type on any executor is refused, not prompted, when it would need HITL", async () => {
    const { policy, db } = signedPolicyRequiring(["jira.before.read"]);
    const { exec, seen } = executorHarness({ policy, withRunner: false });
    const res = await exec.execute({
      type: "jira.before.read",
      payload: { mcpToolId: "jira_jira_issue_get", input: { issueKey: "NIM-1" } },
    });
    expect(res).toEqual({ status: "rejected", reason: BEFORE_READ_HITL_REFUSAL });
    expect(seen.prompts).toEqual([]);
    expect(seen.dispatched).toEqual([]);
    db.close();
  });

  test("a user-MCP before-read type (I42 floor) is refused the same way", async () => {
    const { exec, seen } = executorHarness({ withRunner: false });
    const res = await exec.execute({ type: "mcp_notes.before.read", payload: {} });
    expect(res).toEqual({ status: "rejected", reason: BEFORE_READ_HITL_REFUSAL });
    expect(seen.prompts).toEqual([]);
  });
});

describe("the owner's prompt text shows the before-state", () => {
  test("the CLI prompt carries a Before: block after the new values", async () => {
    const { exec, seen } = executorHarness({ readReply: { summary: "old title" } });
    await exec.execute(WRITE);
    const prompt = seen.prompts[0] ?? "";
    expect(prompt).toContain("Requested by: the model");
    expect(prompt).toContain('  Summary: "new"');
    expect(prompt.indexOf('  Summary: "new"')).toBeLessThan(prompt.indexOf("Before:"));
    expect(prompt).toContain("Before:\n  Summary: old title");
  });

  test("an unavailable read is one fixed line", async () => {
    const { exec, seen } = executorHarness({});
    await exec.execute(WRITE, { beforeReaderUnlisted: true });
    expect(seen.prompts[0]).toContain("Before: unavailable (failed)");
  });
});

// ---- B2a: two reads, one budget --------------------------------------------------------------

/** A fake clock: `advance(ms)` fires every timer whose deadline has passed; `set` calls counted. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const counts = { set: 0, clear: 0 };
  return {
    counts,
    pending,
    advance(ms: number): void {
      now += ms;
      for (const [h, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(h);
          t.fn();
        }
      }
    },
    timers: {
      set: (fn: () => void, ms: number): unknown => {
        counts.set += 1;
        const h = next++;
        pending.set(h, { at: now + ms, fn });
        return h;
      },
      clear: (h: unknown): void => {
        counts.clear += 1;
        pending.delete(h as number);
      },
    } satisfies NonNullable<BeforeStateRunnerOptions["timers"]>,
  };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Resolves to `"pending"` when `p` has not settled within a few ticks (a test never hangs). */
async function settledOrPending<T>(p: Promise<T>): Promise<T | "pending"> {
  return Promise.race([p, Bun.sleep(20).then(() => "pending" as const)]);
}

const TRANSITION_PREVIEW = {
  target: "{issueKey}",
  summary: "Move {issueKey} through {transitionId}",
  fields: [
    { key: "transitionId", label: "Transition id", kind: "text" as const },
    { key: "expand", label: "Expand", kind: "text" as const },
  ],
};

interface TwoReadSeen {
  firstArgs: unknown[];
  alsoArgs: unknown[];
  selectCalls: Array<{ reply: unknown; picked: Readonly<Record<string, unknown>>; also: unknown }>;
}

/** A synthetic two-read reader: the transitions list (needs transitionId), then the issue. */
function twoReadReader(
  seen: TwoReadSeen,
  over: Partial<BeforeStateReader> = {},
): BeforeStateReader {
  return {
    tool: "jira_issue_transitions_list",
    argKeys: ["issueKey", "transitionId"],
    args: (input) => {
      seen.firstArgs.push({ ...input });
      return { issueKey: input["issueKey"] };
    },
    also: {
      tool: "jira_issue_get",
      argKeys: ["issueKey", "expand"],
      args: (input) => {
        seen.alsoArgs.push({ ...input });
        return { issueKey: input["issueKey"] };
      },
    },
    select: (reply, picked, also) => {
      seen.selectCalls.push({ reply, picked, also });
      const r = reply as { to?: unknown };
      const a = also as { status?: unknown };
      return [
        { label: "From", value: String(a.status) },
        { label: "To", value: `${String(r.to)} via ${String(picked["transitionId"])}` },
      ];
    },
    ...over,
  };
}

function transitionRow(reader: BeforeStateReader): ConnectorWriteRow {
  return withBefore(
    withPreview(
      row("jira_issue_transition", "jira.issue.transition", "mesh", 2),
      TRANSITION_PREVIEW,
    ),
    reader,
  );
}

const TRANSITION: PlannedAction = {
  type: "jira.issue.transition",
  origin: "model",
  payload: {
    mcpToolId: "jira_jira_issue_transition",
    input: { issueKey: "NIM-1", transitionId: "31", comment: "MODEL-ONLY" },
  },
};

const newSeen = (): TwoReadSeen => ({ firstArgs: [], alsoArgs: [], selectCalls: [] });

type GateAnswer = Awaited<ReturnType<BeforeReadOps["gate"]>>;

/** Ops whose dispatch answers by tool key; a function answer is called (it may throw). */
function opsByTool(
  answers: Record<string, unknown>,
  gated: PlannedAction[] = [],
  gateAnswer: (a: PlannedAction) => GateAnswer = () => "proceed",
): BeforeReadOps {
  return {
    gate: async (a) => {
      gated.push(a);
      return gateAnswer(a);
    },
    dispatch: async (a) => {
      const answer = answers[String(a.payload?.["mcpToolId"])];
      return typeof answer === "function" ? (answer as () => unknown)() : answer;
    },
  };
}

const READS_OK: Record<string, unknown> = {
  jira_jira_issue_transitions_list: { to: "Done" },
  jira_jira_issue_get: { status: "In Progress" },
};

const throwing = (msg: string) => (): never => {
  throw new Error(msg);
};

describe("a before-state reader may take a second read (B2a)", () => {
  test("two gated reads in order, then select gets (first reply, the union pick, second reply)", async () => {
    const seen = newSeen();
    const gated: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [transitionRow(twoReadReader(seen))] });
    const out = await runner.read(TRANSITION, opsByTool(READS_OK, gated));
    expect(gated).toEqual([
      {
        type: "jira.before.read",
        payload: { mcpToolId: "jira_jira_issue_transitions_list", input: { issueKey: "NIM-1" } },
      },
      {
        type: "jira.before.read",
        payload: { mcpToolId: "jira_jira_issue_get", input: { issueKey: "NIM-1" } },
      },
    ]);
    expect(out).toEqual({
      status: "ok",
      fields: [
        { label: "From", value: "In Progress" },
        { label: "To", value: "Done via 31" },
      ],
    });
    expect(seen.selectCalls).toHaveLength(1);
    const call = seen.selectCalls[0];
    expect(call?.reply).toEqual({ to: "Done" });
    expect(call?.also).toEqual({ status: "In Progress" });
    // The pick: frozen, null-prototype, the declared keys the input has (`expand` is absent), and
    // never an undeclared one (`comment`).
    const picked = call?.picked ?? {};
    expect(Object.isFrozen(picked)).toBe(true);
    expect(Object.getPrototypeOf(picked)).toBeNull();
    expect({ ...picked }).toEqual({ issueKey: "NIM-1", transitionId: "31" });
    // Each read's args received only its OWN argKeys.
    expect(seen.firstArgs).toEqual([{ issueKey: "NIM-1", transitionId: "31" }]);
    expect(seen.alsoArgs).toEqual([{ issueKey: "NIM-1" }]);
  });

  test("the first read throws: the second is never gated, and the whole before is failed", async () => {
    const gated: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [transitionRow(twoReadReader(newSeen()))] });
    const out = await runner.read(
      TRANSITION,
      opsByTool({ ...READS_OK, jira_jira_issue_transitions_list: throwing("boom") }, gated),
    );
    expect(out).toEqual({ status: "unavailable", reason: "failed" });
    expect(gated.map((a) => a.payload?.["mcpToolId"])).toEqual([
      "jira_jira_issue_transitions_list",
    ]);
  });

  test("the second read is not found: not configured, and no field of the first is shown", async () => {
    const gated: PlannedAction[] = [];
    const seen = newSeen();
    const runner = createBeforeStateRunner({ rows: [transitionRow(twoReadReader(seen))] });
    const out = await runner.read(
      TRANSITION,
      opsByTool({ ...READS_OK, jira_jira_issue_get: throwing("Tool not found") }, gated),
    );
    expect(out).toEqual({ status: "unavailable", reason: "not configured" });
    expect(gated).toHaveLength(2);
    expect(seen.selectCalls).toEqual([]);
  });

  test("the second read refused by the gate (policy): policy requires approval", async () => {
    const gated: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [transitionRow(twoReadReader(newSeen()))] });
    const out = await runner.read(
      TRANSITION,
      opsByTool(READS_OK, gated, (a) =>
        a.payload?.["mcpToolId"] === "jira_jira_issue_get"
          ? { status: "rejected", reason: BEFORE_READ_HITL_REFUSAL }
          : "proceed",
      ),
    );
    expect(out).toEqual({ status: "unavailable", reason: "policy requires approval" });
    expect(gated).toHaveLength(2);
  });

  test("the first read refused by the gate: the second is never gated", async () => {
    const gated: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [transitionRow(twoReadReader(newSeen()))] });
    const out = await runner.read(
      TRANSITION,
      opsByTool(READS_OK, gated, () => ({ status: "rejected", reason: BEFORE_READ_HITL_REFUSAL })),
    );
    expect(out).toEqual({ status: "unavailable", reason: "policy requires approval" });
    expect(gated).toHaveLength(1);
  });

  test("also.args failing (undefined or a throw): failed, and no read runs", async () => {
    for (const args of [() => undefined, throwing("also args boom")]) {
      const gated: PlannedAction[] = [];
      const reader = twoReadReader(newSeen());
      const runner = createBeforeStateRunner({
        rows: [
          transitionRow({
            ...reader,
            also: { tool: "jira_issue_get", argKeys: ["issueKey"], args },
          }),
        ],
      });
      expect(await runner.read(TRANSITION, opsByTool(READS_OK, gated))).toEqual({
        status: "unavailable",
        reason: "failed",
      });
      expect(gated).toEqual([]);
    }
  });

  test("one budget: the timer is set ONCE for both reads; 3 s + 3 s of fake time is a timeout", async () => {
    const clock = fakeClock();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const runner = createBeforeStateRunner({
      rows: [transitionRow(twoReadReader(newSeen()))],
      timers: clock.timers,
    });
    const pending = runner.read(TRANSITION, {
      gate: async () => "proceed",
      dispatch: (a) =>
        a.payload?.["mcpToolId"] === "jira_jira_issue_get" ? second.promise : first.promise,
    });
    await Bun.sleep(0);
    clock.advance(3000);
    first.resolve({ to: "Done" });
    await Bun.sleep(0);
    clock.advance(3000);
    const out = await settledOrPending(pending);
    expect(out).toEqual({ status: "unavailable", reason: "timeout" });
    // The late second reply is ignored.
    second.resolve({ status: REPLY_MARK });
    await Bun.sleep(0);
    expect(JSON.stringify(out)).not.toContain(REPLY_MARK);
    expect(clock.counts).toEqual({ set: 1, clear: 1 });
    expect(clock.pending.size).toBe(0);
  });

  test("the budget spent during the first read: the second read is never gated", async () => {
    const clock = fakeClock();
    const first = deferred<unknown>();
    const gated: PlannedAction[] = [];
    const runner = createBeforeStateRunner({
      rows: [transitionRow(twoReadReader(newSeen()))],
      timers: clock.timers,
    });
    const pending = runner.read(TRANSITION, {
      gate: async (a) => {
        gated.push(a);
        return "proceed";
      },
      dispatch: () => first.promise,
    });
    await Bun.sleep(0);
    clock.advance(BEFORE_STATE_TIMEOUT_MS);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    first.resolve({ to: "Done" });
    await Bun.sleep(5);
    expect(gated).toHaveLength(1);
  });

  test("both reads inside the budget: one timer, cleared once, and the fields shown", async () => {
    const clock = fakeClock();
    const runner = createBeforeStateRunner({
      rows: [transitionRow(twoReadReader(newSeen()))],
      timers: clock.timers,
    });
    const out = await runner.read(TRANSITION, opsByTool(READS_OK));
    expect(out?.status).toBe("ok");
    expect(clock.counts).toEqual({ set: 1, clear: 1 });
  });

  test("a one-read reader is unchanged: its select gets the pick and alsoReply undefined", async () => {
    const calls: unknown[][] = [];
    const reader: BeforeStateReader = {
      ...READER,
      select: (...a) => {
        calls.push(a);
        return [{ label: "Summary", value: "old" }];
      },
    };
    const gated: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [rowWith(reader)] });
    const out = await runner.read(WRITE, opsReturning({ summary: "old" }, gated));
    expect(out).toEqual({ status: "ok", fields: [{ label: "Summary", value: "old" }] });
    expect(gated).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    expect(calls[0]?.[2]).toBeUndefined();
    expect({ ...(calls[0]?.[1] as object) }).toEqual({ issueKey: "NIM-1" });
  });
});

// ---- B2a: the before-state guard -------------------------------------------------------------

const GUARD_REASON = "the model cannot move this issue; ask the owner";

/** A guard that applies when `transitionId` is set and allows when `allows` says so. */
function guarded(
  allows: BeforeStateGuard["allows"],
  over: Partial<BeforeStateReader> = {},
  appliesTo: BeforeStateGuard["appliesTo"] = (p) => p["transitionId"] !== undefined,
): ConnectorWriteRow {
  return transitionRow({
    ...twoReadReader(newSeen()),
    guard: { reason: GUARD_REASON, appliesTo, allows },
    ...over,
  });
}

const REFUSED = { status: "refused", reason: GUARD_REASON } as const;

const withoutTransition: PlannedAction = {
  ...TRANSITION,
  payload: { mcpToolId: "jira_jira_issue_transition", input: { issueKey: "NIM-1" } },
};

describe("the before-state guard (B2a)", () => {
  test("not applicable: the normal before, whatever allows says", async () => {
    const runner = createBeforeStateRunner({ rows: [guarded(() => false)] });
    const out = await runner.read(withoutTransition, opsByTool(READS_OK));
    expect(out?.status).toBe("ok");
  });

  test("not applicable and a read fails: unavailable, never refused", async () => {
    const runner = createBeforeStateRunner({ rows: [guarded(() => false)] });
    const out = await runner.read(
      withoutTransition,
      opsByTool({ ...READS_OK, jira_jira_issue_get: throwing("x") }),
    );
    expect(out).toEqual({ status: "unavailable", reason: "failed" });
  });

  test("applicable and allows returns exactly true: the normal before; allows saw both replies and the pick", async () => {
    const seen: unknown[][] = [];
    const runner = createBeforeStateRunner({
      rows: [
        guarded((...a) => {
          seen.push(a);
          return true;
        }),
      ],
    });
    const out = await runner.read(TRANSITION, opsByTool(READS_OK));
    expect(out?.status).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toEqual({ to: "Done" });
    expect({ ...(seen[0]?.[1] as object) }).toEqual({ issueKey: "NIM-1", transitionId: "31" });
    expect(seen[0]?.[2]).toEqual({ status: "In Progress" });
  });

  test("applicable: allows false, a throw, or a truthy non-true value refuses", async () => {
    const answers: Array<BeforeStateGuard["allows"]> = [
      () => false,
      throwing("allows boom"),
      () => 1 as unknown as boolean,
      () => "true" as unknown as boolean,
    ];
    for (const allows of answers) {
      const runner = createBeforeStateRunner({ rows: [guarded(allows)] });
      expect(await runner.read(TRANSITION, opsByTool(READS_OK))).toEqual(REFUSED);
    }
  });

  test("applicable: every failed or missing read refuses (fail closed), never unavailable", async () => {
    const cases: Array<readonly [string, BeforeReadOps]> = [
      [
        "first read throws",
        opsByTool({ ...READS_OK, jira_jira_issue_transitions_list: throwing("x") }),
      ],
      ["second read throws", opsByTool({ ...READS_OK, jira_jira_issue_get: throwing("x") })],
      [
        "second read not found",
        opsByTool({ ...READS_OK, jira_jira_issue_get: throwing("Tool not found") }),
      ],
      [
        "a read policy-refused",
        opsByTool(READS_OK, [], () => ({ status: "rejected", reason: BEFORE_READ_HITL_REFUSAL })),
      ],
    ];
    for (const [name, ops] of cases) {
      const runner = createBeforeStateRunner({ rows: [guarded(() => true)] });
      expect(await runner.read(TRANSITION, ops), name).toEqual(REFUSED);
    }
  });

  test("applicable: a read that times out refuses", async () => {
    const clock = fakeClock();
    const runner = createBeforeStateRunner({ rows: [guarded(() => true)], timers: clock.timers });
    const pending = runner.read(TRANSITION, {
      gate: async () => "proceed",
      dispatch: () => new Promise(() => {}),
    });
    await Bun.sleep(0);
    clock.advance(BEFORE_STATE_TIMEOUT_MS);
    expect(await pending).toEqual(REFUSED);
  });

  test("applicable: the reader unlisted refuses, and no read runs", async () => {
    const gated: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [guarded(() => true)] });
    expect(
      await runner.read(TRANSITION, opsByTool(READS_OK, gated), { readerUnlisted: true }),
    ).toEqual(REFUSED);
    expect(gated).toEqual([]);
  });

  test("applicable: args or also.args failing (undefined or a throw) refuses, and no read runs", async () => {
    const failing = [() => undefined, throwing("args boom")];
    for (const args of failing) {
      for (const over of [
        { args },
        { also: { tool: "jira_issue_get", argKeys: ["issueKey"], args } },
      ] as const) {
        const gated: PlannedAction[] = [];
        const runner = createBeforeStateRunner({ rows: [guarded(() => true, over)] });
        expect(await runner.read(TRANSITION, opsByTool(READS_OK, gated))).toEqual(REFUSED);
        expect(gated).toEqual([]);
      }
    }
  });

  test("applicable: select failing after the guard allowed refuses (no half-shown before)", async () => {
    const runner = createBeforeStateRunner({
      rows: [guarded(() => true, { select: throwing("select boom") })],
    });
    expect(await runner.read(TRANSITION, opsByTool(READS_OK))).toEqual(REFUSED);
  });

  test("a non-object write input refuses when the reader has a guard (nothing to decide from)", async () => {
    const runner = createBeforeStateRunner({ rows: [guarded(() => true)] });
    const odd: PlannedAction = {
      ...TRANSITION,
      payload: { mcpToolId: "jira_jira_issue_transition", input: "nope" },
    };
    expect(await runner.read(odd, opsByTool(READS_OK))).toEqual(REFUSED);
  });

  test("appliesTo throwing, or returning anything but false, applies (fail closed)", async () => {
    for (const appliesTo of [
      throwing("applies boom"),
      () => undefined as unknown as boolean,
      () => 0 as unknown as boolean,
    ]) {
      const runner = createBeforeStateRunner({
        rows: [guarded(() => false, {}, appliesTo)],
      });
      expect(await runner.read(withoutTransition, opsByTool(READS_OK))).toEqual(REFUSED);
    }
  });

  test("a one-read reader with a guard refuses the same way", async () => {
    const reader: BeforeStateReader = {
      ...READER,
      guard: { reason: GUARD_REASON, appliesTo: () => true, allows: () => false },
    };
    const runner = createBeforeStateRunner({ rows: [rowWith(reader)] });
    expect(await runner.read(WRITE, opsReturning({ summary: "old" }))).toEqual(REFUSED);
  });
});

describe("a read whose gate resolves after the budget ran out is never dispatched (B2a review)", () => {
  async function expireDuringGate(
    rowToUse: ConnectorWriteRow,
    action: PlannedAction,
    pendingGateIndex: number,
  ) {
    const clock = fakeClock();
    const gateDone = deferred<GateAnswer>();
    const gated: PlannedAction[] = [];
    const dispatched: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [rowToUse], timers: clock.timers });
    const pending = runner.read(action, {
      gate: (a) => {
        gated.push(a);
        return gated.length - 1 === pendingGateIndex
          ? gateDone.promise
          : Promise.resolve("proceed" as const);
      },
      dispatch: async (a) => {
        dispatched.push(a);
        return READS_OK[String(a.payload?.["mcpToolId"])] ?? { summary: "old" };
      },
    });
    await Bun.sleep(0);
    clock.advance(BEFORE_STATE_TIMEOUT_MS);
    const out = await pending;
    // The gate now resolves "proceed", after the cap: the read must not reach the connector.
    gateDone.resolve("proceed");
    await Bun.sleep(5);
    return { out, gated, dispatched };
  }

  test("one read: the gate pending past the cap -> unavailable (timeout), no dispatch", async () => {
    const { out, gated, dispatched } = await expireDuringGate(rowWith(READER), WRITE, 0);
    expect(out).toEqual({ status: "unavailable", reason: "timeout" });
    expect(gated).toHaveLength(1);
    expect(dispatched).toEqual([]);
  });

  test("the second read's gate pending past the cap -> timeout; only the first read was dispatched", async () => {
    const { out, gated, dispatched } = await expireDuringGate(
      transitionRow(twoReadReader(newSeen())),
      TRANSITION,
      1,
    );
    expect(out).toEqual({ status: "unavailable", reason: "timeout" });
    expect(gated).toHaveLength(2);
    expect(dispatched.map((a) => a.payload?.["mcpToolId"])).toEqual([
      "jira_jira_issue_transitions_list",
    ]);
  });

  test("under an applicable guard the same expiry refuses, and nothing more is dispatched", async () => {
    const { out, dispatched } = await expireDuringGate(
      guarded(() => true),
      TRANSITION,
      0,
    );
    expect(out).toEqual(REFUSED);
    expect(dispatched).toEqual([]);
  });
});

// ---- B2: the real rows (the Linear assignee guard, the Jira transition's two reads) ----------

const mcpReply = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const LINEAR_ID = "8f2b0a1c-0000-4000-8000-000000000001";

function linearGet(assignee: unknown, over: Record<string, unknown> = {}) {
  return mcpReply({
    issue: {
      id: LINEAR_ID,
      identifier: "ENG-12",
      title: "Flaky test",
      state: { name: "Todo" },
      priority: 2,
      assignee,
      ...over,
    },
  });
}

function linearUpdate(input: Record<string, unknown>): PlannedAction {
  return {
    type: "linear.issue.update",
    origin: "model",
    payload: { mcpToolId: "linear_linear_issue_update", input: { issueId: LINEAR_ID, ...input } },
  };
}

const LINEAR_REFUSED = { status: "refused", reason: LINEAR_ASSIGNEE_REFUSAL } as const;

describe("the real linear_issue_update guard (OR-B2-3, plan R5)", () => {
  const runner = () => createBeforeStateRunner({ rows: CONNECTOR_WRITE_ROWS });

  test("assigneeId while the read proves the issue unassigned: the normal before", async () => {
    const gated: PlannedAction[] = [];
    const out = await runner().read(
      linearUpdate({ assigneeId: "user-1" }),
      opsByTool({ linear_linear_issue_get: linearGet(null) }, gated),
    );
    expect(out).toEqual({
      status: "ok",
      fields: [
        { label: "Issue", value: "ENG-12" },
        { label: "Title", value: "Flaky test" },
        { label: "State", value: "Todo" },
        { label: "Priority", value: "2" },
        { label: "Assignee", value: "(none)" },
      ],
    });
    // The read is the issue id only: the write's assigneeId is never sent to it.
    expect(gated).toEqual([
      {
        type: "linear.before.read",
        payload: { mcpToolId: "linear_linear_issue_get", input: { issueId: LINEAR_ID } },
      },
    ]);
  });

  test("assigneeId with anything but a proven null: refused with the fixed reason", async () => {
    const cases: Array<readonly [string, unknown]> = [
      ["assigned", linearGet({ id: "u", displayName: "Carol" })],
      ["assignee {}", linearGet({})],
      ["assignee omitted", mcpReply({ issue: { id: LINEAR_ID, title: "t" } })],
      ["issue null", mcpReply({ issue: null })],
      ["isError", { ...linearGet(null), isError: true }],
      // Proven null but the selection fails (no title): fail closed, refused.
      ["select throws", linearGet(null, { title: undefined })],
    ];
    for (const [name, reply] of cases) {
      const out = await runner().read(
        linearUpdate({ assigneeId: "user-1" }),
        opsByTool({ linear_linear_issue_get: reply }),
      );
      expect(out, name).toEqual(LINEAR_REFUSED);
    }
  });

  test("assigneeId with a failed, unlisted, policy-refused or slow read: refused", async () => {
    const write = linearUpdate({ assigneeId: "user-1" });
    expect(
      await runner().read(write, opsByTool({ linear_linear_issue_get: throwing("boom") })),
    ).toEqual(LINEAR_REFUSED);
    expect(
      await runner().read(
        write,
        opsByTool({ linear_linear_issue_get: throwing("Tool not found") }),
      ),
    ).toEqual(LINEAR_REFUSED);
    const unlistedGated: PlannedAction[] = [];
    expect(
      await runner().read(
        write,
        opsByTool({ linear_linear_issue_get: linearGet(null) }, unlistedGated),
        { readerUnlisted: true },
      ),
    ).toEqual(LINEAR_REFUSED);
    expect(unlistedGated).toEqual([]);
    expect(
      await runner().read(
        write,
        opsByTool({ linear_linear_issue_get: linearGet(null) }, [], () => ({
          status: "rejected",
          reason: BEFORE_READ_HITL_REFUSAL,
        })),
      ),
    ).toEqual(LINEAR_REFUSED);

    const clock = fakeClock();
    const slow = deferred<unknown>();
    const timed = createBeforeStateRunner({ rows: CONNECTOR_WRITE_ROWS, timers: clock.timers });
    const pending = timed.read(write, {
      gate: async () => "proceed",
      dispatch: () => slow.promise,
    });
    await Bun.sleep(0);
    clock.advance(BEFORE_STATE_TIMEOUT_MS);
    expect(await pending).toEqual(LINEAR_REFUSED);
    slow.resolve(linearGet(null));
  });

  test("assigneeId null applies the guard: refused when assigned or unreadable, allowed when unassigned", async () => {
    const input = { title: "x", assigneeId: null };
    expect(
      await runner().read(
        linearUpdate(input),
        opsByTool({ linear_linear_issue_get: linearGet({ id: "u", displayName: "Carol" }) }),
      ),
    ).toEqual(LINEAR_REFUSED);
    expect(
      await runner().read(
        linearUpdate(input),
        opsByTool({ linear_linear_issue_get: throwing("boom") }),
      ),
    ).toEqual(LINEAR_REFUSED);
    expect(
      (
        await runner().read(
          linearUpdate(input),
          opsByTool({ linear_linear_issue_get: linearGet(null) }),
        )
      )?.status,
    ).toBe("ok");
  });

  test("no assigneeId: never refused by the guard, even when assigned or failing", async () => {
    for (const input of [{ title: "x" }]) {
      const assigned = await runner().read(
        linearUpdate(input),
        opsByTool({ linear_linear_issue_get: linearGet({ id: "u", displayName: "Carol" }) }),
      );
      expect(assigned?.status, JSON.stringify(input)).toBe("ok");
      const failed = await runner().read(
        linearUpdate(input),
        opsByTool({ linear_linear_issue_get: throwing("boom") }),
      );
      expect(failed, JSON.stringify(input)).toEqual({ status: "unavailable", reason: "failed" });
    }
  });
});

describe("the real jira_issue_transition reader (OR-B2-1)", () => {
  test("two jira.before.read actions gated in order: the transitions list, then the issue", async () => {
    const gated: PlannedAction[] = [];
    const out = await createBeforeStateRunner({ rows: CONNECTOR_WRITE_ROWS }).read(
      {
        type: "jira.issue.transition",
        origin: "model",
        payload: {
          mcpToolId: "jira_jira_issue_transition",
          input: { issueKey: "NIM-1", transitionId: "31" },
        },
      },
      opsByTool(
        {
          jira_jira_issue_transitions_list: mcpReply({
            transitions: [{ id: "31", name: "Done", to: { name: "Done" } }],
          }),
          jira_jira_issue_get: mcpReply({ fields: { status: { name: "In Progress" } } }),
        },
        gated,
      ),
    );
    expect(gated.map((a) => [a.type, a.payload?.["mcpToolId"]])).toEqual([
      ["jira.before.read", "jira_jira_issue_transitions_list"],
      ["jira.before.read", "jira_jira_issue_get"],
    ]);
    expect(out).toEqual({
      status: "ok",
      fields: [
        { label: "From", value: "In Progress" },
        { label: "Transition", value: "Done" },
        { label: "To", value: "Done" },
      ],
    });
  });
});

// ---- B3: the real confluence_page_append reader (plan R3, Task 2) -------------------------------

function confluenceAppend(): PlannedAction {
  return {
    type: "confluence.page.append",
    origin: "model",
    payload: {
      mcpToolId: "confluence_confluence_page_append",
      input: { pageId: "123", storageHtml: "<p>new</p>" },
    },
  };
}

const CONFLUENCE_PAGE = {
  title: "Runbook",
  space: { key: "ENG" },
  version: { number: 7 },
  body: { storage: { value: "<p>old</p>" } },
};

describe("the real confluence_page_append reader (B3)", () => {
  // No KB configured, so the KB-child guard does not apply here (its own block is below).
  const NO_KB = () => ({ kb: undefined });
  const runner = () => createBeforeStateRunner({ rows: CONNECTOR_WRITE_ROWS, guardContext: NO_KB });

  test("one confluence.before.read gated, keyed confluence_confluence_page_get, with the page id only", async () => {
    const gated: PlannedAction[] = [];
    const out = await runner().read(
      confluenceAppend(),
      opsByTool({ confluence_confluence_page_get: mcpReply(CONFLUENCE_PAGE) }, gated),
    );
    expect(gated).toEqual([
      {
        type: "confluence.before.read",
        payload: { mcpToolId: "confluence_confluence_page_get", input: { pageId: "123" } },
      },
    ]);
    expect(out).toEqual({
      status: "ok",
      fields: [
        { label: "Title", value: "Runbook" },
        { label: "Space", value: "ENG" },
        { label: "Version", value: "7" },
        { label: "Current length", value: "10 characters (kept)" },
        { label: "Current body (end)", value: "<p>old</p>" },
      ],
    });
  });

  test("a read slower than the budget is unavailable (timeout)", async () => {
    const clock = fakeClock();
    const slow = deferred<unknown>();
    const timed = createBeforeStateRunner({
      rows: CONNECTOR_WRITE_ROWS,
      timers: clock.timers,
      guardContext: NO_KB,
    });
    const pending = timed.read(confluenceAppend(), {
      gate: async () => "proceed",
      dispatch: () => slow.promise,
    });
    await Bun.sleep(0);
    clock.advance(6000);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    slow.resolve(mcpReply(CONFLUENCE_PAGE));
  });

  test("a 5 MB reply (over the 4 MiB cap) is unavailable (failed)", async () => {
    const huge = mcpReply({
      ...CONFLUENCE_PAGE,
      body: { storage: { value: "a".repeat(5 * 1024 * 1024) } },
    });
    const out = await runner().read(
      confluenceAppend(),
      opsByTool({ confluence_confluence_page_get: huge }),
    );
    expect(out).toEqual({ status: "unavailable", reason: "failed" });
  });
});

// ---- B4a: the real gdrive_file_create reader (plan R3, Task A2) ---------------------------------

function driveCreate(input: Record<string, unknown>): PlannedAction {
  return {
    type: "google_drive.file.create",
    origin: "model",
    payload: { mcpToolId: "google_drive_gdrive_file_create", input },
  };
}

const DRIVE_PARENT = {
  name: "Team notes",
  mimeType: "application/vnd.google-apps.folder",
  shared: true,
  owners: [{ emailAddress: "alice@example.com" }],
};

describe("the real gdrive_file_create reader (B4a)", () => {
  const runner = () => createBeforeStateRunner({ rows: CONNECTOR_WRITE_ROWS });

  test("parentId unset: one google_drive.before.read gated, keyed google_drive_gdrive_file_metadata, { fileId: root }", async () => {
    const gated: PlannedAction[] = [];
    const out = await runner().read(
      driveCreate({ name: "n.txt", content: "x" }),
      opsByTool({ google_drive_gdrive_file_metadata: mcpReply(DRIVE_PARENT) }, gated),
    );
    expect(gated).toEqual([
      {
        type: "google_drive.before.read",
        payload: { mcpToolId: "google_drive_gdrive_file_metadata", input: { fileId: "root" } },
      },
    ]);
    expect(out).toEqual({
      status: "ok",
      fields: [
        { label: "Folder", value: "Team notes" },
        { label: "Folder type", value: "folder" },
        {
          label: "Shared",
          value: "yes: the new file is visible to everyone this folder is shared with",
        },
        { label: "Owner", value: "alice@example.com" },
      ],
    });
  });

  test("parentId F1: the read names F1 only", async () => {
    const gated: PlannedAction[] = [];
    await runner().read(
      driveCreate({ name: "n.txt", parentId: "F1", content: "CONTENT-NOT-READ" }),
      opsByTool({ google_drive_gdrive_file_metadata: mcpReply(DRIVE_PARENT) }, gated),
    );
    expect(gated.map((a) => a.payload?.["input"])).toEqual([{ fileId: "F1" }]);
  });

  test("a read slower than the budget is unavailable (timeout)", async () => {
    const clock = fakeClock();
    const slow = deferred<unknown>();
    const timed = createBeforeStateRunner({ rows: CONNECTOR_WRITE_ROWS, timers: clock.timers });
    const pending = timed.read(driveCreate({ name: "n.txt", parentId: "F1" }), {
      gate: async () => "proceed",
      dispatch: () => slow.promise,
    });
    await Bun.sleep(0);
    clock.advance(6000);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    slow.resolve(mcpReply(DRIVE_PARENT));
  });
});

// ---- B3: the guard context (R11) ---------------------------------------------------------------

const KB_CTX = {
  kb: {
    notion: { databaseId: "0123abcd0123abcd0123abcd0123abcd" },
    confluence: { spaceKey: "KB", parentPageId: "4242" },
  },
};

describe("the guard context snapshot (B3, R11)", () => {
  /** A guarded fixture row that records the context each function receives. */
  function recording() {
    const applied: Array<BeforeGuardContext | undefined> = [];
    const allowed: Array<BeforeGuardContext | undefined> = [];
    const r = guarded(
      (_reply, _picked, _also, ctx) => {
        allowed.push(ctx);
        return true;
      },
      {},
      (_picked, ctx) => {
        applied.push(ctx);
        return true;
      },
    );
    return { r, applied, allowed };
  }

  test("the accessor is called once per read; appliesTo and allows get the SAME frozen snapshot", async () => {
    const h = recording();
    let calls = 0;
    const runner = createBeforeStateRunner({
      rows: [h.r],
      guardContext: () => {
        calls += 1;
        return structuredClone(KB_CTX);
      },
    });
    expect((await runner.read(TRANSITION, opsByTool(READS_OK)))?.status).toBe("ok");
    expect(calls).toBe(1);
    expect(h.applied).toHaveLength(1);
    expect(h.allowed).toHaveLength(1);
    const ctx = h.applied[0];
    expect(h.allowed[0]).toBe(ctx);
    expect(ctx).toEqual(KB_CTX);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx?.kb)).toBe(true);
    expect(Object.isFrozen(ctx?.kb?.notion)).toBe(true);
    expect(Object.isFrozen(ctx?.kb?.confluence)).toBe(true);
    await runner.read(TRANSITION, opsByTool(READS_OK));
    expect(calls).toBe(2);
  });

  test("mutating the accessor's object after the snapshot changes nothing allows sees", async () => {
    const source = structuredClone(KB_CTX);
    const h = recording();
    const runner = createBeforeStateRunner({ rows: [h.r], guardContext: () => source });
    const ops = opsByTool(READS_OK);
    const mutatingOps: BeforeReadOps = {
      gate: ops.gate,
      dispatch: async (a) => {
        // The config changes while the read is in flight, between appliesTo and allows.
        source.kb.notion.databaseId = "changed";
        source.kb = { notion: { databaseId: "other" }, confluence: source.kb.confluence };
        return ops.dispatch(a);
      },
    };
    await runner.read(TRANSITION, mutatingOps);
    expect(h.allowed[0]).toEqual(KB_CTX);
    expect(h.allowed[0]).not.toBe(source);
  });

  test("an accessor that throws, returns null or a non-object, cannot be copied, or is absent: undefined", async () => {
    const accessors: Array<(() => BeforeGuardContext) | undefined> = [
      () => {
        throw new Error("config");
      },
      () => null as unknown as BeforeGuardContext,
      () => "kb" as unknown as BeforeGuardContext,
      // A `kb` that is present but not a plain object: unreadable too, so the guard applies.
      () => ({ kb: null }) as unknown as BeforeGuardContext,
      () => ({ kb: "x" }) as unknown as BeforeGuardContext,
      () => ({ kb: [] }) as unknown as BeforeGuardContext,
      // A value that cannot be copied (a function inside): unreadable, never passed through.
      () => ({ kb: { notion: { databaseId: (() => "x") as unknown as string } } }),
      undefined,
    ];
    for (const guardContext of accessors) {
      const h = recording();
      const runner = createBeforeStateRunner(
        guardContext === undefined ? { rows: [h.r] } : { rows: [h.r], guardContext },
      );
      await runner.read(TRANSITION, opsByTool(READS_OK));
      expect(h.applied).toEqual([undefined]);
      expect(h.allowed).toEqual([undefined]);
    }
  });

  test("a cyclic config is copied and frozen without hanging", async () => {
    const h = recording();
    const kb: Record<string, unknown> = { notion: { databaseId: "d" } };
    kb["self"] = kb;
    const runner = createBeforeStateRunner({
      rows: [h.r],
      guardContext: () => ({ kb }) as unknown as BeforeGuardContext,
    });
    await runner.read(TRANSITION, opsByTool(READS_OK));
    const seen = h.applied[0]?.kb as Record<string, unknown> | undefined;
    expect(Object.isFrozen(seen)).toBe(true);
    expect(seen?.["self"]).toBe(seen);
  });

  test("a row without a guard never calls the accessor", async () => {
    let calls = 0;
    const runner = createBeforeStateRunner({
      rows: [rowWith(READER)],
      guardContext: () => {
        calls += 1;
        return KB_CTX;
      },
    });
    await runner.read(WRITE, opsReturning({ summary: "s" }));
    expect(calls).toBe(0);
  });

  test("B2's Linear guard ignores the context: refused when assigned, allowed when not, whatever the KB", async () => {
    for (const guardContext of [() => KB_CTX, () => ({ kb: undefined }), undefined]) {
      const runner = createBeforeStateRunner(
        guardContext === undefined
          ? { rows: CONNECTOR_WRITE_ROWS }
          : { rows: CONNECTOR_WRITE_ROWS, guardContext },
      );
      expect(
        await runner.read(
          linearUpdate({ assigneeId: "user-1" }),
          opsByTool({ linear_linear_issue_get: linearGet({ id: "u", displayName: "C" }) }),
        ),
      ).toEqual(LINEAR_REFUSED);
      const unassigned = await runner.read(
        linearUpdate({ assigneeId: "user-1" }),
        opsByTool({ linear_linear_issue_get: linearGet(null) }),
      );
      expect(unassigned?.status).toBe("ok");
    }
  });
});

// ---- B3: the KB-child guard on the real rows (OR-B3-3, R11) -----------------------------------

const KB_CHILD_REFUSED = { status: "refused", reason: KNOWLEDGE_BASE_CHILD_REFUSAL } as const;
const KB_DB = "0123abcd0123abcd0123abcd0123abcd";

function notionWrite(toolId: "notion_page_update" | "notion_block_append"): PlannedAction {
  const input =
    toolId === "notion_page_update"
      ? { pageId: "ffffffffffffffffffffffffffffffff", propertiesJson: "{}" }
      : { parentBlockId: "ffffffffffffffffffffffffffffffff", childrenJson: "[]" };
  return {
    type: toolId === "notion_page_update" ? "notion.page.update" : "notion.block.append",
    origin: "model",
    payload: { mcpToolId: `notion_${toolId}`, input },
  };
}

function confluenceWrite(
  toolId: "confluence_page_update" | "confluence_page_append",
): PlannedAction {
  const input =
    toolId === "confluence_page_update"
      ? { pageId: "123", versionNumber: 7, title: "t", storageHtml: "<p>x</p>" }
      : { pageId: "123", storageHtml: "<p>x</p>" };
  return {
    type: toolId === "confluence_page_update" ? "confluence.page.update" : "confluence.page.append",
    origin: "model",
    payload: { mcpToolId: `confluence_${toolId}`, input },
  };
}

const notionPage = (parent: unknown) =>
  mcpReply({
    page: {
      ...(parent === undefined ? {} : { parent }),
      properties: { Name: { type: "title", title: [{ plain_text: "Runbook" }] } },
    },
    blockChildren: { results: [], has_more: false },
  });

const confluencePage = (space: unknown, ancestors?: unknown) =>
  mcpReply({
    title: "Runbook",
    ...(space === undefined ? {} : { space }),
    version: { number: 7 },
    body: { storage: { value: "<p>old</p>" } },
    ...(ancestors === undefined ? {} : { ancestors }),
  });

const UNAVAILABLE = { status: "unavailable", reason: "failed" } as const;

describe("the KB-child guard on the real page rows (OR-B3-3)", () => {
  const runner = (guardContext?: () => BeforeGuardContext) =>
    createBeforeStateRunner(
      guardContext === undefined
        ? { rows: CONNECTOR_WRITE_ROWS }
        : { rows: CONNECTOR_WRITE_ROWS, guardContext },
    );

  for (const toolId of ["notion_page_update", "notion_block_append"] as const) {
    describe(toolId, () => {
      const read = (reply: unknown, guardContext: () => BeforeGuardContext = () => KB_CTX) =>
        runner(guardContext).read(
          notionWrite(toolId),
          opsByTool({ notion_notion_page_get: reply }),
        );

      test("a page in the KB database (hyphenated, upper-case) is refused before any prompt", async () => {
        for (const id of [
          "0123abcd-0123-abcd-0123-abcd0123abcd",
          "0123ABCD0123ABCD0123ABCD0123ABCD",
          KB_DB,
        ]) {
          expect(await read(notionPage({ type: "database_id", database_id: id })), id).toEqual(
            KB_CHILD_REFUSED,
          );
        }
      });

      test("another database, a page or a workspace parent: the before fields", async () => {
        for (const parent of [
          { type: "database_id", database_id: "ffffffffffffffffffffffffffffffff" },
          { type: "page_id", page_id: "p" },
          { type: "workspace", workspace: true },
        ]) {
          expect((await read(notionPage(parent)))?.status, JSON.stringify(parent)).toBe("ok");
        }
      });

      test("no parent, page null, a database parent without an id, a failed or isError read: refused", async () => {
        for (const reply of [
          notionPage(undefined),
          mcpReply({ page: null, blockChildren: { results: [] } }),
          notionPage({ type: "database_id" }),
          { ...notionPage({ type: "page_id" }), isError: true },
          notionPage({ type: "data_source_id", data_source_id: KB_DB }),
          notionPage({
            type: "data_source_id",
            data_source_id: "ffffffffffffffffffffffffffffffff",
          }),
          throwing("boom"),
          throwing("Tool not found"),
        ]) {
          expect(await read(reply)).toEqual(KB_CHILD_REFUSED);
        }
      });

      test("an unlisted, policy-refused or slow read: refused", async () => {
        const reply = notionPage({ type: "page_id" });
        expect(
          await runner(() => KB_CTX).read(
            notionWrite(toolId),
            opsByTool({ notion_notion_page_get: reply }),
            { readerUnlisted: true },
          ),
        ).toEqual(KB_CHILD_REFUSED);
        expect(
          await runner(() => KB_CTX).read(
            notionWrite(toolId),
            opsByTool({ notion_notion_page_get: reply }, [], () => ({
              status: "rejected",
              reason: BEFORE_READ_HITL_REFUSAL,
            })),
          ),
        ).toEqual(KB_CHILD_REFUSED);
        const clock = fakeClock();
        const slow = deferred<unknown>();
        const pending = createBeforeStateRunner({
          rows: CONNECTOR_WRITE_ROWS,
          timers: clock.timers,
          guardContext: () => KB_CTX,
        }).read(notionWrite(toolId), { gate: async () => "proceed", dispatch: () => slow.promise });
        await Bun.sleep(0);
        clock.advance(BEFORE_STATE_TIMEOUT_MS);
        expect(await pending).toEqual(KB_CHILD_REFUSED);
        slow.resolve(reply);
      });

      test("a throwing or absent guardContext, or a malformed kb, applies the guard and refuses", async () => {
        const ok = notionPage({ type: "page_id" });
        for (const bad of [null, "x", []]) {
          expect(
            await read(ok, () => ({ kb: bad }) as unknown as BeforeGuardContext),
            JSON.stringify(bad),
          ).toEqual(KB_CHILD_REFUSED);
        }
        expect(
          await read(ok, () => {
            throw new Error("config");
          }),
        ).toEqual(KB_CHILD_REFUSED);
        expect(
          await runner().read(notionWrite(toolId), opsByTool({ notion_notion_page_get: ok })),
        ).toEqual(KB_CHILD_REFUSED);
      });

      test("no Notion KB: the guard does not apply, even when the read fails", async () => {
        const noNotion = () => ({ kb: { confluence: KB_CTX.kb.confluence } });
        expect(await read(throwing("boom"), noNotion)).toEqual(UNAVAILABLE);
        expect(await read(throwing("boom"), () => ({ kb: undefined }))).toEqual(UNAVAILABLE);
        const inDb = notionPage({ type: "database_id", database_id: KB_DB });
        expect((await read(inDb, noNotion))?.status).toBe("ok");
      });
    });
  }

  for (const toolId of ["confluence_page_update", "confluence_page_append"] as const) {
    describe(toolId, () => {
      const read = (reply: unknown, guardContext: () => BeforeGuardContext = () => KB_CTX) =>
        runner(guardContext).read(
          confluenceWrite(toolId),
          opsByTool({ confluence_confluence_page_get: reply }),
        );

      test("in the KB space without ancestors (the 0.4.0 shape): refused, kb vs KB too", async () => {
        for (const key of ["KB", "kb", " KB "]) {
          expect(await read(confluencePage({ key })), key).toEqual(KB_CHILD_REFUSED);
        }
      });

      test("in the KB space with the KB parent first, last, in the middle, or as a number: refused", async () => {
        for (const ancestors of [
          [{ id: "4242" }, { id: "1" }],
          [{ id: "1" }, { id: "4242" }],
          [{ id: "1" }, { id: " 4242 " }, { id: "2" }],
          [{ id: 4242 }],
        ]) {
          expect(
            await read(confluencePage({ key: "KB" }, ancestors)),
            JSON.stringify(ancestors),
          ).toEqual(KB_CHILD_REFUSED);
        }
      });

      test("in the KB space with 0.5.0's ancestors not under the KB parent, or in another space: the before fields", async () => {
        for (const ancestors of [
          [
            { id: "1", title: "Home" },
            { id: "77", title: "Runbooks" },
          ],
          [{ id: "42420", title: null }],
          [],
        ]) {
          expect(
            (await read(confluencePage({ key: "KB" }, ancestors)))?.status,
            JSON.stringify(ancestors),
          ).toBe("ok");
        }
        expect((await read(confluencePage({ key: "ENG" })))?.status).toBe("ok");
        // Another space proves the page outside the KB whatever its ancestors look like.
        expect((await read(confluencePage({ key: "ENG" }, [{ id: null }, "junk"])))?.status).toBe(
          "ok",
        );
      });

      test("in the KB space with a null-id, malformed or non-canonical ancestor: refused", async () => {
        for (const ancestors of [
          [{ id: "1" }, { id: null, title: "Hidden" }],
          [{ id: "1" }, "junk", null, { id: "2" }],
          [{ title: "no id" }],
          [[{ id: "1" }]],
          [{ id: "" }],
          [{ id: "0" }],
          [{ id: "12a" }],
          [{ id: 9 }],
        ]) {
          expect(
            await read(confluencePage({ key: "KB" }, ancestors)),
            JSON.stringify(ancestors),
          ).toEqual(KB_CHILD_REFUSED);
        }
      });

      test("the KB parent as an ancestor or as the page itself refuses in ANY space, beside junk too", async () => {
        for (const reply of [
          confluencePage({ key: "ENG" }, [{ id: "1" }, { id: "4242", title: "KB" }]),
          confluencePage({ key: "ENG" }, [{ id: null }, { id: "04242" }]),
          confluencePage({ key: "KB" }, ["junk", { id: 4242 }]),
          mcpReply({ id: "4242", title: "KB", space: { key: "ENG" }, ancestors: [] }),
          mcpReply({ id: " 4242 ", title: "KB", space: { key: "KB" }, ancestors: [] }),
        ]) {
          expect(await read(reply)).toEqual(KB_CHILD_REFUSED);
        }
      });

      test("a KB parent id that is not canonical cannot be compared: refused in the KB space only", async () => {
        const odd = () => ({ kb: { confluence: { spaceKey: "KB", parentPageId: "kb-root" } } });
        expect(await read(confluencePage({ key: "KB" }, [{ id: "1" }]), odd)).toEqual(
          KB_CHILD_REFUSED,
        );
        expect((await read(confluencePage({ key: "ENG" }, [{ id: "1" }]), odd))?.status).toBe("ok");
      });

      test("space missing or not a string, ancestors not an array, a failed read: refused", async () => {
        for (const reply of [
          confluencePage(undefined),
          confluencePage({ key: 7 }),
          confluencePage({ key: "KB" }, { id: "1" }),
          throwing("boom"),
        ]) {
          expect(await read(reply)).toEqual(KB_CHILD_REFUSED);
        }
      });

      test("no Confluence KB: the guard does not apply, even when the read fails", async () => {
        const noConfluence = () => ({ kb: { notion: KB_CTX.kb.notion } });
        expect(await read(throwing("boom"), noConfluence)).toEqual(UNAVAILABLE);
        expect((await read(confluencePage({ key: "KB" }), noConfluence))?.status).toBe("ok");
      });

      test("an absent guardContext applies the guard and refuses", async () => {
        expect(
          await runner().read(
            confluenceWrite(toolId),
            opsByTool({ confluence_confluence_page_get: confluencePage({ key: "ENG" }) }),
          ),
        ).toEqual(KB_CHILD_REFUSED);
      });
    });
  }
});

// ---- D1: the Wave 4 fail-closed rule ------------------------------------------------------

const W4_REFUSED = { status: "refused", reason: WAVE4_BEFORE_REFUSAL } as const;

describe("Wave 4: an unread current state refuses the write (D1, fail closed)", () => {
  const ok = { summary: "old" };

  test("the reason is one fixed text that names no target", () => {
    expect(WAVE4_BEFORE_REFUSAL).toBe(
      "the current state of the target could not be read, so nothing was sent",
    );
  });

  test("a Wave 4 row with no reader, or no preview, is refused (defence in depth)", async () => {
    const { before: _b, ...noReader } = rowWith(READER, 4);
    const { preview: _p, ...noPreview } = rowWith(READER, 4);
    for (const r of [noReader as ConnectorWriteRow, noPreview as ConnectorWriteRow]) {
      const seen: PlannedAction[] = [];
      const runner = createBeforeStateRunner({ rows: [r] });
      expect(await runner.read(WRITE, opsReturning(ok, seen))).toEqual(W4_REFUSED);
      expect(seen).toEqual([]);
    }
  });

  test("a Wave 4 BOUND row with a preview and no reader is not refused here: its prepare step is the state", async () => {
    // `isModelOfferableRow` offers a Wave 4 row with `before` OR `bound`; the runner must agree, or
    // a bound-only row would be listed and then refused on every call.
    const { before: _b, ...noReader } = rowWith(READER, 4);
    const bound = {
      ...noReader,
      bound: { prepare: {} as never, binds: [] },
    } as unknown as ConnectorWriteRow;
    const seen: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [bound] });
    expect(await runner.read(WRITE, opsReturning(ok, seen))).toBeUndefined();
    expect(seen).toEqual([]);
    // Without a preview it is still refused, bound or not.
    const { preview: _p, ...boundNoPreview } = bound;
    const r2 = createBeforeStateRunner({ rows: [boundNoPreview as ConnectorWriteRow] });
    expect(await r2.read(WRITE, opsReturning(ok))).toEqual(W4_REFUSED);
  });

  test("a Wave 3 row with no reader is still not read at all", async () => {
    const { before: _b, ...noReader } = rowWith(READER, 3);
    const runner = createBeforeStateRunner({ rows: [noReader as ConnectorWriteRow] });
    expect(await runner.read(WRITE, opsReturning(ok))).toBeUndefined();
  });

  test("a Wave 4 action that is not origin model is not read at all (unchanged early return)", async () => {
    const { origin: _o, ...notModel } = WRITE;
    const seen: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [rowWith(READER, 4)] });
    expect(await runner.read(notModel, opsReturning(ok, seen))).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test("the reader tool unlisted at call time: refused, no read runs", async () => {
    const seen: PlannedAction[] = [];
    const runner = createBeforeStateRunner({ rows: [rowWith(READER, 4)] });
    expect(await runner.read(WRITE, opsReturning(ok, seen), { readerUnlisted: true })).toEqual(
      W4_REFUSED,
    );
    expect(seen).toEqual([]);
  });

  test("args returning undefined or throwing, and a non-object input: refused", async () => {
    const readers: BeforeStateReader[] = [
      { ...READER, args: () => undefined },
      {
        ...READER,
        args: () => {
          throw new Error("x");
        },
      },
    ];
    for (const reader of readers) {
      const runner = createBeforeStateRunner({ rows: [rowWith(reader, 4)] });
      expect(await runner.read(WRITE, opsReturning(ok))).toEqual(W4_REFUSED);
    }
    const odd: PlannedAction = {
      ...WRITE,
      payload: { mcpToolId: "jira_jira_issue_update", input: 7 },
    };
    const runner = createBeforeStateRunner({ rows: [rowWith(READER, 4)] });
    expect(await runner.read(odd, opsReturning(ok))).toEqual(W4_REFUSED);
  });

  test("a failed read, a not-found read, a policy-refused read: refused", async () => {
    const runner = createBeforeStateRunner({ rows: [rowWith(READER, 4)] });
    for (const err of ["boom", "Tool not found"]) {
      const ops: BeforeReadOps = {
        gate: async () => "proceed",
        dispatch: async () => {
          throw new Error(err);
        },
      };
      expect(await runner.read(WRITE, ops)).toEqual(W4_REFUSED);
    }
    const refusingGate: BeforeReadOps = {
      gate: async () => ({ status: "rejected", reason: BEFORE_READ_HITL_REFUSAL }),
      dispatch: async () => ok,
    };
    expect(await runner.read(WRITE, refusingGate)).toEqual(W4_REFUSED);
  });

  test("select throwing or returning undefined or a malformed list: refused", async () => {
    const selects: BeforeStateReader["select"][] = [
      () => {
        throw new Error("select boom");
      },
      () => undefined as unknown as [],
      () => "nope" as unknown as [],
      () => ["not an object"] as unknown as [],
    ];
    for (const select of selects) {
      const runner = createBeforeStateRunner({ rows: [rowWith({ ...READER, select }, 4)] });
      expect(await runner.read(WRITE, opsReturning(ok))).toEqual(W4_REFUSED);
    }
  });

  test("select showing nothing (no field, or only blank values): a Wave 4 row is refused, a Wave 2 row keeps its empty state", async () => {
    const empty: BeforeStateReader["select"][] = [
      () => [],
      () => [{ label: "Summary", value: "" }],
      () => [
        { label: "Summary", value: "  " },
        { label: "Status", value: "" },
      ],
    ];
    for (const select of empty) {
      const w4 = createBeforeStateRunner({ rows: [rowWith({ ...READER, select }, 4)] });
      expect(await w4.read(WRITE, opsReturning(ok))).toEqual(W4_REFUSED);
      const w2 = createBeforeStateRunner({ rows: [rowWith({ ...READER, select }, 2)] });
      expect((await w2.read(WRITE, opsReturning(ok)))?.status).toBe("ok");
    }
    const some = createBeforeStateRunner({
      rows: [
        rowWith(
          {
            ...READER,
            select: () => [
              { label: "A", value: "" },
              { label: "B", value: "x" },
            ],
          },
          4,
        ),
      ],
    });
    expect((await some.read(WRITE, opsReturning(ok)))?.status).toBe("ok");
  });

  test("a read that times out: refused", async () => {
    const clock = fakeClock();
    const runner = createBeforeStateRunner({ rows: [rowWith(READER, 4)], timers: clock.timers });
    const pending = runner.read(WRITE, {
      gate: async () => "proceed",
      dispatch: () => new Promise(() => {}),
    });
    await Promise.resolve();
    clock.advance(BEFORE_STATE_TIMEOUT_MS);
    expect(await pending).toEqual(W4_REFUSED);
  });

  test("a second read failing refuses on Wave 4, and is only unavailable on its Wave 3 twin", async () => {
    const failing = (): BeforeReadOps =>
      opsByTool({ ...READS_OK, jira_jira_issue_get: throwing("x") });
    const w3 = createBeforeStateRunner({ rows: [transitionRow(twoReadReader(newSeen()))] });
    expect(await w3.read(TRANSITION, failing())).toEqual({
      status: "unavailable",
      reason: "failed",
    });
    const w4Row: ConnectorWriteRow = { ...transitionRow(twoReadReader(newSeen())), wave: 4 };
    const w4 = createBeforeStateRunner({ rows: [w4Row] });
    expect(await w4.read(TRANSITION, failing())).toEqual(W4_REFUSED);
  });

  test("a Wave 3 row with the same failures is unavailable, never refused", async () => {
    const runner = createBeforeStateRunner({
      rows: [rowWith({ ...READER, args: () => undefined }, 3)],
    });
    expect(await runner.read(WRITE, opsReturning(ok))).toEqual({
      status: "unavailable",
      reason: "failed",
    });
  });

  test("a Wave 4 row whose reads succeed returns the fields", async () => {
    const runner = createBeforeStateRunner({ rows: [rowWith(READER, 4)] });
    expect(await runner.read(WRITE, opsReturning(ok))).toEqual({
      status: "ok",
      fields: [{ label: "Summary", value: "old" }],
    });
  });

  test("a guard that applies keeps its OWN reason on every failure and on a false allows", async () => {
    const guard: BeforeStateGuard = {
      reason: GUARD_REASON,
      appliesTo: () => true,
      allows: (reply) => (reply as { summary?: unknown }).summary === "old",
    };
    const runner = createBeforeStateRunner({ rows: [rowWith({ ...READER, guard }, 4)] });
    expect(await runner.read(WRITE, opsReturning({ summary: "other" }))).toEqual(REFUSED);
    expect(await runner.read(WRITE, opsReturning(ok), { readerUnlisted: true })).toEqual(REFUSED);
    const throwingOps: BeforeReadOps = {
      gate: async () => "proceed",
      dispatch: async () => {
        throw new Error("x");
      },
    };
    expect(await runner.read(WRITE, throwingOps)).toEqual(REFUSED);
    expect(await runner.read(WRITE, opsReturning(ok))).toEqual({
      status: "ok",
      fields: [{ label: "Summary", value: "old" }],
    });
  });

  test("a guard that does not apply to this input still fails closed on a Wave 4 row, with the fixed reason", async () => {
    const guard: BeforeStateGuard = {
      reason: GUARD_REASON,
      appliesTo: () => false,
      allows: () => true,
    };
    const runner = createBeforeStateRunner({
      rows: [rowWith({ ...READER, guard, args: () => undefined }, 4)],
    });
    expect(await runner.read(WRITE, opsReturning(ok))).toEqual(W4_REFUSED);
  });
});
