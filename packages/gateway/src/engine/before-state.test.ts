/**
 * The before-state reader (spec § 5.4) on its own and through the real `ToolExecutor`. Every row
 * here is SYNTHETIC: no production row uses a second read (`also`) or a guard (B2a ships the
 * mechanism only); the B1 production readers are tested in `before-reader.test.ts`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
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
      return true;
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
    opts.withRunner === false
      ? undefined
      : createBeforeStateRunner({ rows: opts.rows ?? [rowWith(READER)], ...opts.runner }),
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
          return true;
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
      createBeforeStateRunner({ rows: [rowWith(READER)], timers: t.timers }),
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
