import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import type {
  NotificationsStatus,
  NotificationsTestResult,
} from "../platform/notifications/notifications-runtime.ts";
import { createMockVault } from "../vault/mock.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { createStreamRegistry } from "./engine-ask-stream.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import { dispatchNotificationsRpc, type NotificationsRpcCtx } from "./notifications-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "./server/context.ts";
import { tryDispatchNotificationsRpc, tryDispatchPhase4Rpc } from "./server/dispatchers.ts";
import type { CreateIpcServerOptions } from "./server/options.ts";

const STATUS: NotificationsStatus = {
  backend: "windows-toast",
  enabled: true,
  content: "full",
  available: true,
  rateLimitedTotal: 0,
  delivers: true,
};

function rpcCtx(test: NotificationsTestResult = { delivered: true, status: STATUS }): {
  ctx: NotificationsRpcCtx;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      runtime: {
        ready: () => {
          calls.push("ready");
          return Promise.resolve(STATUS);
        },
        test: () => {
          calls.push("test");
          return Promise.resolve(test);
        },
      },
    },
  };
}

function serverCtx(overrides: Partial<CreateIpcServerOptions>): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
}

describe("dispatchNotificationsRpc", () => {
  test("status awaits the probe (ready); test sends one; anything else misses", async () => {
    const { ctx, calls } = rpcCtx();
    expect(await dispatchNotificationsRpc("notifications.status", {}, ctx)).toEqual({
      kind: "hit",
      value: STATUS,
    });
    expect(await dispatchNotificationsRpc("notifications.test", undefined, ctx)).toEqual({
      kind: "hit",
      value: { delivered: true, status: STATUS },
    });
    expect(calls).toEqual(["ready", "test"]);
    expect(await dispatchNotificationsRpc("notifications.show", {}, ctx)).toEqual({ kind: "miss" });
  });

  test("an undelivered test toast is a RESULT, not an error", async () => {
    const { ctx } = rpcCtx({ delivered: false, reason: "disabled", status: STATUS });
    expect(await dispatchNotificationsRpc("notifications.test", {}, ctx)).toEqual({
      kind: "hit",
      value: { delivered: false, reason: "disabled", status: STATUS },
    });
  });
});

describe("routing: both halves are wired", () => {
  test("through tryDispatchPhase4Rpc (the entry server.ts calls), not only the inner wrapper", async () => {
    const { ctx } = rpcCtx();
    const sctx = serverCtx({ notificationsRpcCtx: ctx });
    expect(await tryDispatchPhase4Rpc(sctx, "notifications.status", {}, "c1")).toEqual(STATUS);
    expect(await tryDispatchPhase4Rpc(sctx, "notifications.test", {}, "c1")).toEqual({
      delivered: true,
      status: STATUS,
    });
  });

  test("skips when unwired, or for another namespace / unknown method", async () => {
    const unwired = serverCtx({});
    expect(await tryDispatchNotificationsRpc(unwired, "notifications.status", {})).toBe(
      phase4RpcSkipped,
    );
    const wired = serverCtx({ notificationsRpcCtx: rpcCtx().ctx });
    expect(await tryDispatchNotificationsRpc(wired, "locality.report", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchNotificationsRpc(wired, "notifications.nope", {})).toBe(
      phase4RpcSkipped,
    );
  });
});

describe("exposure", () => {
  test("LAN: both methods refused (I5 denylist); a sibling read is still admitted (negative control)", () => {
    const peer = { peerId: "p", writeAllowed: true };
    for (const m of ["notifications.status", "notifications.test"]) {
      expect(() => checkLanMethodAllowed(m, peer)).toThrow(LanError);
      expect(() => checkLanMethodAllowed(m, peer)).toThrow(/not callable over LAN/);
    }
    expect(() => checkLanMethodAllowed("agents.ownership", peer)).not.toThrow();
  });

  test("Tauri: no notifications.* method is on ALLOWED_METHODS (I7)", async () => {
    const repo = resolve(import.meta.dir, "..", "..", "..", "..");
    const rust = await Bun.file(
      join(repo, "packages", "ui", "src-tauri", "src", "gateway_bridge.rs"),
    ).text();
    const start = rust.indexOf("pub const ALLOWED_METHODS: &[&str] = &[");
    expect(start).toBeGreaterThan(-1);
    const block = rust.slice(start, rust.indexOf("];", start));
    const methods = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    // Negative control: the parse found the real list.
    expect(methods).toContain("oncall.pushedList");
    expect(methods.filter((m) => m.startsWith("notifications."))).toEqual([]);
  });
});
