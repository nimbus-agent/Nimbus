import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { row, withConfirm } from "../connectors/connector-writes/types.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { isBeforeReadActionType, WAVE4_BEFORE_REFUSAL } from "../engine/before-state.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import type { AnswerSource, PlannedAction } from "../engine/types.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import { APPROVER_BY_KIND } from "../mcp-sink/capture-client-policy.ts";
import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import { createMockVault } from "../vault/mock.ts";
import {
  APPROVALS_METHODS,
  dispatchApprovalsRpc,
  humanOnlyConsent,
  NON_HUMAN_REASON,
} from "./approvals-rpc.ts";
import { type CaptureRpcCtx, dispatchCaptureRpc } from "./capture-rpc.ts";
import type { ConsentCoordinator } from "./consent.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { createStreamRegistry } from "./engine-ask-stream.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "./server/context.ts";
import { tryDispatchPhase4Rpc } from "./server/dispatchers.ts";
import type { CreateIpcServerOptions } from "./server/options.ts";

const KINDS: readonly ClientKind[] = [
  "cli",
  "mcp",
  "ui",
  "http",
  "chatops",
  "fleet",
  "push",
  "unknown",
];
const OWNER = { clientId: "o", kind: "cli" as const };
const HOUR = 3_600_000;

class SpyStore extends CaptureStore {
  gets = 0;
  override get(id: string) {
    this.gets++;
    return super.get(id);
  }
}

/** A coordinator that answers every request the same way and records what it was asked. */
class FakeConsent implements ConsentCoordinator {
  prompts: string[] = [];
  confirmTexts: string[] = [];
  approved = true;
  source: AnswerSource = "human";
  typed = "";
  requestConsent(_c: string, p: { prompt: string }) {
    this.prompts.push(p.prompt);
    return Promise.resolve({ approved: this.approved, answerSource: this.source });
  }
  requestConfirmedConsent(_c: string, p: { prompt: string; confirmText: string }) {
    this.prompts.push(p.prompt);
    this.confirmTexts.push(p.confirmText);
    return Promise.resolve({
      approved: this.approved,
      typed: this.typed,
      answerSource: this.source,
    });
  }
  rejectAllPending(): void {}
  pendingCount(): number {
    return 0;
  }
}

let db: Database;
let store: SpyStore;
let dispatched: PlannedAction[];
let ctx: CaptureRpcCtx;
let sinkOn: boolean;

function writesOf(): PlannedAction[] {
  return dispatched.filter((a) => !isBeforeReadActionType(a.type));
}

function insertAction(
  id: string,
  over: { actionType?: string; summary?: string; label?: string | null; input?: object } = {},
): void {
  store.insert({
    id,
    kind: "action",
    state: "proposed",
    itemId: null,
    payloadJson: JSON.stringify({
      actionType: over.actionType ?? "slack.message.post",
      input: over.input ?? { channel: "C9999ZZZZ", text: "hi" },
      summary: over.summary ?? "why",
    }),
    payloadBytes: 10,
    clientLabel: over.label === undefined ? "agent" : over.label,
    sessionId: "agent-conn",
    createdAt: 500,
    expiresAt: 500 + HOUR,
    agentDoorLegacy: false,
  });
}

function makeCtx(extra: Partial<NonNullable<CaptureRpcCtx["act"]>> = {}): CaptureRpcCtx {
  const gate: CaptureGateDeps = {
    db,
    store,
    capability: () =>
      sinkOn
        ? resolveCaptureCapability(
            {
              ok: true,
              config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
            },
            { capabilitiesDisabled: new Set() },
          )
        : resolveCaptureCapability(
            { ok: true, config: DEFAULT_MCP_SINK_CONFIG },
            { capabilitiesDisabled: new Set() },
          ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => "cap_new",
    now: () => 1_000,
    classifyAction: () => ({ kind: "proposable" }),
    isServiceConfigured: () => Promise.resolve(true),
    actionDestinationRefusal: () => undefined,
  };
  return {
    gate,
    act: {
      dispatcher: {
        dispatch: (a) => {
          dispatched.push(a);
          return Promise.resolve({ url: "https://x.example/1" });
        },
      },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
      getTribalKbConfig: () => undefined,
      ...extra,
    },
  };
}

async function call(
  method: string,
  params: unknown,
  caller: { clientId: string; kind: ClientKind } = OWNER,
  consent?: ConsentCoordinator,
  c: CaptureRpcCtx = ctx,
): Promise<unknown> {
  const out = await dispatchApprovalsRpc(method, params, c, caller, consent);
  if (out.kind === "miss") throw new Error(`miss ${method}`);
  return out.value;
}

async function rpcError(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; rpcData?: { code?: string } };
    return {
      message: err.message,
      ...(err.rpcData?.code === undefined ? {} : { code: err.rpcData.code }),
    };
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  store = new SpyStore(db);
  dispatched = [];
  sinkOn = true;
  ctx = makeCtx();
});
afterEach(() => db.close());

describe("who may use approvals.*", () => {
  test("APPROVER_BY_KIND is true exactly for cli and ui", () => {
    for (const k of KINDS) expect(APPROVER_BY_KIND[k]).toBe(k === "cli" || k === "ui");
  });
  test.each(KINDS.filter((k) => k !== "cli" && k !== "ui"))(
    "%s is refused on all four methods and the gate is never reached",
    async (kind) => {
      insertAction("cap_a");
      const before = store.gets;
      for (const m of APPROVALS_METHODS) {
        const e = await rpcError(
          call(m, { id: "cap_a" }, { clientId: "x", kind }, new FakeConsent()),
        );
        expect(e.code, `${kind} ${m}`).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
      }
      expect(store.gets).toBe(before);
      expect(store.get("cap_a")?.state).toBe("proposed");
    },
  );
  test("ui is accepted like cli", async () => {
    insertAction("cap_a");
    const out = (await call("approvals.list", {}, { clientId: "u", kind: "ui" })) as {
      proposals: unknown[];
    };
    expect(out.proposals).toHaveLength(1);
  });
});

describe("approvals.list and approvals.get", () => {
  const RLO = String.fromCodePoint(0x202e);
  const BS = String.fromCharCode(92);
  test("list returns the escaped one-line view with the wave and typedConfirm of the real row", async () => {
    insertAction("cap_a", {
      label: 'a"\nType: x',
      summary: `tell them${RLO}now`,
    });
    insertAction("cap_u", { actionType: "mcp_x.y", input: { a: 1 } });
    const out = (await call("approvals.list", {})) as {
      proposals: Array<Record<string, unknown>>;
    };
    // slack_message_post is a wave 2 row without a confirm target (read from the table).
    const slack = CONNECTOR_WRITE_ROWS.find((r) => r.toolId === "slack_message_post");
    expect([slack?.wave, slack?.confirm]).toEqual([2, undefined]);
    expect(out.proposals[0]).toEqual({
      id: "cap_a",
      actionType: "slack.message.post",
      legacy: false,
      wave: 2,
      typedConfirm: false,
      label: String.raw`a\"\u000aType: x`,
      labelSource: "declared",
      summary: `tell them${BS}u202enow`,
      createdAt: 500,
      expiresAt: 500 + HOUR,
    });
    expect(out.proposals[1]).toMatchObject({
      id: "cap_u",
      wave: null,
      typedConfirm: false,
    });
  });
  test("a row declared wave 4 with a confirm target reads typedConfirm", async () => {
    insertAction("cap_a");
    const synthetic = withConfirm(row("slack_message_post", "slack.message.post", "write", 4), {
      template: "{channel}",
    });
    const c = makeCtx({ beforeStateRows: [synthetic] });
    const out = (await call("approvals.list", {}, OWNER, undefined, c)) as {
      proposals: Array<{ wave: number; typedConfirm: boolean }>;
    };
    expect(out.proposals[0]).toMatchObject({ wave: 4, typedConfirm: true });
  });
  test("get adds the escaped verbatim input and the note about the preview", async () => {
    insertAction("cap_a", { input: { text: `x${RLO}y` } });
    const out = (await call("approvals.get", { id: "cap_a" })) as {
      inputLines: string[];
      note: string;
      id: string;
    };
    expect(out.id).toBe("cap_a");
    expect(out.inputLines.join("\n")).toContain(`x${BS}u202ey`);
    expect(out.inputLines.join("\n")).not.toContain(RLO);
    expect(out.inputLines.join("\n")).not.toContain("Input (verbatim");
    expect(out.note).toBe(
      "the typed preview and the target's current state appear when you approve",
    );
  });
  test("a decision id is ERR_CAPTURE_STATE and an unknown id is ERR_CAPTURE_NOT_FOUND", async () => {
    store.insert({
      id: "cap_d",
      kind: "decision",
      state: "proposed",
      itemId: null,
      payloadJson: JSON.stringify({ statement: "s" }),
      payloadBytes: 5,
      clientLabel: null,
      sessionId: "s",
      createdAt: 1,
      expiresAt: null,
      agentDoorLegacy: false,
    });
    for (const m of ["approvals.get", "approvals.approve", "approvals.decline"]) {
      expect((await rpcError(call(m, { id: "cap_d" }, OWNER, new FakeConsent()))).code).toBe(
        "ERR_CAPTURE_STATE",
      );
      expect((await rpcError(call(m, { id: "cap_zz" }, OWNER, new FakeConsent()))).code).toBe(
        "ERR_CAPTURE_NOT_FOUND",
      );
    }
  });
});

describe("approvals.decline", () => {
  test("rejects a proposed action, audited as capture.reject, and dispatches nothing", async () => {
    insertAction("cap_a");
    expect(await call("approvals.decline", { id: "cap_a" })).toEqual({
      id: "cap_a",
      state: "rejected",
    });
    expect(dispatched).toEqual([]);
    const audit = db
      .query("SELECT hitl_status FROM audit_log WHERE action_type = 'capture.reject'")
      .all();
    expect(audit).toEqual([{ hitl_status: "rejected" }]);
  });
  test("an executed action cannot be declined, and the sink being off does not stop a decline", async () => {
    insertAction("cap_a");
    store.claimAction("cap_a", 1_000);
    store.finalizeAction("cap_a", "executed", {}, 1_000);
    expect((await rpcError(call("approvals.decline", { id: "cap_a" }))).code).toBe(
      "ERR_CAPTURE_STATE",
    );
    insertAction("cap_b");
    sinkOn = false;
    expect((await call("approvals.decline", { id: "cap_b" })) as { state: string }).toMatchObject({
      state: "rejected",
    });
  });
});

describe("approvals.approve is human-only", () => {
  test("a human approval dispatches once and finalizes executed", async () => {
    insertAction("cap_a");
    const consent = new FakeConsent();
    const out = await call("approvals.approve", { id: "cap_a" }, OWNER, consent);
    expect(out).toEqual({ id: "cap_a", state: "executed", outcomeRef: "https://x.example/1" });
    expect(writesOf()).toHaveLength(1);
    expect(consent.prompts).toHaveLength(1);
    expect(consent.prompts[0]).toContain("Proposed by an outside agent (UNVERIFIED");
  });
  test.each(["auto", "script", "unknown", "delegate", "remote", "none"] as const)(
    "an approval from source %s dispatches nothing: the row is rejected and the owner is told why",
    async (source) => {
      insertAction("cap_a");
      const consent = new FakeConsent();
      consent.source = source;
      const out = (await call("approvals.approve", { id: "cap_a" }, OWNER, consent)) as {
        state: string;
        reason?: string;
      };
      expect(out.state).toBe("rejected");
      expect(out.reason).toBe(NON_HUMAN_REASON);
      expect(writesOf()).toEqual([]);
      expect(store.get("cap_a")?.state).toBe("rejected");
      const executorRow = db
        .query("SELECT hitl_status FROM audit_log WHERE action_type = 'slack.message.post'")
        .all();
      expect(executorRow).toEqual([{ hitl_status: "rejected" }]);
    },
  );
  test("a human decline is a rejection with the executor's own reason, not the non-human text", async () => {
    insertAction("cap_a");
    const consent = new FakeConsent();
    consent.approved = false;
    const out = (await call("approvals.approve", { id: "cap_a" }, OWNER, consent)) as {
      state: string;
      reason?: string;
    };
    expect(out.state).toBe("rejected");
    expect(out.reason).toBeDefined();
    expect(out.reason).not.toBe(NON_HUMAN_REASON);
  });
  test("through the real coordinator: a human answer runs, an answer without a source does not", async () => {
    const run = async (answerSource: string | undefined): Promise<string> => {
      insertAction(`cap_${String(answerSource)}`);
      const impl: ConsentCoordinatorImpl = new ConsentCoordinatorImpl(() => (n) => {
        const p = n.params as { requestId: string };
        queueMicrotask(() =>
          impl.handleRespond("o", {
            requestId: p.requestId,
            approved: true,
            ...(answerSource === undefined ? {} : { answerSource }),
          }),
        );
      });
      const out = (await call(
        "approvals.approve",
        { id: `cap_${String(answerSource)}` },
        OWNER,
        impl,
      )) as { state: string };
      return out.state;
    };
    expect(await run("human")).toBe("executed");
    expect(await run(undefined)).toBe("rejected");
    expect(await run("auto")).toBe("rejected");
    expect(writesOf()).toHaveLength(1);
  });
});

describe("humanOnlyConsent", () => {
  test.each(["auto", "script", "unknown", "delegate", "remote", "none"] as const)(
    "requestConfirmedConsent from %s is a decline with empty typed text",
    async (source) => {
      const inner = new FakeConsent();
      inner.source = source;
      inner.typed = "slack/C1";
      let flagged = 0;
      const wrapped = humanOnlyConsent(inner, () => flagged++);
      const out = await wrapped.requestConfirmedConsent("o", {
        requestId: "r",
        prompt: "p",
        confirmText: "slack/C1",
      });
      expect(out).toEqual({ approved: false, typed: "", answerSource: source });
      expect(flagged).toBe(1);
    },
  );
  test("a human answer passes through unchanged, and a human decline is not flagged", async () => {
    const inner = new FakeConsent();
    inner.typed = "slack/C1";
    let flagged = 0;
    const wrapped = humanOnlyConsent(inner, () => flagged++);
    expect(
      await wrapped.requestConfirmedConsent("o", { requestId: "r", prompt: "p", confirmText: "x" }),
    ).toEqual({ approved: true, typed: "slack/C1", answerSource: "human" });
    inner.approved = false;
    inner.source = "auto";
    expect(await wrapped.requestConsent("o", { requestId: "r", prompt: "p" })).toEqual({
      approved: false,
      answerSource: "auto",
    });
    expect(flagged).toBe(0);
    expect(wrapped.pendingCount()).toBe(0);
    wrapped.rejectAllPending("m", "r");
  });
});

describe("approvals.approve: order and refusals", () => {
  test("act or consent absent is ERR_CAPTURE_DISABLED and nothing runs", async () => {
    insertAction("cap_a");
    const noConsent = await rpcError(call("approvals.approve", { id: "cap_a" }));
    expect(noConsent.code).toBe("ERR_CAPTURE_DISABLED");
    const noAct: CaptureRpcCtx = { gate: ctx.gate };
    const e = await rpcError(
      call("approvals.approve", { id: "cap_a" }, OWNER, new FakeConsent(), noAct),
    );
    expect(e.code).toBe("ERR_CAPTURE_DISABLED");
    expect(dispatched).toEqual([]);
    expect(store.get("cap_a")?.state).toBe("proposed");
  });
  test("the sink being off freezes approving, as for captures.accept", async () => {
    insertAction("cap_a");
    sinkOn = false;
    const e = await rpcError(call("approvals.approve", { id: "cap_a" }, OWNER, new FakeConsent()));
    expect(e.code).toBe("ERR_CAPTURE_DISABLED");
  });
  test("a refusal inside the executor comes back rejected with its reason, and no prompt is shown", async () => {
    insertAction("cap_a");
    const synthetic = withConfirm(row("slack_message_post", "slack.message.post", "write", 4), {
      template: "{channel}",
    });
    const c = makeCtx({ beforeStateRows: [synthetic] });
    const consent = new FakeConsent();
    const out = (await call("approvals.approve", { id: "cap_a" }, OWNER, consent, c)) as {
      state: string;
      reason?: string;
    };
    expect(out.state).toBe("rejected");
    expect(out.reason).toBe(WAVE4_BEFORE_REFUSAL);
    expect(consent.prompts).toEqual([]);
    expect(writesOf()).toEqual([]);
    // AD3a-2a: a refusal made before any prompt now stores its fixed code (a plain decline stores none).
    expect(store.get("cap_a")?.errorCode).toBe("ERR_ACTION_BEFORE_STATE_UNREADABLE");
  });
});

describe("the method table", () => {
  test("APPROVALS_METHODS is exactly the four names, each routed; others miss", async () => {
    expect([...APPROVALS_METHODS]).toEqual([
      "approvals.list",
      "approvals.get",
      "approvals.approve",
      "approvals.decline",
    ]);
    for (const m of APPROVALS_METHODS) {
      const out = await dispatchApprovalsRpc(m, { id: "cap_none" }, ctx, {
        clientId: "x",
        kind: "mcp",
      }).catch(() => ({ kind: "hit" as const }));
      expect(out.kind).toBe("hit");
    }
    expect(await dispatchApprovalsRpc("approvals.nonesuch", {}, ctx, OWNER)).toEqual({
      kind: "miss",
    });
  });
});

function serverCtx(
  overrides: Partial<CreateIpcServerOptions>,
  kinds: Record<string, ClientKind>,
): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: (id: string) => kinds[id] ?? "unknown",
  } as unknown as ServerCtx;
}

describe("routing through tryDispatchPhase4Rpc (the entry server.ts calls)", () => {
  test.each([...APPROVALS_METHODS])(
    "%s reaches the handler with the CONNECTION's kind, never a param",
    async (method) => {
      insertAction("cap_a");
      const s = serverCtx({ captureRpcCtx: ctx }, { o: "cli", u: "unknown", m: "mcp" });
      // An undeclared connection claiming cli in the params is still refused.
      for (const id of ["u", "m"]) {
        await expect(
          tryDispatchPhase4Rpc(s, method, { id: "cap_a", clientKind: "cli", kind: "cli" }, id),
        ).rejects.toMatchObject({ rpcData: { code: "ERR_CAPTURE_FORBIDDEN_CLIENT" } });
      }
      // A declared cli connection reaches the handler (list, get and decline answer; approve is
      // refused DISABLED only because this server context has no consent channel wired to a client).
      if (method === "approvals.list") {
        expect(await tryDispatchPhase4Rpc(s, method, {}, "o")).toMatchObject({
          proposals: [{ id: "cap_a" }],
        });
      } else if (method === "approvals.get") {
        expect(await tryDispatchPhase4Rpc(s, method, { id: "cap_a" }, "o")).toMatchObject({
          id: "cap_a",
        });
      } else if (method === "approvals.decline") {
        expect(await tryDispatchPhase4Rpc(s, method, { id: "cap_a" }, "o")).toEqual({
          id: "cap_a",
          state: "rejected",
        });
      } else {
        // The route hands approve the server's own coordinator: no client writer, so the executor's
        // prompt cannot be delivered and the proposal is not executed.
        const out = (await tryDispatchPhase4Rpc(s, method, { id: "cap_a" }, "o")) as {
          state: string;
        };
        expect(out.state).not.toBe("executed");
        expect(writesOf()).toEqual([]);
      }
    },
  );

  test("skipped when captureRpcCtx is unset; an unknown approvals method falls through", async () => {
    const none = serverCtx({}, { o: "cli" });
    expect(await tryDispatchPhase4Rpc(none, "approvals.list", {}, "o")).toBe(phase4RpcSkipped);
    const s = serverCtx({ captureRpcCtx: ctx }, { o: "cli" });
    expect(await tryDispatchPhase4Rpc(s, "approvals.nonesuch", {}, "o")).toBe(phase4RpcSkipped);
  });

  test("capture.mine routes with the connection's kind", async () => {
    const s = serverCtx({ captureRpcCtx: ctx }, { m: "mcp", o: "cli" });
    expect(await tryDispatchPhase4Rpc(s, "capture.mine", {}, "m")).toEqual({ captures: [] });
    await expect(tryDispatchPhase4Rpc(s, "capture.mine", {}, "o")).rejects.toMatchObject({
      rpcData: { code: "ERR_CAPTURE_FORBIDDEN_CLIENT" },
    });
  });
});

describe("LAN: the denylist trap", () => {
  test.each([...APPROVALS_METHODS, "capture.mine"])(
    "%s is not callable over LAN, even with writes granted",
    (method) => {
      for (const writeAllowed of [true, false]) {
        expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed })).toThrow(
          LanError,
        );
      }
    },
  );
});

describe("AD3a-2a: the owner list counts for the act path", () => {
  function approvedCtx(): CaptureRpcCtx {
    const base = makeCtx({
      agentDoor: {
        listServerTools: () => Promise.resolve({}),
        verifyDefinition: () => Promise.resolve({ ok: true }),
      },
    });
    return {
      ...base,
      gate: {
        ...base.gate,
        classifyAction: () => ({ kind: "proposable", basis: "approved" }),
        verifyActionDefinition: () => Promise.resolve({ ok: true }),
      },
    };
  }

  test("approvals.list shows the wave and typed-confirm flag of a real Wave 4 row", async () => {
    insertAction("cap_m", { actionType: "github.pr.merge", input: { number: 1 } });
    const out = (await call("approvals.list", {})) as {
      proposals: Array<{ wave: number; typedConfirm: boolean }>;
    };
    expect(out.proposals[0]).toMatchObject({ wave: 4, typedConfirm: true });
  });

  test("approvals.approve passes humanOnly, so an approved-basis proposal runs; captures.accept does not, and refuses it", async () => {
    const c = approvedCtx();
    insertAction("cap_h");
    const viaApprovals = (await call(
      "approvals.approve",
      { id: "cap_h" },
      OWNER,
      new FakeConsent(),
      c,
    )) as {
      state: string;
    };
    expect(viaApprovals.state).toBe("executed");
    insertAction("cap_r");
    const e = await rpcError(
      dispatchCaptureRpc("captures.accept", { id: "cap_r" }, c, OWNER, new FakeConsent()).then(
        (r) => (r.kind === "miss" ? Promise.reject(new Error("miss")) : r.value),
      ),
    );
    expect(e.code).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(store.get("cap_r")?.state).toBe("proposed");
  });
});
