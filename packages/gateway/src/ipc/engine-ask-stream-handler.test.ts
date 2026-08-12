import { describe, expect, test } from "bun:test";

import {
  type AskStreamHandlerDeps,
  createAskStreamHandler,
  type StreamRegistry,
} from "./engine-ask-stream.ts";

function makeRegistry(): StreamRegistry {
  const map = new Map<string, AbortController>();
  return {
    register: (id, ac) => {
      map.set(id, ac);
    },
    cancel: (id) => {
      const ac = map.get(id);
      if (ac === undefined) return false;
      ac.abort();
      map.delete(id);
      return true;
    },
    unregister: (id) => {
      map.delete(id);
    },
    unregisterIf: (id, ac) => {
      if (map.get(id) === ac) {
        map.delete(id);
      }
    },
    has: (id) => map.has(id),
    size: () => map.size,
  };
}

describe("createAskStreamHandler", () => {
  test("returns streamId immediately and emits tokens via sendChunk", async () => {
    const registry = makeRegistry();
    const notifications: { method: string; params: Record<string, unknown> }[] = [];
    const deps: AskStreamHandlerDeps = {
      registry,
      randomId: () => "stream-test-1",
      sessionWriteNotification: (n) => notifications.push(n),
      runWithRequestContext: async (_ctx, fn) => fn(),
      agentInvokeHandler: async (ctx) => {
        ctx.sendChunk?.("hello");
        ctx.sendChunk?.(" world");
        return { reply: "hello world" };
      },
    };
    const handler = createAskStreamHandler(deps);
    const result = await handler("client-1", { input: "say hi" });
    expect(result).toEqual({ streamId: "stream-test-1" });
    await new Promise((r) => setTimeout(r, 10));
    const tokens = notifications.filter((n) => n.method === "engine.streamToken");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.params).toMatchObject({ streamId: "stream-test-1", text: "hello" });
    const done = notifications.find((n) => n.method === "engine.streamDone");
    expect(done).toBeDefined();
  });

  test("emits typed model metadata when handler returns it", async () => {
    const registry = makeRegistry();
    const notifications: { method: string; params: Record<string, unknown> }[] = [];
    const deps: AskStreamHandlerDeps = {
      registry,
      randomId: () => "stream-meta-1",
      sessionWriteNotification: (n) => notifications.push(n),
      runWithRequestContext: async (_ctx, fn) => fn(),
      agentInvokeHandler: async () => ({
        reply: "ok",
        modelMeta: {
          text: "ok",
          tokensIn: 3,
          tokensOut: 1,
          modelUsed: "local-test-model:latest",
          isLocal: true,
          provider: "ollama",
        },
      }),
    };
    const handler = createAskStreamHandler(deps);
    await handler("client-1", { input: "say hi" });
    await new Promise((r) => setTimeout(r, 10));
    const done = notifications.find((n) => n.method === "engine.streamDone");
    expect(done?.params["meta"]).toMatchObject({
      modelUsed: "local-test-model:latest",
      isLocal: true,
      provider: "ollama",
      tokensIn: 3,
      tokensOut: 1,
    });
  });

  test("emits engine.streamError when handler throws", async () => {
    const registry = makeRegistry();
    const notifications: { method: string; params: Record<string, unknown> }[] = [];
    const deps: AskStreamHandlerDeps = {
      registry,
      randomId: () => "stream-test-2",
      sessionWriteNotification: (n) => notifications.push(n),
      runWithRequestContext: async (_ctx, fn) => fn(),
      agentInvokeHandler: async () => {
        throw new Error("boom");
      },
    };
    const handler = createAskStreamHandler(deps);
    await handler("client-1", { input: "" });
    await new Promise((r) => setTimeout(r, 10));
    const err = notifications.find((n) => n.method === "engine.streamError");
    expect(err?.params).toMatchObject({ streamId: "stream-test-2", error: "boom" });
  });

  test("cancellation aborts the stream and emits streamError with cancelled code", async () => {
    const registry = makeRegistry();
    const notifications: { method: string; params: Record<string, unknown> }[] = [];
    let signalSeen: AbortSignal | undefined;
    const deps: AskStreamHandlerDeps = {
      registry,
      randomId: () => "stream-cancel-1",
      sessionWriteNotification: (n) => notifications.push(n),
      runWithRequestContext: async (_ctx, fn) => fn(),
      agentInvokeHandler: async (ctx) => {
        signalSeen = ctx.signal;
        for (let i = 0; i < 100; i += 1) {
          if (ctx.signal?.aborted) {
            throw new Error("cancelled");
          }
          await new Promise((r) => setTimeout(r, 1));
        }
        return { reply: "done" };
      },
    };
    const handler = createAskStreamHandler(deps);
    await handler("client-1", { input: "long" });
    await new Promise((r) => setTimeout(r, 5));
    expect(registry.has("stream-cancel-1")).toBe(true);
    expect(registry.cancel("stream-cancel-1")).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(signalSeen?.aborted).toBe(true);
    const err = notifications.find((n) => n.method === "engine.streamError");
    expect(err?.params).toMatchObject({ streamId: "stream-cancel-1", code: "cancelled" });
  });

  test("registry is cleared after stream completion", async () => {
    const registry = makeRegistry();
    const deps: AskStreamHandlerDeps = {
      registry,
      randomId: () => "stream-cleanup-1",
      sessionWriteNotification: () => undefined,
      runWithRequestContext: async (_c, fn) => fn(),
      agentInvokeHandler: async () => ({ reply: "done" }),
    };
    const handler = createAskStreamHandler(deps);
    await handler("client-1", { input: "" });
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.has("stream-cleanup-1")).toBe(false);
  });
});
