import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { demoRefusal } from "./demo-gate.ts";
import { tryDispatchOncallNowRpc, tryDispatchPhase4Rpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function makeCtx(withIndex: boolean, extra: Record<string, unknown> = {}): ServerCtx {
  const db = createMemoryIndexDb();
  dbs.push(db);
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...(withIndex ? { localIndex: { getDatabase: () => db } } : {}),
      ...extra,
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

describe("tryDispatchOncallNowRpc", () => {
  test("oncall.now is answered through the phase 4 group with the push runtime UNSET", async () => {
    const ctx = makeCtx(true);
    expect(ctx.options.oncallPushRpcCtx).toBeUndefined();
    const out = (await tryDispatchPhase4Rpc(ctx, "oncall.now", {}, "c1")) as { status: string };
    expect(out.status).toBe("no_data");
  });

  test("other methods and a missing index are skipped", async () => {
    expect(await tryDispatchOncallNowRpc(makeCtx(true), "oncall.pushedList", {})).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchOncallNowRpc(makeCtx(false), "oncall.now", {})).toBe(phase4RpcSkipped);
  });

  test("a validation error keeps its code", async () => {
    const err = await tryDispatchOncallNowRpc(makeCtx(true), "oncall.now", { service: 5 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).rpcCode).toBe(-32602);
  });

  test("oncall.pushedList still reaches the push handler when both are wired", async () => {
    const runtime = {
      config: { chatopsNamespace: "" },
      isEnabled: () => true,
      store: { listWithIncident: () => [] },
      identityResolved: async () => true,
      chatopsSinkState: () => "none",
    };
    const ctx = makeCtx(true, { oncallPushRpcCtx: { runtime } });
    const out = (await tryDispatchPhase4Rpc(ctx, "oncall.pushedList", {}, "c1")) as {
      enabled: boolean;
    };
    expect(out.enabled).toBe(true);
  });

  test("an unknown oncall.* method is still not claimed", async () => {
    expect(await tryDispatchPhase4Rpc(makeCtx(true), "oncall.zzz", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
  });

  test("a demo gateway serves oncall.now: the demo gate does not refuse it", () => {
    expect(demoRefusal("oncall.now")).toBeUndefined();
  });
});
