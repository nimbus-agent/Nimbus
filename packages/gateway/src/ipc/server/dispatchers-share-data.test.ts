/**
 * dispatchers-share-data.test.ts
 *
 * Coverage additions for the previously-uncovered arms of `dispatchers.ts`:
 *  - `tryDispatchShareRpc` (the whole body was uncovered: skip, hit, ShareRpcError remap)
 *  - `tryDispatchDataRpc` DataRpcError remap + hit return
 *  - the `tribal.capture` executor branch (dispatcher + index wired)
 *  - several typed-error → RpcMethodError remap arms not hit elsewhere
 *
 * Rules: no `any` (cast through `unknown`); DI via the context builder (no `mock.module`);
 * no sleeps / `.unref()` on awaited timers; production behaviour unchanged.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { ConnectorDispatcher } from "../../engine/types.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ShareRpcCtx } from "../share-rpc.ts";
import type { TribalRpcCtx } from "../tribal-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { tryDispatchDataRpc, tryDispatchShareRpc, tryDispatchTribalRpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  openDbs.length = 0;
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

function makeShareRpcCtx(db: Database, overrides: Partial<ShareRpcCtx> = {}): ShareRpcCtx {
  return {
    db,
    vault: createMockVault(),
    label: "test-host",
    now: () => 1_700_000_000_000,
    collectSession: async () => ({ turns: [], toolCalls: [] }),
    // Denies by default (fail-closed); a share.create therefore persists/signs nothing.
    requestApproval: async () => false,
    recordAudit: () => {},
    respondApproval: () => false,
    httpSink: { url: "" },
    listReplayTools: async () => ({}),
    ...overrides,
  };
}

describe("tryDispatchShareRpc", () => {
  test("skips a non-share method", async () => {
    const ctx = makeCtx();
    expect(await tryDispatchShareRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });

  test("skips when shareRpcCtx is not wired", async () => {
    const ctx = makeCtx();
    expect(await tryDispatchShareRpc(ctx, "share.list", {})).toBe(phase4RpcSkipped);
  });

  test("dispatches share.list (hit path) when the ctx is wired", async () => {
    const db = trackedDb();
    const ctx = makeCtx({ shareRpcCtx: makeShareRpcCtx(db) });
    const out = (await tryDispatchShareRpc(ctx, "share.list", {})) as Record<string, unknown>;
    expect(Array.isArray(out["shares"])).toBe(true);
  });

  test("dispatches share.prune (hit path) returning a removed count", async () => {
    const db = trackedDb();
    const ctx = makeCtx({ shareRpcCtx: makeShareRpcCtx(db) });
    const out = (await tryDispatchShareRpc(ctx, "share.prune", {})) as Record<string, unknown>;
    expect(typeof out["removed"]).toBe("number");
  });

  test("share.create with a denied owner approval persists nothing and returns rejected", async () => {
    const db = trackedDb();
    const ctx = makeCtx({ shareRpcCtx: makeShareRpcCtx(db) });
    const out = (await tryDispatchShareRpc(ctx, "share.create", {
      sessionId: "s1",
    })) as Record<string, unknown>;
    expect(out["status"]).toBe("rejected");
  });

  test("ShareRpcError from the inner dispatch remaps to RpcMethodError", async () => {
    const db = trackedDb();
    const ctx = makeCtx({ shareRpcCtx: makeShareRpcCtx(db) });
    // share.create without a (non-empty string) sessionId → ShareRpcError(-32602) inside the handler.
    let caught: unknown;
    try {
      await tryDispatchShareRpc(ctx, "share.create", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    if (caught instanceof RpcMethodError) {
      expect(caught.rpcCode).toBe(-32602);
    }
  });

  test("an unknown share.* method falls through to skipped", async () => {
    const db = trackedDb();
    const ctx = makeCtx({ shareRpcCtx: makeShareRpcCtx(db) });
    expect(await tryDispatchShareRpc(ctx, "share.__nope__", {})).toBe(phase4RpcSkipped);
  });
});

describe("tryDispatchDataRpc — hit + DataRpcError remap", () => {
  test("data.* with localIndex and missing output remaps the DataRpcError to RpcMethodError", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const ctx = makeCtx({ localIndex });
    // data.export with no `output` → DataRpcError inside dispatchDataRpc → remapped.
    let caught: unknown;
    try {
      await tryDispatchDataRpc(ctx, "data.export", {}, "c1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
  });

  test("data.getExportPreflight returns a hit envelope (out.kind === 'hit' return path)", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const ctx = makeCtx({ localIndex });
    // data.getExportPreflight is a read that succeeds against an empty index — hits the return.
    const out = await tryDispatchDataRpc(ctx, "data.getExportPreflight", {}, "c1");
    expect(out).toBeDefined();
    expect(out).not.toBe(phase4RpcSkipped);
  });

  test("an unknown data.* method falls through to skipped (miss → phase4RpcSkipped)", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const ctx = makeCtx({ localIndex });
    const out = await tryDispatchDataRpc(ctx, "data.__nope__", {}, "c1");
    expect(out).toBe(phase4RpcSkipped);
  });
});

describe("tryDispatchTribalRpc — capture executor branch", () => {
  function makeTribalRpcCtx(overrides: Partial<TribalRpcCtx> = {}): TribalRpcCtx {
    return {
      status: () => ({ enabled: true, clusters: 0 }),
      start: async () => {},
      stop: async () => {},
      list: () => [],
      dismiss: async () => {},
      scan: async () => ({ scanned: 0, fired: 0 }),
      capture: async () => ({ ok: true, pageRef: "notion:pg1" }),
      ...overrides,
    };
  }

  test("tribal.capture with dispatcher + index builds the executor and runs submitAction", async () => {
    // dispatcher + localIndex both present → the real ToolExecutor submitAction closure runs.
    // The consent handler `() => undefined` auto-approves the gate; the stub dispatcher's reject
    // then makes execute() fail → submitAction returns { status: "rejected" }.
    const localIndex = new LocalIndex(trackedDb());
    const dispatcher: ConnectorDispatcher = {
      dispatch: () => Promise.reject(new Error("no MCP in test")),
    };
    let submittedStatus: string | undefined;
    const rpc = makeTribalRpcCtx({
      capture: async (clusterId, _target, submit) => {
        expect(clusterId).toBe("cluster-1");
        const r = await submit({ type: "notion.knowledge.write", payload: { a: 1 } });
        submittedStatus = r.status;
        return r.status === "approved"
          ? { ok: true, pageRef: "x" }
          : { ok: false, error: "rejected" };
      },
    });
    const ctx = makeCtx({
      localIndex,
      tribalRpcCtx: rpc,
      tribalConnectorDispatcher: dispatcher,
    });
    const out = await tryDispatchTribalRpc(ctx, "tribal.capture", { clusterId: "cluster-1" }, "c1");
    expect(out).toEqual({ ok: false, error: "rejected" });
    expect(submittedStatus).toBe("rejected");
  });
});
