import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createBriefingRuntime } from "../../briefing/briefing-runtime.ts";
import { parseNimbusTomlBriefing } from "../../config/briefing-toml.ts";
import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { demoRefusal } from "./demo-gate.ts";
import { tryDispatchBriefingRpc, tryDispatchPhase4Rpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function makeCtx(wired: boolean): ServerCtx {
  const db = createMemoryIndexDb();
  dbs.push(db);
  const runtime = createBriefingRuntime({
    db,
    configDir: "C:/nonexistent-nimbus-test-dir",
    now: () => Date.UTC(2026, 10, 12, 8, 31),
    resolveSelf: async () => null,
    emit: () => {},
    toast: async () => "delivered",
    toastDelivers: () => true,
    demo: false,
    loadConfig: () => parseNimbusTomlBriefing(""),
  });
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...(wired ? { briefingRpcCtx: { runtime } } : {}),
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  } as unknown as ServerCtx;
}

describe("tryDispatchBriefingRpc", () => {
  test("briefing.latest reaches the handler THROUGH the phase 4 group, not only the unit function", async () => {
    const out = await tryDispatchPhase4Rpc(makeCtx(true), "briefing.latest", {}, "c1");
    expect(out).toEqual({ run: null });
    const status = (await tryDispatchPhase4Rpc(makeCtx(true), "briefing.status", {}, "c1")) as {
      enabled: boolean;
    };
    expect(status.enabled).toBe(false);
  });

  test("an unrelated method and an unwired context are skipped", async () => {
    expect(await tryDispatchBriefingRpc(makeCtx(true), "oncall.now", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchBriefingRpc(makeCtx(false), "briefing.latest", {})).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchBriefingRpc(makeCtx(true), "briefing.zzz", {})).toBe(phase4RpcSkipped);
  });

  test("a validation error keeps its code", async () => {
    const err = await tryDispatchBriefingRpc(makeCtx(true), "briefing.list", { limit: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).rpcCode).toBe(-32602);
  });

  test("a non-domain failure propagates", async () => {
    const ctx = makeCtx(true);
    const rpc = ctx.options.briefingRpcCtx;
    if (rpc === undefined) throw new Error("fixture");
    const broken = { ...rpc.runtime, runNow: () => Promise.reject(new Error("boom")) };
    const broken2 = { ...ctx, options: { ...ctx.options, briefingRpcCtx: { runtime: broken } } };
    await expect(
      tryDispatchBriefingRpc(broken2 as unknown as ServerCtx, "briefing.runNow", {}),
    ).rejects.toThrow("boom");
  });

  test("a demo gateway serves all five: the demo gate does not refuse them", () => {
    for (const m of [
      "briefing.latest",
      "briefing.list",
      "briefing.get",
      "briefing.status",
      "briefing.runNow",
    ]) {
      expect(demoRefusal(m)).toBeUndefined();
    }
  });
});
