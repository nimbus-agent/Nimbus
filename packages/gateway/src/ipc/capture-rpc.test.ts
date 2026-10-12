import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import { createMockVault } from "../vault/mock.ts";
import { type CaptureRpcCtx, dispatchCaptureRpc } from "./capture-rpc.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
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
    expect(await dispatchCaptureRpc("captures.accept", { id: "cap_1" }, ctx, own)).toEqual({
      kind: "miss",
    });
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
    expect(await tryDispatchPhase4Rpc(s, "captures.accept", {}, "o")).toBe(phase4RpcSkipped);
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
  ])("%s is not callable over LAN (namespace denial covers future methods)", (method) => {
    expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: true })).toThrow(
      LanError,
    );
  });
});
