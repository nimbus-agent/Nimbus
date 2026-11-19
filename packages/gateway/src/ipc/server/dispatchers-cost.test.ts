import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { demoRefusal } from "./demo-gate.ts";
import { tryDispatchCostRpc, tryDispatchPhase4Rpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function makeCtx(withIndex: boolean): ServerCtx {
  const db = createMemoryIndexDb();
  dbs.push(db);
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...(withIndex ? { localIndex: { getDatabase: () => db } } : {}),
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

describe("tryDispatchCostRpc", () => {
  test("cost.anomalies is answered through the phase 4 group", async () => {
    const out = (await tryDispatchPhase4Rpc(makeCtx(true), "cost.anomalies", {}, "c1")) as {
      status: string;
    };
    expect(out.status).toBe("no_data");
  });

  test("cost.waste is answered through the same group", async () => {
    const out = (await tryDispatchPhase4Rpc(makeCtx(true), "cost.waste", {}, "c1")) as {
      status: string;
    };
    expect(out.status).toBe("no_data");
  });

  test("other namespaces, other cost methods and a missing index are skipped", async () => {
    expect(await tryDispatchCostRpc(makeCtx(true), "oncall.now", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchCostRpc(makeCtx(true), "cost.zzz", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchCostRpc(makeCtx(false), "cost.anomalies", {})).toBe(phase4RpcSkipped);
  });

  test("a validation error keeps its code", async () => {
    const err = await tryDispatchCostRpc(makeCtx(true), "cost.anomalies", { days: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).rpcCode).toBe(-32602);
  });

  test("the demo gateway does not refuse it (its index has no cost rows)", () => {
    expect(demoRefusal("cost.anomalies")).toBeUndefined();
    expect(demoRefusal("cost.waste")).toBeUndefined();
  });
});
