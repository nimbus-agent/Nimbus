/**
 * dispatchers-error-remap.test.ts
 *
 * Every `tryDispatch*Rpc` wrapper in `dispatchers.ts` ends the same way:
 *
 *     } catch (e) {
 *       if (e instanceof XRpcError) throw new RpcMethodError(e.rpcCode, e.message);
 *       throw e;
 *     }
 *
 * That block is the seam between a subsystem's own error type and the JSON-RPC
 * envelope the client sees, and it was the single largest uncovered region in
 * the file — roughly forty lines and eighty branches across two dozen
 * dispatchers, none of them exercised.
 *
 * It matters more than "coverage": if a wrapper forgot the `instanceof` arm, a
 * validation error would escape as a raw exception and surface to the caller as
 * an internal error (-32603) instead of invalid-params (-32602). The client
 * cannot tell "you sent the wrong thing" from "the gateway broke" — and the
 * second reading sends someone reading gateway logs for a bug that is not there.
 *
 * Each case provokes the REAL domain error through the real inner dispatcher —
 * no `mock.module`, matching `dispatchers-coverage.test.ts`'s rules. Both arms
 * of the catch are covered: the domain-error arm here, and the rethrow arm by
 * the `non-domain errors propagate unchanged` test at the bottom.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ServerCtx } from "./context.ts";
import {
  tryDispatchFilesystemRpc,
  tryDispatchIndexDemoSymbolRpc,
  tryDispatchIndexRebodyRpc,
  tryDispatchIndexReembedRpc,
  tryDispatchIndexRegraphRpc,
} from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function trackedDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

function makeCtx(overrides: Partial<ServerCtx["options"]> = {}): ServerCtx {
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...overrides,
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
}

type Dispatcher = (
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
) => Promise<unknown>;

/**
 * Each row: a dispatcher, a method it genuinely serves, and params its own
 * validator rejects. The method must be one the dispatcher RECOGNISES — a
 * bogus name would return `phase4RpcSkipped` without ever entering the try
 * block, so the test would pass while proving nothing.
 */
const CASES: ReadonlyArray<[string, Dispatcher, string, unknown, number]> = [
  // `params.limit` bounds how many connectors get a full-account network
  // re-walk, so a malformed value is a hard error rather than a fallback.
  [
    "index.rebody / bad limit",
    tryDispatchIndexRebodyRpc as Dispatcher,
    "index.rebody",
    { limit: "3" },
    -32602,
  ],
  [
    "index.reembed / missing model",
    tryDispatchIndexReembedRpc as Dispatcher,
    "index.reembed",
    {},
    -32602,
  ],
  [
    "index.regraph / takes no params",
    tryDispatchIndexRegraphRpc as Dispatcher,
    "index.regraph",
    { unexpected: 1 },
    -32602,
  ],
  [
    "index.demoSymbol / non-object params",
    tryDispatchIndexDemoSymbolRpc as Dispatcher,
    "index.demoSymbol",
    "not-an-object",
    -32602,
  ],
  // -32603, not -32602: with no filesystem roots wired this fails as an internal
  // condition rather than a params one. The code is asserted PER CASE precisely
  // so a change to which code a subsystem raises surfaces here, instead of being
  // absorbed by a blanket expectation.
  [
    "filesystem.ensureRoot / no roots configured",
    tryDispatchFilesystemRpc as Dispatcher,
    "filesystem.ensureRoot",
    {},
    -32603,
  ],
];

describe("dispatchers — domain error → RpcMethodError remapping", () => {
  test.each(CASES)("%s", async (_label, dispatch, method, params, expectedCode) => {
    const db = trackedDb();
    const ctx = makeCtx({ localIndex: new LocalIndex(db), dataDir: "/tmp/nimbus-test" });

    let caught: unknown;
    try {
      await dispatch(ctx, method, params, "client-1");
    } catch (e) {
      caught = e;
    }

    // The whole point: the subsystem's own error type must not escape. It
    // arrives as an RpcMethodError carrying the ORIGINAL rpcCode, so an
    // invalid-params fault stays -32602 rather than degrading to a generic
    // -32603 internal error.
    expect(caught).toBeInstanceOf(RpcMethodError);
    if (caught instanceof RpcMethodError) {
      expect(caught.rpcCode).toBe(expectedCode);
      expect(caught.message.length).toBeGreaterThan(0);
    }
  });

  test("an unrecognised method never enters the try block", async () => {
    // Guards the tests above: if a dispatcher skipped instead of throwing, the
    // `caught` assertions would be measuring nothing. A skip is a plain return.
    const db = trackedDb();
    const ctx = makeCtx({ localIndex: new LocalIndex(db) });
    const out = await tryDispatchIndexRegraphRpc(ctx, "index.notAThing", {});
    expect(out).not.toBeInstanceOf(RpcMethodError);
  });

  /**
   * The `throw e` arm, across every dispatcher that reaches its inner dispatch
   * through `localIndex.getDatabase()`.
   *
   * This is the half that was actually uncovered. The `instanceof` arm above is
   * reached by existing suites; what nothing exercised was what happens when the
   * error is NOT the subsystem's own type. Remapping it would label an internal
   * fault as invalid-params and send the caller looking at their own request.
   */
  const RETHROW_CASES: ReadonlyArray<[string, Dispatcher, string]> = [
    ["index.rebody", tryDispatchIndexRebodyRpc as Dispatcher, "index.rebody"],
    ["index.reembed", tryDispatchIndexReembedRpc as Dispatcher, "index.reembed"],
    ["index.regraph", tryDispatchIndexRegraphRpc as Dispatcher, "index.regraph"],
    ["index.demoSymbol", tryDispatchIndexDemoSymbolRpc as Dispatcher, "index.demoSymbol"],
  ];

  test.each(RETHROW_CASES)("%s rethrows a non-domain error unchanged", async (_l, dispatch, m) => {
    const boom = new Error("disk gone");
    const ctx = makeCtx({
      dataDir: "/tmp/nimbus-test",
      localIndex: {
        getDatabase: () => {
          throw boom;
        },
      } as unknown as LocalIndex,
    });

    let caught: unknown;
    try {
      await dispatch(ctx, m, { repoRoot: "/tmp/x" }, "client-1");
    } catch (e) {
      caught = e;
    }
    // Identity, not just "some error": a remap would have produced a NEW
    // RpcMethodError object and lost the original stack.
    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(RpcMethodError);
  });

  test("a non-domain error propagates unchanged, not remapped", async () => {
    // The `throw e` arm. `localIndex.getDatabase()` throwing is not an
    // IndexRegraphRpcError, so it must surface as itself — remapping an
    // internal fault to -32602 would tell the caller they sent bad params when
    // the gateway is the one that is broken.
    const boom = new Error("disk gone");
    const ctx = makeCtx({
      localIndex: {
        getDatabase: () => {
          throw boom;
        },
      } as unknown as LocalIndex,
    });

    let caught: unknown;
    try {
      await tryDispatchIndexRegraphRpc(ctx, "index.regraph", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(RpcMethodError);
  });
});
