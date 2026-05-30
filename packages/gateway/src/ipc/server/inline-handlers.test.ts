import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ClientSession } from "../session.ts";
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
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now() - 5_000,
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => opts.agentInvokeHandler as never,
    getWorkflowRunHandler: () => opts.workflowRunHandler as never,
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
    expect(notifications.length).toBe(1);
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
