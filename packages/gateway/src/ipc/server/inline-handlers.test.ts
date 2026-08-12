import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EMBEDDING_WARMING_CODE,
  EMBEDDING_WARMING_RPC_CODE,
  type EmbeddingReadiness,
} from "../../embedding/embedding-readiness.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ClientSession } from "../session.ts";
import { createWorkflowCancelHandler, workflowRegistryKey } from "../workflow-cancel.ts";
import type { WorkflowRunContext } from "../workflow-invoke.ts";
import type { ServerCtx } from "./context.ts";
import {
  dispatchAgentInvoke,
  dispatchEngineAskStream,
  dispatchWorkflowRunRpc,
  rpcAuditList,
  rpcConsentRespond,
  rpcGatewayPing,
  rpcIndexSearchRanked,
} from "./inline-handlers.ts";
import { RpcMethodError } from "./rpc-error.ts";

let db: Database | undefined;

beforeEach(() => {
  db = undefined;
});

afterEach(() => {
  if (db !== undefined) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
});

function makeIndex(): LocalIndex {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

interface CtxOpts {
  localIndex?: LocalIndex;
  agentInvokeHandler?: (ctx: unknown) => Promise<{ reply: string }>;
  workflowRunHandler?: (ctx: unknown) => Promise<unknown>;
  getEmbeddingStatus?: () => Record<string, unknown>;
  embeddingReadiness?: () => EmbeddingReadiness;
}

function readiness(over: Partial<EmbeddingReadiness> = {}): EmbeddingReadiness {
  return {
    state: "ready",
    elapsedMs: 0,
    model: "all-MiniLM-L6-v2",
    dims: 384,
    download: null,
    reason: null,
    ...over,
  };
}

function makeCtx(opts: CtxOpts = {}): ServerCtx {
  const ctx: ServerCtx = {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "0.0.0-test",
      ...(opts.localIndex === undefined ? {} : { localIndex: opts.localIndex }),
      ...(opts.getEmbeddingStatus === undefined
        ? {}
        : { getEmbeddingStatus: opts.getEmbeddingStatus }),
      ...(opts.embeddingReadiness === undefined
        ? {}
        : { embeddingReadiness: opts.embeddingReadiness }),
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now() - 5_000,
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => opts.agentInvokeHandler,
    getWorkflowRunHandler: () => opts.workflowRunHandler as never,
    getClientKind: () => "unknown",
  };
  return ctx;
}

function makeSession(): { session: ClientSession; notifications: Array<unknown> } {
  const notifications: Array<unknown> = [];
  const session = {
    writeNotification(n: unknown): void {
      notifications.push(n);
    },
  } as unknown as ClientSession;
  return { session, notifications };
}

describe("rpcGatewayPing", () => {
  test("returns version + uptime + agentLimits without drift by default", () => {
    const ctx = makeCtx();
    const r = rpcGatewayPing(ctx, {}) as Record<string, unknown>;
    expect(r["version"]).toBe("0.0.0-test");
    expect(typeof r["uptime"]).toBe("number");
    expect((r["uptime"] as number) >= 0).toBe(true);
    expect(r["agentLimits"]).toMatchObject({
      maxAgentDepth: expect.any(Number),
      maxToolCallsPerSession: expect.any(Number),
    });
    expect(r["drift"]).toBeUndefined();
  });

  test("includes embedding-status extras when provider is wired", () => {
    const ctx = makeCtx({ getEmbeddingStatus: () => ({ embedding: { mode: "minilm" } }) });
    const r = rpcGatewayPing(ctx, {}) as Record<string, unknown>;
    expect((r["embedding"] as Record<string, unknown>)["mode"]).toBe("minilm");
  });

  test("includeDrift: true with no localIndex returns the not-available drift hint", () => {
    const ctx = makeCtx();
    const r = rpcGatewayPing(ctx, { includeDrift: true }) as {
      drift: { lines: readonly string[] };
    };
    expect(r.drift.lines[0]).toContain("Local index is not available");
  });

  test("includeDrift: true with localIndex calls driftHintsFromIndex", () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    const r = rpcGatewayPing(ctx, { includeDrift: true }) as { drift: { lines: string[] } };
    expect(Array.isArray(r.drift.lines)).toBe(true);
  });

  test("non-record params are treated as no params", () => {
    const ctx = makeCtx();
    const r = rpcGatewayPing(ctx, null) as Record<string, unknown>;
    expect(r["drift"]).toBeUndefined();
  });
});

describe("rpcAuditList", () => {
  test("returns [] when localIndex is undefined", () => {
    const ctx = makeCtx();
    expect(rpcAuditList(ctx, {})).toEqual([]);
  });

  test("delegates to localIndex.listAudit with default limit when no params", () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    const r = rpcAuditList(ctx, undefined);
    expect(Array.isArray(r)).toBe(true);
  });

  test("limit is clamped to [1, 1000] and floored", () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    expect(Array.isArray(rpcAuditList(ctx, { limit: 0 }))).toBe(true);
    expect(Array.isArray(rpcAuditList(ctx, { limit: 9999 }))).toBe(true);
    expect(Array.isArray(rpcAuditList(ctx, { limit: 5.9 }))).toBe(true);
    expect(Array.isArray(rpcAuditList(ctx, { limit: "many" }))).toBe(true);
  });
});

describe("rpcConsentRespond", () => {
  test("invalid params surface as RpcMethodError", () => {
    const ctx = makeCtx();
    expect(() => rpcConsentRespond(ctx, "client-1", { bogus: true })).toThrow(RpcMethodError);
  });
});

describe("rpcIndexSearchRanked — param validation", () => {
  test("no localIndex -> -32603", async () => {
    const ctx = makeCtx();
    await expect(rpcIndexSearchRanked(ctx, {})).rejects.toThrow(/Local index is not available/);
  });

  test("non-record params -> -32602", async () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    await expect(rpcIndexSearchRanked(ctx, null)).rejects.toThrow(/Invalid params/);
  });

  test("empty params resolve to defaults and return an array", async () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    const r = await rpcIndexSearchRanked(ctx, {});
    expect(r).toBeDefined();
  });

  test("limit / contextChunks / semantic / service / itemType / name parse-through", async () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    const r = await rpcIndexSearchRanked(ctx, {
      name: "alpha",
      service: "github",
      itemType: "pr",
      limit: 1.9,
      semantic: false,
      contextChunks: 9.9,
    });
    expect(r).toBeDefined();
  });

  test("non-finite limit + contextChunks fall back to defaults", async () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    const r = await rpcIndexSearchRanked(ctx, {
      limit: Number.POSITIVE_INFINITY,
      contextChunks: Number.NaN,
    });
    expect(r).toBeDefined();
  });
});

describe("dispatchAgentInvoke", () => {
  test("returns the echo reply when no handler is configured", async () => {
    const ctx = makeCtx();
    const { session } = makeSession();
    const r = (await dispatchAgentInvoke(ctx, session, "client-1", { input: "hello" })) as {
      reply: string;
      stream: boolean;
    };
    expect(r.reply).toContain("Agent invoke is not configured");
    expect(r.reply).toContain("hello");
    expect(r.stream).toBe(false);
  });

  test("invokes handler with parsed sessionId + agent + stream flag", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (payload: unknown): Promise<{ reply: string }> => {
      captured = payload as Record<string, unknown>;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session, notifications } = makeSession();
    const r = (await dispatchAgentInvoke(ctx, session, "client-1", {
      input: "hi",
      stream: true,
      sessionId: "s1",
      agent: "devops",
    })) as { reply: string };
    expect(r.reply).toBe("ok");
    expect(captured?.["clientId"]).toBe("client-1");
    expect(captured?.["sessionId"]).toBe("s1");
    expect(captured?.["agent"]).toBe("devops");
    expect(captured?.["stream"]).toBe(true);

    const sendChunk = captured?.["sendChunk"] as (text: string) => void;
    sendChunk("chunk-1");
    expect(notifications).toHaveLength(1);
    expect((notifications[0] as { method: string }).method).toBe("agent.chunk");
  });

  test("non-streaming sendChunk is a no-op", async () => {
    let sendChunk: ((t: string) => void) | undefined;
    const handler = async (payload: unknown): Promise<{ reply: string }> => {
      sendChunk = (payload as { sendChunk: (t: string) => void }).sendChunk;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session, notifications } = makeSession();
    await dispatchAgentInvoke(ctx, session, "client-1", { input: "x", stream: false });
    sendChunk?.("text-suppressed");
    expect(notifications).toHaveLength(0);
  });

  test("whitespace-only sessionId / agent become undefined", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (p: unknown): Promise<{ reply: string }> => {
      captured = p as Record<string, unknown>;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session } = makeSession();
    await dispatchAgentInvoke(ctx, session, "c", { input: "x", sessionId: "   ", agent: "" });
    expect(captured?.["sessionId"]).toBeUndefined();
    expect(captured?.["agent"]).toBeUndefined();
  });

  test("agent.chunk carries streamId when the caller supplies one", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (payload: unknown): Promise<{ reply: string }> => {
      captured = payload as Record<string, unknown>;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session, notifications } = makeSession();
    await dispatchAgentInvoke(ctx, session, "client-1", {
      input: "hi",
      stream: true,
      streamId: "sid-1",
    });
    const sendChunk = captured?.["sendChunk"] as (t: string) => void;
    sendChunk("chunk-1");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { streamId: "sid-1", text: "chunk-1" },
    });
  });

  test("agent.chunk params are unchanged when no streamId is supplied", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (payload: unknown): Promise<{ reply: string }> => {
      captured = payload as Record<string, unknown>;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session, notifications } = makeSession();
    await dispatchAgentInvoke(ctx, session, "client-1", { input: "hi", stream: true });
    const sendChunk = captured?.["sendChunk"] as (t: string) => void;
    sendChunk("chunk-1");
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { text: "chunk-1" },
    });
  });

  test("whitespace-only streamId is treated as absent", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (payload: unknown): Promise<{ reply: string }> => {
      captured = payload as Record<string, unknown>;
      return { reply: "ok" };
    };
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session, notifications } = makeSession();
    await dispatchAgentInvoke(ctx, session, "client-1", {
      input: "hi",
      stream: true,
      streamId: "   ",
    });
    const sendChunk = captured?.["sendChunk"] as (t: string) => void;
    sendChunk("c");
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { text: "c" },
    });
  });
});

describe("dispatchWorkflowRunRpc", () => {
  test("no localIndex -> -32603", async () => {
    const ctx = makeCtx();
    const { session } = makeSession();
    await expect(dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "wf" })).rejects.toThrow(
      /Local index is not available/,
    );
  });

  test("no workflow handler -> -32603", async () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    const { session } = makeSession();
    await expect(dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "wf" })).rejects.toThrow(
      /Workflow runner is not configured/,
    );
  });

  test("missing name -> -32602", async () => {
    const handler = async (): Promise<unknown> => ({});
    const ctx = makeCtx({ localIndex: makeIndex(), workflowRunHandler: handler });
    const { session } = makeSession();
    await expect(dispatchWorkflowRunRpc(ctx, "c", session, {})).rejects.toThrow(
      /Missing or invalid name/,
    );
  });

  test("paramsOverride: non-object -> -32602", async () => {
    const handler = async (): Promise<unknown> => ({});
    const ctx = makeCtx({ localIndex: makeIndex(), workflowRunHandler: handler });
    const { session } = makeSession();
    await expect(
      dispatchWorkflowRunRpc(ctx, "c", session, { name: "wf", paramsOverride: [] }),
    ).rejects.toThrow(/paramsOverride must be an object/);
  });

  test("happy path invokes handler with parsed context", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = async (payload: unknown): Promise<unknown> => {
      captured = payload as Record<string, unknown>;
      return { runId: "r1" };
    };
    const ctx = makeCtx({ localIndex: makeIndex(), workflowRunHandler: handler });
    const { session } = makeSession();
    const r = (await dispatchWorkflowRunRpc(ctx, "c", session, {
      name: "wf",
      triggeredBy: "user",
      dryRun: true,
      stream: true,
      sessionId: "s1",
      agent: "devops",
      paramsOverride: { step1: { foo: "bar" } },
    })) as { runId: string };
    expect(r.runId).toBe("r1");
    expect(captured?.["workflowName"]).toBe("wf");
    expect(captured?.["triggeredBy"]).toBe("user");
    expect(captured?.["dryRun"]).toBe(true);
    expect(captured?.["stream"]).toBe(true);
    expect(captured?.["sessionId"]).toBe("s1");
    expect(captured?.["agent"]).toBe("devops");
    expect(captured?.["paramsOverride"]).toEqual({ step1: { foo: "bar" } });
  });

  test("paramsOverride: null is treated as undefined (no throw)", async () => {
    const handler = async (): Promise<unknown> => ({ ok: true });
    const ctx = makeCtx({ localIndex: makeIndex(), workflowRunHandler: handler });
    const { session } = makeSession();
    const r = await dispatchWorkflowRunRpc(ctx, "c", session, {
      name: "wf",
      paramsOverride: null,
    });
    expect(r).toBeDefined();
  });

  test("workflow chunks carry the supplied streamId", async () => {
    let captured: WorkflowRunContext | undefined;
    const ctx = makeCtx({
      localIndex: makeIndex(),
      workflowRunHandler: async (c: unknown) => {
        captured = c as WorkflowRunContext;
        return { runId: "r1", status: "done", dryRun: false, stepResults: [] };
      },
    });
    const { session, notifications } = makeSession();
    await dispatchWorkflowRunRpc(ctx, "client-1", session, {
      name: "nightly",
      stream: true,
      streamId: "wf-sid-1",
    });
    captured?.sendChunk("step output");
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { streamId: "wf-sid-1", text: "step output" },
    });
  });

  test("registers the run under a per-client key and unregisters when it finishes", async () => {
    let seenDuringRun = false;
    let captured: WorkflowRunContext | undefined;
    const key = workflowRegistryKey("client-1", "wf-sid-2");
    const ctx = makeCtx({
      localIndex: makeIndex(),
      workflowRunHandler: async (c: unknown) => {
        captured = c as WorkflowRunContext;
        seenDuringRun = ctx.streamRegistry.has(key);
        return { runId: "r1", status: "done", dryRun: false, stepResults: [] };
      },
    });
    const { session } = makeSession();

    await dispatchWorkflowRunRpc(ctx, "client-1", session, {
      name: "nightly",
      streamId: "wf-sid-2",
    });

    expect(seenDuringRun).toBe(true);
    expect(captured?.signal).toBeDefined();
    expect(ctx.streamRegistry.has(key)).toBe(false);
    // The bare id is never a registry key.
    expect(ctx.streamRegistry.has("wf-sid-2")).toBe(false);
  });

  test("two clients may use the same streamId without colliding", async () => {
    const release: Array<() => void> = [];
    const ctx = makeCtx({
      localIndex: makeIndex(),
      workflowRunHandler: async () =>
        await new Promise((resolve) => {
          release.push(() =>
            resolve({ runId: "r", status: "done", dryRun: false, stepResults: [] }),
          );
        }),
    });
    const { session } = makeSession();

    const a = dispatchWorkflowRunRpc(ctx, "client-a", session, { name: "n", streamId: "same" });
    const b = dispatchWorkflowRunRpc(ctx, "client-b", session, { name: "n", streamId: "same" });

    expect(ctx.streamRegistry.has(workflowRegistryKey("client-a", "same"))).toBe(true);
    expect(ctx.streamRegistry.has(workflowRegistryKey("client-b", "same"))).toBe(true);

    for (const r of release) r();
    await Promise.all([a, b]);
    expect(ctx.streamRegistry.size()).toBe(0);
  });

  test("the same client reusing a live streamId is rejected", async () => {
    const ctx = makeCtx({
      localIndex: makeIndex(),
      workflowRunHandler: async () => await new Promise(() => {}),
    });
    const { session } = makeSession();

    void dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "dupe" });

    await expect(
      dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "dupe" }),
    ).rejects.toThrow(RpcMethodError);
  });

  test("unregisters even when the run throws", async () => {
    const ctx = makeCtx({
      localIndex: makeIndex(),
      workflowRunHandler: async () => {
        throw new Error("boom");
      },
    });
    const { session } = makeSession();

    await expect(
      dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "wf-sid-3" }),
    ).rejects.toThrow("boom");
    expect(ctx.streamRegistry.has(workflowRegistryKey("client-1", "wf-sid-3"))).toBe(false);
  });

  test("a run without a streamId registers nothing", async () => {
    const ctx = makeCtx({
      localIndex: makeIndex(),
      workflowRunHandler: async () => ({ runId: "r1", dryRun: false, stepResults: [] }),
    });
    const { session } = makeSession();
    await dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "nightly" });
    expect(ctx.streamRegistry.size()).toBe(0);
  });

  test("rejects a streamId containing the registry's separator byte", async () => {
    const handler = async (): Promise<unknown> => ({ runId: "r1", dryRun: false, stepResults: [] });
    const ctx = makeCtx({ localIndex: makeIndex(), workflowRunHandler: handler });
    const { session } = makeSession();
    await expect(
      dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "bad\u0000id" }),
    ).rejects.toThrow(RpcMethodError);
    expect(ctx.streamRegistry.size()).toBe(0);
  });

  // Reproduces the sequence: cancel a live run (registry.cancel deletes the
  // entry immediately, but the run itself keeps executing until its next
  // step boundary), reuse the same streamId while the cancelled run is still
  // winding down, then let the first run's `finally` fire. A plain
  // `unregister` there would delete the SECOND run's live entry, leaving it
  // silently uncancellable forever.
  test("cancel-then-reuse: a stale finally does not evict the successor's live entry", async () => {
    const releases: Array<() => void> = [];
    const ctx = makeCtx({
      localIndex: makeIndex(),
      workflowRunHandler: async () =>
        await new Promise((resolve) => {
          releases.push(() =>
            resolve({ runId: "r", status: "cancelled", dryRun: false, stepResults: [] }),
          );
        }),
    });
    const { session } = makeSession();
    const key = workflowRegistryKey("client-1", "x");
    const cancelHandler = createWorkflowCancelHandler(ctx.streamRegistry);

    // First run registers under `key`.
    const first = dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "x" });
    expect(ctx.streamRegistry.has(key)).toBe(true);

    // Cancel it: the entry is deleted immediately, even though the run
    // itself (the unresolved promise above) is still winding down.
    expect(cancelHandler("client-1", { streamId: "x" })).toEqual({ cancelled: true });
    expect(ctx.streamRegistry.has(key)).toBe(false);

    // Reuse the same id: the duplicate-check sees nothing live, so it
    // registers a NEW controller under the same key.
    const second = dispatchWorkflowRunRpc(ctx, "client-1", session, { name: "n", streamId: "x" });
    expect(ctx.streamRegistry.has(key)).toBe(true);

    // Let the FIRST run reach its boundary now. Its `finally` must not evict
    // the second run's live entry.
    releases[0]?.();
    await first;
    expect(ctx.streamRegistry.has(key)).toBe(true);

    // The second run must still be cancellable.
    expect(cancelHandler("client-1", { streamId: "x" })).toEqual({ cancelled: true });

    releases[1]?.();
    await second;
    expect(ctx.streamRegistry.has(key)).toBe(false);
  });
});

describe("dispatchEngineAskStream", () => {
  test("no agent handler -> -32603", () => {
    const ctx = makeCtx();
    const { session } = makeSession();
    expect(() => dispatchEngineAskStream(ctx, session, "c", { input: "hi" })).toThrow(
      /No agent handler configured/,
    );
  });

  test("returns streamId when handler is present", async () => {
    const handler = async (): Promise<{ reply: string }> => ({ reply: "done" });
    const ctx = makeCtx({ agentInvokeHandler: handler });
    const { session } = makeSession();
    const r = await dispatchEngineAskStream(ctx, session, "c", { input: "hi", sessionId: "s1" });
    expect(typeof r.streamId).toBe("string");
    expect(r.streamId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #928 — the gateway binds before the embedding model is loaded, so a semantic query can
// arrive while there are no vectors yet. It must say so, not return a lexical-only result
// the caller reads as a complete answer.
// ---------------------------------------------------------------------------

describe("rpcIndexSearchRanked — embedding warm-up (false-green guard)", () => {
  test("a semantic query while WARMING returns the typed warming condition, not []", async () => {
    const ctx = makeCtx({
      localIndex: makeIndex(),
      embeddingReadiness: () => readiness({ state: "warming", elapsedMs: 12_000, download: null }),
    });
    // The index is empty, so the unguarded path resolves to `[]` — a false green that is
    // indistinguishable from "searched everything, found nothing".
    let resolved: unknown = "not-called";
    let thrown: unknown;
    try {
      resolved = await rpcIndexSearchRanked(ctx, { name: "who owns billing" });
    } catch (err) {
      thrown = err;
    }
    expect(resolved).toBe("not-called");
    expect(thrown).toBeInstanceOf(RpcMethodError);
    const rpcErr = thrown as RpcMethodError;
    expect(rpcErr.rpcCode).toBe(EMBEDDING_WARMING_RPC_CODE);
    expect(rpcErr.message).toContain("warming up");
    const data = rpcErr.rpcData;
    expect(data).toBeDefined();
    expect(data?.["code"]).toBe(EMBEDDING_WARMING_CODE);
    const wire = data?.["readiness"] as EmbeddingReadiness;
    expect(wire.state).toBe("warming");
    expect(wire.elapsedMs).toBe(12_000);
  });

  test("download progress rides along so a client can show real progress", async () => {
    const ctx = makeCtx({
      localIndex: makeIndex(),
      embeddingReadiness: () =>
        readiness({
          state: "warming",
          download: { file: "model.onnx", loadedBytes: 45, totalBytes: 90, percent: 50 },
        }),
    });
    const err = (await rpcIndexSearchRanked(ctx, { name: "q" }).catch(
      (e: unknown) => e,
    )) as RpcMethodError;
    expect(err.message).toContain("model.onnx");
    expect(err.message).toContain("50%");
  });

  test("an explicitly NON-semantic query is served while warming (keyword-only, honestly)", async () => {
    const ctx = makeCtx({
      localIndex: makeIndex(),
      embeddingReadiness: () => readiness({ state: "warming" }),
    });
    const r = await rpcIndexSearchRanked(ctx, { name: "q", semantic: false });
    expect(Array.isArray(r)).toBe(true);
  });

  test("ready / disabled / unavailable all serve normally — only WARMING is transient", async () => {
    for (const state of ["ready", "disabled", "unavailable"] as const) {
      const ctx = makeCtx({
        localIndex: makeIndex(),
        embeddingReadiness: () => readiness({ state }),
      });
      const r = await rpcIndexSearchRanked(ctx, { name: "q" });
      expect(Array.isArray(r)).toBe(true);
    }
  });

  test("no readiness provider wired -> unchanged behaviour", async () => {
    const ctx = makeCtx({ localIndex: makeIndex() });
    const r = await rpcIndexSearchRanked(ctx, { name: "q" });
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("rpcGatewayPing — embedding readiness", () => {
  test("reports the live warm-up state so a client can render real progress", () => {
    const ctx = makeCtx({
      getEmbeddingStatus: () => ({
        embeddingBackfill: null,
        embedding: readiness({
          state: "warming",
          elapsedMs: 4_000,
          download: { file: "model.onnx", loadedBytes: 10, totalBytes: 40, percent: 25 },
        }),
      }),
    });
    const r = rpcGatewayPing(ctx, {}) as Record<string, unknown>;
    const emb = r["embedding"] as EmbeddingReadiness;
    expect(emb.state).toBe("warming");
    expect(emb.download?.percent).toBe(25);
    expect(emb.elapsedMs).toBe(4_000);
  });
});
