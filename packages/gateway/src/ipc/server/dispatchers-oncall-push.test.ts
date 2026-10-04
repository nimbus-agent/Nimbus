/**
 * dispatchers-oncall-push.test.ts
 *
 * `tryDispatchOncallPushRpc` is the only seam between the JSON-RPC socket and the `oncall.pushed*`
 * methods, and `tryDispatchDemoRpc` now hands the push runtime to `demo.firePage`. Both shipped with
 * only their happy edge exercised end to end (the e2e routing test boots a real gateway, which the
 * coverage run's unit shard does not credit). Asserted here: the prefix guard short-circuits before
 * the ctx is read, a missing ctx skips rather than throws, an unclaimed `oncall.*` verb is skipped
 * (not answered with `undefined`), `OncallPushRpcError`'s code survives the remap, and any other
 * error propagates unchanged. No `mock.module`; the runtime is a hand-built DI fake.
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { PushRetryRefusedError, type PushRunSummary } from "../../oncall-push/push-runner.ts";
import type { OncallPushRuntime } from "../../oncall-push/push-runtime.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { OncallPushRpcCtx } from "../oncall-push-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { tryDispatchDemoRpc, tryDispatchOncallPushRpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

type FakeRuntime = Pick<
  OncallPushRuntime,
  "config" | "store" | "retry" | "identityResolved" | "run"
>;

function fakeRuntime(over: Partial<FakeRuntime> = {}): OncallPushRuntime {
  const base: FakeRuntime = {
    config: { enabled: true } as OncallPushRuntime["config"],
    store: {
      list: () => [],
      listWithIncident: () => [],
      incidentPagerdutyServiceId: () => null,
      newest: () => null,
      get: () => null,
      incidentTitle: () => null,
    } as unknown as OncallPushRuntime["store"],
    retry: async () => {
      throw new Error("unexpected retry");
    },
    identityResolved: async () => true,
    run: async () => ({ selected: 0, ok: 0, failed: 0 }),
  };
  return { ...base, ...over } as OncallPushRuntime;
}

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function makeCtx(extra: Record<string, unknown> = {}): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...extra },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  } as unknown as ServerCtx;
}
const withRuntime = (rt: OncallPushRuntime): ServerCtx =>
  makeCtx({ oncallPushRpcCtx: { runtime: rt } satisfies OncallPushRpcCtx });

describe("tryDispatchOncallPushRpc", () => {
  test("a non-oncall method never reads the push ctx", async () => {
    let reads = 0;
    const ctx = makeCtx();
    Object.defineProperty(ctx.options, "oncallPushRpcCtx", {
      configurable: true,
      get(): never {
        reads += 1;
        throw new Error("must not be read");
      },
    });
    expect(await tryDispatchOncallPushRpc(ctx, "agents.oncall", {})).toBe(phase4RpcSkipped);
    expect(reads).toBe(0);
  });

  test("an oncall.* method with no push runtime wired skips rather than throwing", async () => {
    expect(await tryDispatchOncallPushRpc(makeCtx(), "oncall.pushedList", {})).toBe(
      phase4RpcSkipped,
    );
  });

  test("oncall.pushedList is answered from the runtime", async () => {
    const out = (await tryDispatchOncallPushRpc(
      withRuntime(fakeRuntime({ identityResolved: async () => false })),
      "oncall.pushedList",
      {},
    )) as Record<string, unknown>;
    expect(out).toEqual({ enabled: true, identity: "unresolved", briefs: [] });
  });

  test("an unclaimed oncall.* verb is skipped, not answered", async () => {
    expect(
      await tryDispatchOncallPushRpc(withRuntime(fakeRuntime()), "oncall.frobnicate", {}),
    ).toBe(phase4RpcSkipped);
  });

  test("OncallPushRpcError is remapped to RpcMethodError with its code preserved", async () => {
    const ctx = withRuntime(fakeRuntime());
    const bad = await tryDispatchOncallPushRpc(ctx, "oncall.pushedList", { limit: 0 }).catch(
      (e: unknown) => e,
    );
    expect(bad).toBeInstanceOf(RpcMethodError);
    expect((bad as RpcMethodError).rpcCode).toBe(-32602);
    // A runtime refusal maps to its OWN distinct code, not the param-validation one.
    const refused = await tryDispatchOncallPushRpc(
      withRuntime(
        fakeRuntime({
          retry: async () => {
            throw new PushRetryRefusedError("ERR_ONCALL_PUSH_NOT_FOUND", "no pushed brief for x");
          },
        }),
      ),
      "oncall.pushedRetry",
      { incidentId: "x" },
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RpcMethodError);
    expect((refused as RpcMethodError).rpcCode).toBe(-32001);
  });

  test("a non-OncallPushRpcError propagates unchanged, never as an RPC code", async () => {
    const boom = new TypeError("store exploded");
    const ctx = withRuntime(
      fakeRuntime({
        store: {
          newest: () => {
            throw boom;
          },
        } as unknown as OncallPushRuntime["store"],
      }),
    );
    await expect(tryDispatchOncallPushRpc(ctx, "oncall.pushedGet", {})).rejects.toBe(boom);
  });
});

describe("tryDispatchDemoRpc hands the push runtime to demo.firePage", () => {
  function demoCtx(rt: OncallPushRuntime | undefined): ServerCtx {
    const db = createMemoryIndexDb();
    dbs.push(db);
    return makeCtx({
      demo: true,
      localIndex: { getDatabase: () => db },
      configDir: "/demo-config",
      dataDir: "/demo-data",
      ...(rt === undefined ? {} : { oncallPushRpcCtx: { runtime: rt } }),
    });
  }

  test("with the runtime wired, firePage runs the page through runtime.run('pagerduty')", async () => {
    const calls: string[] = [];
    const summary: PushRunSummary = { selected: 1, ok: 1, failed: 0 };
    const out = (await tryDispatchDemoRpc(
      demoCtx(
        fakeRuntime({
          run: async (id) => {
            calls.push(id);
            return summary;
          },
        }),
      ),
      "demo.firePage",
      {},
    )) as { push: PushRunSummary };
    expect(calls).toEqual(["pagerduty"]);
    expect(out.push).toEqual(summary);
  });

  test("without the runtime, firePage refuses ERR_DEMO_PUSH_UNAVAILABLE with its code", async () => {
    const e = await tryDispatchDemoRpc(demoCtx(undefined), "demo.firePage", {}).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(RpcMethodError);
    expect((e as RpcMethodError).rpcCode).toBe(-32010);
    expect((e as RpcMethodError).message).toContain("ERR_DEMO_PUSH_UNAVAILABLE");
  });
});
