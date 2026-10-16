import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import { createMockVault } from "../vault/mock.ts";
import {
  buildActDeps,
  type CaptureActWiring,
  type CaptureRpcCtx,
  dispatchCaptureRpc,
} from "./capture-rpc.ts";
import { type ConsentCoordinator, ConsentCoordinatorImpl } from "./consent.ts";
import { createStreamRegistry } from "./engine-ask-stream.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "./server/context.ts";
import { tryDispatchPhase4Rpc } from "./server/dispatchers.ts";
import type { CreateIpcServerOptions } from "./server/options.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

let db: Database;
let ctx: CaptureRpcCtx;

beforeEach(() => {
  db = openMigratedMemoryDb();
  let seq = 0;
  const gate: CaptureGateDeps = {
    db,
    store: new CaptureStore(db),
    capability: () =>
      resolveCaptureCapability(
        { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
        { capabilitiesDisabled: new Set() },
      ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => 1_000,
  };
  ctx = { gate };
});
afterEach(() => db.close());

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

const NOTE = { kind: "note", payload: { title: "t", body: "b" } };

describe("dispatchCaptureRpc", () => {
  test("hits every method and misses others", async () => {
    const mcp = { clientId: "m", kind: "mcp" as const };
    const own = { clientId: "o", kind: "cli" as const };
    expect((await dispatchCaptureRpc("capture.status", {}, ctx, mcp)).kind).toBe("hit");
    const sub = await dispatchCaptureRpc("capture.submit", NOTE, ctx, mcp);
    expect(sub).toEqual({ kind: "hit", value: { id: "cap_1", state: "live" } });
    expect((await dispatchCaptureRpc("captures.list", {}, ctx, own)).kind).toBe("hit");
    expect((await dispatchCaptureRpc("captures.get", { id: "cap_1" }, ctx, own)).kind).toBe("hit");
    expect(await dispatchCaptureRpc("captures.revoke", { id: "cap_1" }, ctx, own)).toEqual({
      kind: "hit",
      value: { id: "cap_1", state: "revoked" },
    });
    expect(await dispatchCaptureRpc("captures.nonesuch", { id: "cap_1" }, ctx, own)).toEqual({
      kind: "miss",
    });
  });

  test("captures.accept, captures.reject and captures.purge dispatch and map CaptureError to -32001", async () => {
    const mcp = { clientId: "m", kind: "mcp" as const };
    const own = { clientId: "o", kind: "cli" as const };
    const a = await dispatchCaptureRpc(
      "capture.submit",
      { kind: "term", payload: { term: "WAL", definition: "log" } },
      ctx,
      mcp,
    );
    const b = await dispatchCaptureRpc(
      "capture.submit",
      { kind: "decision", payload: { statement: "s" } },
      ctx,
      mcp,
    );
    if (a.kind !== "hit" || b.kind !== "hit") throw new Error("submit missed");
    const aId = (a.value as { id: string }).id;
    const bId = (b.value as { id: string }).id;
    expect(await dispatchCaptureRpc("captures.accept", { id: aId }, ctx, own)).toEqual({
      kind: "hit",
      value: { id: aId, state: "accepted", nativeRef: "wal" },
    });
    expect(await dispatchCaptureRpc("captures.reject", { id: bId }, ctx, own)).toEqual({
      kind: "hit",
      value: { id: bId, state: "rejected" },
    });
    // A decision is not an action: purge refuses it through the same error mapping.
    for (const method of ["captures.accept", "captures.reject", "captures.purge"]) {
      try {
        await dispatchCaptureRpc(method, { id: aId }, ctx, own);
        throw new Error("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(RpcMethodError);
        expect((e as RpcMethodError).rpcCode).toBe(-32001);
        expect((e as RpcMethodError).rpcData).toEqual({ code: "ERR_CAPTURE_STATE" });
      }
    }
  });

  test("non-object params reach get/revoke as an undefined id and refuse cleanly", async () => {
    const own = { clientId: "o", kind: "cli" as const };
    await expect(dispatchCaptureRpc("captures.get", "nope", ctx, own)).rejects.toThrow(
      /ERR_CAPTURE_INVALID/,
    );
    await expect(dispatchCaptureRpc("captures.revoke", null, ctx, own)).rejects.toThrow(
      /ERR_CAPTURE_INVALID/,
    );
  });

  test("a non-CaptureError rethrows unchanged", async () => {
    const broken: CaptureRpcCtx = {
      gate: {
        ...ctx.gate,
        capability: () => {
          throw new TypeError("boom");
        },
      },
    };
    await expect(
      dispatchCaptureRpc("capture.status", {}, broken, { clientId: "o", kind: "cli" }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("routing through tryDispatchPhase4Rpc (the entry server.ts calls)", () => {
  test("capture.submit reaches the gate with the CONNECTION's kind, not a param", async () => {
    const s = serverCtx({ captureRpcCtx: ctx }, { m: "mcp", o: "cli" });
    expect(await tryDispatchPhase4Rpc(s, "capture.submit", NOTE, "m")).toEqual({
      id: "cap_1",
      state: "live",
    });
    await expect(
      tryDispatchPhase4Rpc(s, "capture.submit", { ...NOTE, clientKind: "mcp" }, "o"),
    ).rejects.toThrow(/ERR_CAPTURE_FORBIDDEN_CLIENT/);
  });

  test("a CaptureError becomes RpcMethodError -32001 carrying the code", async () => {
    const s = serverCtx({ captureRpcCtx: ctx }, { m: "mcp" });
    try {
      await tryDispatchPhase4Rpc(s, "captures.list", {}, "m");
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
      expect((e as RpcMethodError).rpcCode).toBe(-32001);
      expect((e as RpcMethodError).rpcData).toEqual({ code: "ERR_CAPTURE_FORBIDDEN_CLIENT" });
    }
  });

  test("skips when the ctx is unset or the method is another namespace's", async () => {
    const none = serverCtx({}, { o: "cli" });
    expect(await tryDispatchPhase4Rpc(none, "capture.status", {}, "o")).toBe(phase4RpcSkipped);
    const s = serverCtx({ captureRpcCtx: ctx }, { o: "cli" });
    expect(await tryDispatchPhase4Rpc(s, "captures.nonesuch", {}, "o")).toBe(phase4RpcSkipped);
  });
});

describe("LAN", () => {
  test.each([
    "capture.status",
    "capture.submit",
    "captures.list",
    "captures.get",
    "captures.revoke",
    "captures.accept",
    "captures.purge",
  ])("%s is not callable over LAN (namespace denial covers future methods)", (method) => {
    expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: true })).toThrow(
      LanError,
    );
  });
});

describe("buildActDeps (act door)", () => {
  function wiring(dispatched: PlannedAction[], approve: boolean) {
    const prompts: Array<{ prompt: string; details: unknown }> = [];
    // A coordinator stub that answers every request; `requestConsent` is the only member bindConsentChannel calls.
    const coord = {
      requestConsent: (_c: string, req: { prompt: string; details?: unknown }) => {
        prompts.push({ prompt: req.prompt, details: req.details });
        return Promise.resolve(approve);
      },
    } as unknown as ConsentCoordinator;
    const w: CaptureActWiring = {
      dispatcher: {
        dispatch: (a) => {
          dispatched.push(a);
          return Promise.resolve({ url: "https://x" });
        },
      },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
    };
    return { act: buildActDeps(w, coord, "c-cli"), prompts };
  }
  const PROV = {
    captureId: "cap_1",
    clientLabel: "agent",
    createdAt: 0,
    expiresAt: 1,
    summary: "why",
  };

  test("first-party: payload carries the ROUTING table's mcpToolId and the input, nothing else", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, true);
    expect(await act.execute("slack.message.post", { text: "hi" }, PROV)).toEqual({
      status: "ok",
      result: { url: "https://x" },
    });
    expect(d).toEqual([
      {
        type: "slack.message.post",
        payload: { mcpToolId: "slack_message_post", input: { text: "hi" } },
      },
    ]);
  });
  test("user-MCP: mcpToolId is the canonical <serviceId>_<tool> key derived from the type (I42 pairing)", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, true);
    await act.execute("mcp_echo.echo", { text: "hi" }, PROV);
    expect(d[0]?.payload).toEqual({ mcpToolId: "mcp_echo_echo", input: { text: "hi" } });
  });
  test("the consent prompt is the provenance prompt, with UNREDACTED details", async () => {
    const d: PlannedAction[] = [];
    const { act, prompts } = wiring(d, true);
    await act.execute("slack.message.post", { token_hint: "visible", text: "hi" }, PROV);
    expect(prompts[0]?.prompt).toContain("Agent-proposed action");
    expect(prompts[0]?.details).toEqual({
      actionType: "slack.message.post",
      input: { token_hint: "visible", text: "hi" },
    });
  });
  test("declined → rejected, nothing dispatched", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, false);
    expect(await act.execute("slack.message.post", { text: "hi" }, PROV)).toEqual({
      status: "rejected",
    });
    expect(d).toEqual([]);
  });
  test("a first-party type with no routing row throws Tool not found (never dispatches by type)", async () => {
    const d: PlannedAction[] = [];
    const { act, prompts } = wiring(d, true);
    await expect(act.execute("github.pr.merge", {}, PROV)).rejects.toThrow("Tool not found");
    expect(d).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

test("capture.state routes; captures.accept passes ActDeps when wiring + consent are present", async () => {
  // Submit an mcp note, then poll it as mcp.
  const sub = await dispatchCaptureRpc("capture.submit", NOTE, ctx, { clientId: "a", kind: "mcp" });
  const id = (sub as { kind: "hit"; value: { id: string } }).value.id;
  const st = await dispatchCaptureRpc("capture.state", { id }, ctx, { clientId: "a", kind: "mcp" });
  expect(st).toEqual({ kind: "hit", value: { kind: "note", state: "live" } });
});

describe("captures.accept on an action (act door wiring)", () => {
  function actionCtx(dispatched: PlannedAction[]): CaptureRpcCtx {
    const gate: CaptureGateDeps = {
      ...ctx.gate,
      capability: () =>
        resolveCaptureCapability(
          {
            ok: true,
            config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
          },
          { capabilitiesDisabled: new Set() },
        ),
      classifyAction: () => ({ kind: "proposable" }),
      isServiceConfigured: () => Promise.resolve(true),
    };
    gate.store.insert({
      id: "cap_act",
      kind: "action",
      state: "proposed",
      itemId: null,
      payloadJson: JSON.stringify({
        actionType: "slack.message.post",
        input: { text: "hi" },
        summary: "why",
      }),
      payloadBytes: 10,
      clientLabel: "agent",
      sessionId: "s",
      createdAt: 500,
      expiresAt: 2_000,
    });
    return {
      gate,
      act: {
        dispatcher: {
          dispatch: (a) => {
            dispatched.push(a);
            return Promise.resolve({});
          },
        },
        egressSink: makeEgressSink(db),
        audit: { recordAudit: (e) => appendAuditEntry(db, e) },
        policyHitl: NO_POLICY_OVERLAY,
      },
    };
  }
  const OWNER = { clientId: "o", kind: "cli" as const };

  test("with wiring + consent: the ACCEPTING client is prompted and the action executes", async () => {
    const d: PlannedAction[] = [];
    const asked: string[] = [];
    const consent = {
      requestConsent: (clientId: string) => {
        asked.push(clientId);
        return Promise.resolve(true);
      },
    } as unknown as ConsentCoordinator;
    const out = await dispatchCaptureRpc(
      "captures.accept",
      { id: "cap_act" },
      actionCtx(d),
      OWNER,
      consent,
    );
    expect(out).toEqual({ kind: "hit", value: { id: "cap_act", state: "executed" } });
    expect(asked).toEqual(["o"]);
    expect(d).toEqual([
      {
        type: "slack.message.post",
        payload: { mcpToolId: "slack_message_post", input: { text: "hi" } },
      },
    ]);
    const hitl = db
      .query("SELECT hitl_status FROM audit_log WHERE action_type = 'slack.message.post'")
      .all();
    expect(hitl).toEqual([{ hitl_status: "approved" }]);
  });

  test("without a consent coordinator there is no ActDeps: refused DISABLED, nothing dispatched", async () => {
    const d: PlannedAction[] = [];
    const c = actionCtx(d);
    await expect(
      dispatchCaptureRpc("captures.accept", { id: "cap_act" }, c, OWNER),
    ).rejects.toMatchObject({ rpcData: { code: "ERR_CAPTURE_DISABLED" } });
    expect(d).toEqual([]);
    expect(c.gate.store.get("cap_act")?.state).toBe("proposed");
  });
});
