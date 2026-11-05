/**
 * The before-state reader (spec § 5.4) on its own and through the real `ToolExecutor`. Every row
 * here is SYNTHETIC: no production row has a `before` reader in B0b.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
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
  beforeReadActionType,
  classifyBeforeStateError,
  createBeforeStateRunner,
  isBeforeReadActionType,
} from "./before-state.ts";
import { type ExecutorPolicyDep, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

const SECRET_MARK = "BEFORE-REPLY-MARKER-7f3a";

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
  test("the read type is <service>.before.read and is recognised", () => {
    expect(beforeReadActionType("jira")).toBe("jira.before.read");
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
        if (i === 0) resolveReply({ summary: SECRET_MARK });
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
        ? (opts.readReply ?? { summary: `old ${SECRET_MARK}` })
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
      fields: [{ label: "Summary", value: `old ${SECRET_MARK}` }],
    });
  });

  test("the read's reply never reaches the result handed back, the write's audit row or any egress row", async () => {
    const { exec, seen } = executorHarness({});
    const out = await exec.execute(WRITE);
    expect(JSON.stringify(out)).not.toContain(SECRET_MARK);
    for (const a of seen.audits) expect(a.actionJson).not.toContain(SECRET_MARK);
    for (const e of seen.egress) expect(JSON.stringify(e)).not.toContain(SECRET_MARK);
    // The control: the reply DID reach the owner's prompt details.
    expect(JSON.stringify(seen.details[0])).toContain(SECRET_MARK);
  });

  test("without a runner (every other executor): no read, and the prompt has no before", async () => {
    const { exec, seen } = executorHarness({ withRunner: false });
    await exec.execute(WRITE);
    expect(seen.dispatched.map((a) => a.type)).toEqual(["jira.issue.update"]);
    expect(seen.audits).toHaveLength(1);
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
