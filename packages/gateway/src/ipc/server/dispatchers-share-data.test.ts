/**
 * dispatchers-share-data.test.ts
 *
 * Coverage additions for the previously-uncovered arms of `dispatchers.ts`:
 *  - `tryDispatchShareRpc` (the whole body was uncovered: skip, hit, ShareRpcError remap)
 *  - `tryDispatchDataRpc` DataRpcError remap + hit return
 *  - `dataRpcPlatform`, the host → recorded-platform mapping `tryDispatchDataRpc` applies, on
 *    every arm regardless of the OS running the suite
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
import {
  dataRpcPlatform,
  tryDispatchDataRpc,
  tryDispatchShareRpc,
  tryDispatchTribalRpc,
} from "./dispatchers.ts";
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
    expect(await tryDispatchShareRpc(ctx, "share.list", {})).toEqual({ shares: [] });
  });

  test("dispatches share.prune (hit path) returning a removed count", async () => {
    const db = trackedDb();
    const ctx = makeCtx({ shareRpcCtx: makeShareRpcCtx(db) });
    expect(await tryDispatchShareRpc(ctx, "share.prune", {})).toEqual({ removed: 0 });
  });

  test("share.create with a denied owner approval persists nothing and returns rejected", async () => {
    const db = trackedDb();
    const ctx = makeCtx({ shareRpcCtx: makeShareRpcCtx(db) });
    const out = (await tryDispatchShareRpc(ctx, "share.create", {
      sessionId: "s1",
    })) as Record<string, unknown>;
    expect(out["status"]).toBe("rejected");
    // I27: a denied approval emits nothing — no share record was written.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM share_records").get()?.n).toBe(0);
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
    // The data module's own code and message survive the remap — not a generic -32603.
    expect((caught as RpcMethodError).rpcCode).toBe(-32602);
    expect((caught as RpcMethodError).message).toBe("Missing param: output");
  });

  test("data.getExportPreflight returns a hit envelope (out.kind === 'hit' return path)", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const ctx = makeCtx({ localIndex });
    // data.getExportPreflight is a read that succeeds against an empty index — hits the return.
    const out = (await tryDispatchDataRpc(ctx, "data.getExportPreflight", {}, "c1")) as {
      lastExportAt: number | null;
      estimatedSizeBytes: number;
      itemCount: number;
    };
    // The index's own answer: never exported, nothing indexed, but a database that has a size.
    expect(out).toMatchObject({ lastExportAt: null, itemCount: 0 });
    expect(out.estimatedSizeBytes).toBeGreaterThan(0);
  });

  test("an unknown data.* method falls through to skipped (miss → phase4RpcSkipped)", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const ctx = makeCtx({ localIndex });
    const out = await tryDispatchDataRpc(ctx, "data.__nope__", {}, "c1");
    expect(out).toBe(phase4RpcSkipped);
  });
});

describe("dataRpcPlatform — the platform a data.* call records", () => {
  // Every arm on every OS: the dispatcher hands it `process.platform`, so without the pure helper
  // only the arm of whichever OS ran the suite was reachable.
  test.each([
    ["win32", "win32"],
    ["darwin", "darwin"],
    ["linux", "linux"],
  ] as const)("a %s host is recorded as %s", (host, recorded) => {
    expect(dataRpcPlatform(host)).toBe(recorded);
  });

  test("a host outside the three supported platforms is recorded as linux, never as itself", () => {
    for (const host of ["freebsd", "openbsd", "sunos", "aix", "android"] as const) {
      expect(dataRpcPlatform(host)).toBe("linux");
    }
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
    // The consent handler `() => undefined` is a client with NO live session, so the consent
    // coordinator cannot ask anyone and the I25 gate fails CLOSED → submitAction returns
    // { status: "rejected" } WITHOUT the dispatcher ever being called. (The owner-approved
    // dispatch is dispatchers-wiring.test.ts's tribal case.)
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    let dispatches = 0;
    const dispatcher: ConnectorDispatcher = {
      dispatch: () => {
        dispatches++;
        return Promise.reject(new Error("no MCP in test"));
      },
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
    expect(dispatches).toBe(0);
    // The gate recorded its refusal, and — I29 — the executor's egress sink ledgered the refused
    // write as `blocked`: a denial is recorded, never silently dropped.
    expect(
      db
        .query<{ action_type: string; hitl_status: string }, []>(
          "SELECT action_type, hitl_status FROM audit_log",
        )
        .all(),
    ).toEqual([{ action_type: "notion.knowledge.write", hitl_status: "rejected" }]);
    expect(
      db
        .query<{ destination: string; result_status: string }, []>(
          "SELECT destination, result_status FROM egress_ledger",
        )
        .all(),
    ).toEqual([{ destination: "notion", result_status: "blocked" }]);
  });
});
