// packages/gateway/src/engine/executor-confirm.test.ts
// Phase 9.7 D0a: type-to-confirm at the executor gate (I53, I20, static D41). Every branch the
// confirm phases add to `executor.ts` is covered here (the file is pinned at 100%).
import { describe, expect, test } from "bun:test";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  type ConnectorWriteRow,
  row as makeRow,
  withConfirm,
} from "../connectors/connector-writes/types.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { ConsentCoordinatorImpl } from "../ipc/consent.ts";
import type { JsonRpcNotification } from "../ipc/jsonrpc.ts";
import type { BeforeStateRunner } from "./before-state.ts";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";
import {
  bindConsentChannel,
  CONFIRM_MISMATCH_REASON,
  CONFIRM_UNSUPPORTED_REASON,
  type ExecutorDelegationDep,
  HITL_REQUIRED,
  NO_POLICY_OVERLAY,
  TOOL_TYPE_MISMATCH_REASON,
  ToolExecutor,
} from "./executor.ts";
import type {
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  ConsentChannel,
  PlannedAction,
} from "./types.ts";

const TEXT = "github/merge acme/api#42";

/** A real Wave 4 mesh row: the act door's shape (`mcpToolId` + `input`). */
const MERGE: PlannedAction = {
  type: "github.pr.merge",
  payload: { mcpToolId: "github_pr_merge", input: { owner: "acme", repo: "api", pullNumber: 42 } },
};

/** A real Wave 4 `write`-transport row: found by action type alone, flat payload. */
const SNOWFLAKE: PlannedAction = {
  type: "snowflake.comment.set",
  payload: { object: "DB.S.T", comment: "hello" },
};

interface Harness {
  readonly exec: ToolExecutor;
  readonly plain: string[];
  readonly confirmed: ConfirmedApprovalRequest[];
  readonly audits: Array<{ hitlStatus: string; actionJson: string }>;
  readonly egress: EgressEntry[];
  readonly dispatched: PlannedAction[];
}

function harness(opts: {
  /** The confirm channel's answer; `"absent"` builds a channel with no `requestConfirmedApproval`. */
  readonly confirmAnswer?: Omit<ConfirmedApprovalResult, "answerSource"> | "absent";
  readonly plainAnswer?: boolean;
  readonly delegation?: ExecutorDelegationDep;
  readonly runner?: BeforeStateRunner;
}): Harness {
  const plain: string[] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const audits: Array<{ hitlStatus: string; actionJson: string }> = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const answer = opts.confirmAnswer ?? { approved: true, typed: TEXT };
  const consent: ConsentChannel = {
    requestApproval: async (prompt) => {
      plain.push(prompt);
      return { approved: opts.plainAnswer ?? true, answerSource: "human" as const };
    },
    ...(answer === "absent"
      ? {}
      : {
          requestConfirmedApproval: async (req: ConfirmedApprovalRequest) => {
            confirmed.push(req);
            return { ...answer, answerSource: "human" as const };
          },
        }),
  };
  const sink: EgressSink = { append: (e) => egress.push(e) };
  const exec = new ToolExecutor(
    consent,
    { recordAudit: (e) => audits.push({ hitlStatus: e.hitlStatus, actionJson: e.actionJson }) },
    {
      dispatch: async (a) => {
        dispatched.push(a);
        return { ok: true };
      },
    },
    opts.delegation,
    sink,
    NO_POLICY_OVERLAY,
    undefined,
    opts.runner,
  );
  return { exec, plain, confirmed, audits, egress, dispatched };
}

function auditOf(h: Harness): Record<string, unknown> {
  const last = h.audits.at(-1);
  if (last === undefined) throw new Error("no audit row");
  return JSON.parse(last.actionJson) as Record<string, unknown>;
}

/** A runner over synthetic rows (the executor reads `rows` for the Wave 4 decision). */
function runnerOf(...rows: ConnectorWriteRow[]): BeforeStateRunner {
  return { rows, read: async () => undefined };
}

const SYNTH_NO_CONFIRM = makeRow("snow_cmt", "snowflake.comment.set", "write", 4);
const SYNTH = withConfirm(makeRow("snow_cmt", "snowflake.comment.set", "write", 4), {
  template: "{object}",
});

describe("a non-Wave-4 HITL write keeps the plain prompt (a)", () => {
  test("requestApproval is called, requestConfirmedApproval never", async () => {
    const h = harness({});
    const res = await h.exec.execute({ type: "email.send", payload: {} });
    expect(res.status).toBe("ok");
    expect(h.plain).toHaveLength(1);
    expect(h.confirmed).toHaveLength(0);
    expect("confirm" in auditOf(h)).toBe(false);
  });

  test("a type naming a tool that no connector-write row owns keeps its plain path (I3)", async () => {
    const h = harness({});
    const res = await h.exec.execute({
      type: "search.run",
      payload: { mcpToolId: "search_run", input: { q: "a" } },
    });
    expect(res.status).toBe("ok");
    expect(h.plain).toHaveLength(0);
    expect(h.confirmed).toHaveLength(0);
  });
});

describe("a tool runs only under its own action type (I53 pairing)", () => {
  const INPUT = { owner: "a", repo: "b", pullNumber: 1 };
  const spellings = ["github_pr_merge", "github_github_pr_merge"];

  for (const mcpToolId of spellings) {
    test(`a non-HITL type naming a Wave 4 tool (${mcpToolId}) is refused: nothing dispatched, audited blocked`, async () => {
      const h = harness({});
      const res = await h.exec.execute({
        type: "search.run",
        payload: { mcpToolId, input: INPUT },
      });
      expect(res).toEqual({ status: "rejected", reason: TOOL_TYPE_MISMATCH_REASON });
      expect(h.dispatched).toHaveLength(0);
      expect(h.plain).toHaveLength(0);
      expect(h.confirmed).toHaveLength(0);
      expect(h.audits.at(-1)?.hitlStatus).toBe("rejected");
      expect(auditOf(h)["hitlRejectReason"]).toBe(TOOL_TYPE_MISMATCH_REASON);
      expect(h.egress.at(-1)?.resultStatus).toBe("blocked");
    });

    test(`a HITL type with no Wave 4 row naming it (${mcpToolId}) is refused before any prompt`, async () => {
      const h = harness({ plainAnswer: true });
      const res = await h.exec.execute({
        type: "pipeline.trigger",
        payload: { mcpToolId, input: INPUT },
      });
      expect(res).toEqual({ status: "rejected", reason: TOOL_TYPE_MISMATCH_REASON });
      expect(h.dispatched).toHaveLength(0);
      expect(h.plain).toHaveLength(0);
      expect(h.confirmed).toHaveLength(0);
    });
  }

  test("a Wave 4 type naming another Wave 4 type's tool is refused too", async () => {
    const h = harness({});
    const res = await h.exec.execute({
      type: "github.pr.merge",
      payload: { mcpToolId: "github_branch_delete", input: INPUT },
    });
    expect(res).toEqual({ status: "rejected", reason: TOOL_TYPE_MISMATCH_REASON });
    expect(h.confirmed).toHaveLength(0);
  });
});

describe("a Wave 4 write needs the exact typed text (b-f)", () => {
  test("exact text on a capable channel: dispatched, audited confirm matched, plain prompt never used", async () => {
    const h = harness({});
    const res = await h.exec.execute(MERGE);
    expect(res.status).toBe("ok");
    expect(h.dispatched).toHaveLength(1);
    expect(h.plain).toHaveLength(0);
    expect(h.confirmed).toHaveLength(1);
    expect(h.confirmed[0]?.confirmText).toBe(TEXT);
    expect(h.confirmed[0]?.actionType).toBe("github.pr.merge");
    expect(auditOf(h)["confirm"]).toBe("matched");
    expect(h.audits.at(-1)?.hitlStatus).toBe("approved");
    expect(h.egress.at(-1)?.hitlStatus).toBe("approved");
    expect(h.egress.at(-1)?.resultStatus).toBe("authorized");
  });

  test("a Windows working directory (backslashes) is typeable: the exact text approves", async () => {
    // A row with a plain confirm target (the iac applies are plan-bound since D2 and need their
    // capabilities; their own tests are `executor-iac-rows.test.ts`): the character set is the point.
    const wd = `C:${String.fromCharCode(92)}infra${String.fromCharCode(92)}prod`;
    const text = `kubernetes/delete prod/shop/${wd}`;
    const h = harness({ confirmAnswer: { approved: true, typed: text } });
    const res = await h.exec.execute({
      type: "kubernetes.pod.delete",
      payload: { context: "prod", namespace: "shop", podName: wd },
    });
    expect(res.status).toBe("ok");
    expect(h.confirmed[0]?.confirmText).toBe(text);
    expect(auditOf(h)["confirm"]).toBe("matched");
  });

  test("the prompt ends with the fixed line and the details still carry the preview", async () => {
    const h = harness({ confirmAnswer: { approved: true, typed: "snowflake/set comment DB.S.T" } });
    await h.exec.execute(SNOWFLAKE);
    const req = h.confirmed[0];
    expect(req?.confirmText).toBe("snowflake/set comment DB.S.T");
    expect(req?.prompt.endsWith("\n\nTo approve, type exactly: snowflake/set comment DB.S.T")).toBe(
      true,
    );
    expect(req?.details?.["kind"]).toBe("connector-write");
  });

  test("wrong text: rejected, never dispatched, audited confirm mismatched", async () => {
    const h = harness({ confirmAnswer: { approved: true, typed: "github/merge acme/api#43" } });
    const res = await h.exec.execute(MERGE);
    expect(res).toEqual({ status: "rejected", reason: CONFIRM_MISMATCH_REASON });
    expect(h.dispatched).toHaveLength(0);
    expect(auditOf(h)["confirm"]).toBe("mismatched");
    expect(h.audits.at(-1)?.hitlStatus).toBe("rejected");
    expect(h.egress.at(-1)?.resultStatus).toBe("blocked");
    expect(auditOf(h)["answerSource"]).toBe("human");
  });

  test("approved with empty typed (an old client): mismatched", async () => {
    const h = harness({ confirmAnswer: { approved: true, typed: "" } });
    const res = await h.exec.execute(MERGE);
    expect(res.status).toBe("rejected");
    expect(auditOf(h)["confirm"]).toBe("mismatched");
  });

  test("a different case is a mismatch (no case folding)", async () => {
    const h = harness({ confirmAnswer: { approved: true, typed: TEXT.toUpperCase() } });
    expect((await h.exec.execute(MERGE)).status).toBe("rejected");
    expect(auditOf(h)["confirm"]).toBe("mismatched");
  });

  test("leading or trailing whitespace is a mismatch (no trimming)", async () => {
    for (const typed of [` ${TEXT}`, `${TEXT} `, `${TEXT}\n`]) {
      const h = harness({ confirmAnswer: { approved: true, typed } });
      expect((await h.exec.execute(MERGE)).status).toBe("rejected");
      expect(auditOf(h)["confirm"]).toBe("mismatched");
    }
  });

  test("an interactive decline is a decline with no confirm audit field", async () => {
    const h = harness({ confirmAnswer: { approved: false, typed: TEXT } });
    const res = await h.exec.execute(MERGE);
    expect(res).toEqual({ status: "rejected", reason: "User declined consent gate." });
    expect("confirm" in auditOf(h)).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("a channel without requestConfirmedApproval cannot approve Wave 4 (g)", () => {
  test("rejected as unsupported_channel; requestApproval NEVER called", async () => {
    const h = harness({ confirmAnswer: "absent" });
    const res = await h.exec.execute(MERGE);
    expect(res).toEqual({ status: "rejected", reason: CONFIRM_UNSUPPORTED_REASON });
    expect(h.plain).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(auditOf(h)["confirm"]).toBe("unsupported_channel");
    expect(h.egress.at(-1)?.resultStatus).toBe("blocked");
    // No prompt was shown, so there is no answer source to record.
    expect("answerSource" in auditOf(h)).toBe(false);
  });
});

describe("the gate fails closed before any prompt (h, i)", () => {
  test("a Wave 4 row with no confirm target is refused, nobody is asked", async () => {
    const h = harness({ runner: runnerOf(SYNTH_NO_CONFIRM) });
    const res = await h.exec.execute(SNOWFLAKE);
    expect(res).toEqual({
      status: "rejected",
      reason: "confirm: row declares no confirmation target",
    });
    expect(h.plain).toHaveLength(0);
    expect(h.confirmed).toHaveLength(0);
    expect(auditOf(h)["hitlRejectReason"]).toBe("confirm: row declares no confirmation target");
  });

  test("an unrenderable target (unset, (not set), non-ASCII, over 200 characters) is refused before the prompt", async () => {
    const inputs: Array<Record<string, unknown>> = [
      {},
      { object: "(not set)" },
      { object: "café" },
      { object: "x".repeat(300) },
    ];
    for (const payload of inputs) {
      const h = harness({ runner: runnerOf(SYNTH) });
      const res = await h.exec.execute({ type: "snowflake.comment.set", payload });
      expect(res.status).toBe("rejected");
      expect(h.plain).toHaveLength(0);
      expect(h.confirmed).toHaveLength(0);
      expect(String(auditOf(h)["hitlRejectReason"]).startsWith("confirm: ")).toBe(true);
      expect(h.dispatched).toHaveLength(0);
    }
  });

  test("a Wave 4 action with no payload at all is refused (nothing to confirm)", async () => {
    const h = harness({});
    const res = await h.exec.execute({ type: "snowflake.comment.set" });
    expect(res.status).toBe("rejected");
    expect(h.confirmed).toHaveLength(0);
    expect(String(auditOf(h)["hitlRejectReason"]).startsWith("confirm: ")).toBe(true);
  });

  test("an action whose mcpToolId names another tool than its type's row is refused", async () => {
    const h = harness({});
    const res = await h.exec.execute({
      type: "github.pr.merge",
      payload: {
        mcpToolId: "github_branch_delete",
        input: { owner: "a", repo: "b", branch: "x" },
      },
    });
    expect(res).toEqual({ status: "rejected", reason: TOOL_TYPE_MISMATCH_REASON });
    expect(h.confirmed).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });

  test("a Wave 4 action whose mcpToolId names no row at all is refused by the confirm phase", async () => {
    const h = harness({});
    const res = await h.exec.execute({
      type: "github.pr.merge",
      payload: { mcpToolId: "github_something_else", input: { owner: "a", repo: "b" } },
    });
    expect(res).toEqual({
      status: "rejected",
      reason: "confirm: action does not name its own tool",
    });
    expect(h.confirmed).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });

  test("a mesh Wave 4 type with no mcpToolId (a ChatOps-shaped flat payload) renders from the payload", async () => {
    const h = harness({});
    const res = await h.exec.execute({
      type: "github.pr.merge",
      payload: { owner: "acme", repo: "api", pullNumber: 42 },
    });
    expect(res.status).toBe("ok");
    expect(h.confirmed[0]?.confirmText).toBe(TEXT);
  });
});

describe("delegation (j, k) - I20", () => {
  const store = {
    activeDelegateePeer: () => "peer:bob",
    activeDelegateFor: (_k: string, _v: string, peer: string) => peer === "peer:bob",
  };
  function delegation(extra: Partial<ExecutorDelegationDep>): {
    dep: ExecutorDelegationDep;
    calls: string[];
  } {
    const calls: string[] = [];
    const dep: ExecutorDelegationDep = {
      store,
      isOperatorValid: () => true,
      requestRemote: async () => {
        calls.push("requestRemote");
        return { kind: "answered", peerId: "peer:bob", approved: true };
      },
      ...extra,
    };
    return { dep, calls };
  }

  test("a delegate without requestRemoteConfirmed is never asked: the local owner types", async () => {
    const d = delegation({});
    const h = harness({ delegation: d.dep });
    const res = await h.exec.execute(MERGE);
    expect(res.status).toBe("ok");
    expect(d.calls).toEqual([]);
    expect(h.confirmed).toHaveLength(1);
  });

  test("a delegate's answer with the exact typed text approves, with no local prompt", async () => {
    const asked: Array<[string, string]> = [];
    const d = delegation({
      requestRemoteConfirmed: async (t, c): Promise<RemoteApprovalOutcome> => {
        asked.push([t, c]);
        return { kind: "answered", peerId: "peer:bob", approved: true, typed: TEXT };
      },
    });
    const h = harness({ delegation: d.dep });
    const res = await h.exec.execute(MERGE);
    expect(res.status).toBe("ok");
    expect(asked).toEqual([["github.pr.merge", TEXT]]);
    expect(h.confirmed).toHaveLength(0);
    expect(auditOf(h)["confirm"]).toBe("matched");
  });

  test("a delegate answering with the wrong typed text is declined, and the owner is not asked", async () => {
    const d = delegation({
      requestRemoteConfirmed: async (): Promise<RemoteApprovalOutcome> => ({
        kind: "answered",
        peerId: "peer:bob",
        approved: true,
        typed: "github/merge acme/api#41",
      }),
    });
    const h = harness({ delegation: d.dep });
    const res = await h.exec.execute(MERGE);
    expect(res.status).toBe("rejected");
    expect(h.confirmed).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(auditOf(h)["confirm"]).toBe("mismatched");
  });

  test("a delegate answering approved with no typed text is declined", async () => {
    const d = delegation({
      requestRemoteConfirmed: async (): Promise<RemoteApprovalOutcome> => ({
        kind: "answered",
        peerId: "peer:bob",
        approved: true,
      }),
    });
    const h = harness({ delegation: d.dep });
    expect((await h.exec.execute(MERGE)).status).toBe("rejected");
    expect(auditOf(h)["confirm"]).toBe("mismatched");
  });

  test("a delegate declining is a decline with no confirm field", async () => {
    const d = delegation({
      requestRemoteConfirmed: async (): Promise<RemoteApprovalOutcome> => ({
        kind: "answered",
        peerId: "peer:bob",
        approved: false,
        typed: TEXT,
      }),
    });
    const h = harness({ delegation: d.dep });
    expect((await h.exec.execute(MERGE)).status).toBe("rejected");
    expect("confirm" in auditOf(h)).toBe(false);
  });

  test("a peer that is not the active delegate falls back to the owner, typed text and all (I20)", async () => {
    const d = delegation({
      requestRemoteConfirmed: async (): Promise<RemoteApprovalOutcome> => ({
        kind: "answered",
        peerId: "peer:mallory",
        approved: true,
        typed: TEXT,
      }),
    });
    const h = harness({ delegation: d.dep });
    const res = await h.exec.execute(MERGE);
    expect(res.status).toBe("ok");
    expect(h.confirmed).toHaveLength(1);
  });

  test("a failed delegate attempt leaves no confirm verdict: an owner decline audits no mismatch", async () => {
    const d = delegation({
      requestRemoteConfirmed: async (): Promise<RemoteApprovalOutcome> => ({
        kind: "answered",
        peerId: "peer:mallory",
        approved: true,
        typed: "not the confirm text",
      }),
    });
    const h = harness({ delegation: d.dep, confirmAnswer: { approved: false, typed: "" } });
    const res = await h.exec.execute(MERGE);
    expect(res).toEqual({ status: "rejected", reason: "User declined consent gate." });
    expect("confirm" in auditOf(h)).toBe(false);
  });

  test("an identity-invalid delegate falls back to the owner", async () => {
    const d = delegation({
      isOperatorValid: () => false,
      requestRemoteConfirmed: async (): Promise<RemoteApprovalOutcome> => ({
        kind: "answered",
        peerId: "peer:bob",
        approved: true,
        typed: TEXT,
      }),
    });
    const h = harness({ delegation: d.dep });
    expect((await h.exec.execute(MERGE)).status).toBe("ok");
    expect(h.confirmed).toHaveLength(1);
  });

  test("a delegate timeout falls back to the owner", async () => {
    const d = delegation({
      requestRemoteConfirmed: async (): Promise<RemoteApprovalOutcome> => ({ kind: "timeout" }),
    });
    const h = harness({ delegation: d.dep });
    expect((await h.exec.execute(MERGE)).status).toBe("ok");
    expect(h.confirmed).toHaveLength(1);
  });

  test("a plain (non-Wave-4) write still goes through requestRemote, unchanged", async () => {
    const d = delegation({
      requestRemoteConfirmed: async () => {
        throw new Error("must not be called");
      },
    });
    const h = harness({ delegation: d.dep });
    const res = await h.exec.execute({ type: "email.send", payload: {} });
    expect(res.status).toBe("ok");
    expect(d.calls).toEqual(["requestRemote"]);
  });

  test("a model-origin Wave 4 action keeps its fallback: the delegate is never asked", async () => {
    const asked: string[] = [];
    const d = delegation({
      requestRemoteConfirmed: async (): Promise<RemoteApprovalOutcome> => {
        asked.push("x");
        return { kind: "answered", peerId: "peer:bob", approved: true, typed: TEXT };
      },
    });
    const h = harness({ delegation: d.dep });
    const res = await h.exec.execute({ ...MERGE, origin: "model" });
    expect(res.status).toBe("ok");
    expect(asked).toEqual([]);
    expect(h.confirmed).toHaveLength(1);
  });

  test("a user-MCP type keeps its fallback and its plain prompt", async () => {
    const h = harness({ delegation: delegation({}).dep });
    const res = await h.exec.execute({ type: "mcp_user1.tool.call", payload: { x: 1 } });
    expect(res.status).toBe("ok");
    expect(h.plain).toHaveLength(1);
    expect(h.confirmed).toHaveLength(0);
  });
});

describe("the frozen HITL set is untouched (n)", () => {
  test("HITL_REQUIRED keeps its size and holds every Wave 4 type", () => {
    expect(HITL_REQUIRED.size).toBe(183);
    for (const r of CONNECTOR_WRITE_ROWS.filter((x) => x.wave === 4)) {
      expect(HITL_REQUIRED.has(r.actionType), r.actionType).toBe(true);
    }
  });
});

describe("bindConsentChannel carries the confirmation over the consent wire", () => {
  function wired(typed: string | undefined): {
    exec: ToolExecutor;
    sent: JsonRpcNotification[];
    dispatched: PlannedAction[];
  } {
    const sent: JsonRpcNotification[] = [];
    const dispatched: PlannedAction[] = [];
    let coordinator: ConsentCoordinatorImpl;
    coordinator = new ConsentCoordinatorImpl(() => (n) => {
      sent.push(n);
      const requestId = String((n.params as Record<string, unknown>)["requestId"]);
      queueMicrotask(() =>
        coordinator.handleRespond("c1", {
          requestId,
          approved: true,
          ...(typed === undefined ? {} : { typed }),
        }),
      );
    });
    const exec = new ToolExecutor(
      bindConsentChannel(coordinator, "c1"),
      { recordAudit: () => {} },
      {
        dispatch: async (a) => {
          dispatched.push(a);
          return { ok: true };
        },
      },
      undefined,
      { append: () => {} },
    );
    return { exec, sent, dispatched };
  }

  test("a Wave 4 write: consent.request carries confirmText and the fixed line; the typed text approves", async () => {
    const w = wired(TEXT);
    expect((await w.exec.execute(MERGE)).status).toBe("ok");
    const p = w.sent[0]?.params as Record<string, unknown>;
    expect(p["confirmText"]).toBe(TEXT);
    expect(String(p["prompt"]).endsWith(`To approve, type exactly: ${TEXT}`)).toBe(true);
    expect(w.dispatched).toHaveLength(1);
  });

  test("an old client that answers y/N with no typed text is a mismatch", async () => {
    const w = wired(undefined);
    expect((await w.exec.execute(MERGE)).status).toBe("rejected");
    expect(w.dispatched).toHaveLength(0);
  });

  test("a plain write over the same channel carries no confirmText", async () => {
    const w = wired(undefined);
    expect((await w.exec.execute({ type: "email.send", payload: {} })).status).toBe("ok");
    expect(Object.keys(w.sent[0]?.params as object)).not.toContain("confirmText");
  });
});
