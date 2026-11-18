import { describe, expect, test } from "bun:test";

import type { IacDriftRunner } from "../../iac-drift/drift-runner.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ClientKind } from "./client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { tryDispatchIacDriftRpc, tryDispatchPhase4Rpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

function makeCtx(o: { wired?: boolean; kind?: ClientKind; throws?: Error } = {}): ServerCtx {
  const runner: IacDriftRunner = {
    check: async () => {
      if (o.throws !== undefined) throw o.throws;
      return [];
    },
    latest: () => [],
    running: () => false,
    wasRunningAt: () => false,
  };
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...(o.wired === false ? {} : { iacDriftRpcCtx: { runner: () => runner } }),
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => o.kind ?? "cli",
  } as unknown as ServerCtx;
}

describe("tryDispatchIacDriftRpc (IaC drift D2)", () => {
  test("iac.driftLatest reaches the handler THROUGH the phase 4 group, for a cli connection", async () => {
    expect(await tryDispatchPhase4Rpc(makeCtx(), "iac.driftLatest", {}, "c1")).toEqual({
      findings: [],
    });
    expect(await tryDispatchPhase4Rpc(makeCtx(), "iac.driftCheck", {}, "c1")).toEqual({
      findings: [],
    });
  });

  test("the desktop's connection is refused with a domain error code", async () => {
    const err = await tryDispatchIacDriftRpc(
      makeCtx({ kind: "ui" }),
      "iac.driftLatest",
      {},
      "c1",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).rpcCode).toBe(-32000);
  });

  test("an unrelated method, an unwired context and an unknown iac method are skipped", async () => {
    expect(await tryDispatchIacDriftRpc(makeCtx(), "oncall.now", {}, "c1")).toBe(phase4RpcSkipped);
    expect(
      await tryDispatchIacDriftRpc(makeCtx({ wired: false }), "iac.driftLatest", {}, "c1"),
    ).toBe(phase4RpcSkipped);
    expect(await tryDispatchIacDriftRpc(makeCtx(), "iac.zzz", {}, "c1")).toBe(phase4RpcSkipped);
  });

  test("a non-domain failure propagates", async () => {
    await expect(
      tryDispatchIacDriftRpc(makeCtx({ throws: new Error("io") }), "iac.driftCheck", {}, "c1"),
    ).rejects.toThrow("io");
  });
});
