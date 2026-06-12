import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createAskStream } from "../src/ask-stream.ts";
import type { StreamEvent } from "../src/stream-events.ts";

type CallSpy = { method: string; params: unknown };

class FakeIpc {
  public calls: CallSpy[] = [];
  public notifHandlers = new Map<string, ((p: unknown) => void)[]>();
  public askStreamResult: unknown = { streamId: "stream-1" };

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "engine.askStream") return this.askStreamResult;
    if (method === "engine.cancelStream") return { ok: true };
    return undefined;
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    let arr = this.notifHandlers.get(method);
    if (arr === undefined) {
      arr = [];
      this.notifHandlers.set(method, arr);
    }
    arr.push(handler);
  }

  emit(method: string, params: unknown): void {
    for (const h of this.notifHandlers.get(method) ?? []) h(params);
  }
}

let ipc: FakeIpc;

beforeEach(() => {
  ipc = new FakeIpc();
});

// Restore globalThis.fetch if a test mutates it (safety net)
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function startAndDrain(
  ipcInstance: FakeIpc,
  opts?: Parameters<typeof createAskStream>[2],
): Promise<{
  handle: ReturnType<typeof createAskStream>;
  events: StreamEvent[];
  drain: Promise<void>;
}> {
  const handle = createAskStream(ipcInstance as never, "hello", opts);
  const events: StreamEvent[] = [];
  const drain = (async () => {
    for await (const ev of handle) events.push(ev);
  })();
  await Promise.resolve();
  await Promise.resolve();
  return { handle, events, drain };
}

describe("askStream", () => {
  test("yields token then done events in order", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamToken", { streamId: "stream-1", text: "hi" });
    ipc.emit("engine.streamToken", { streamId: "stream-1", text: " there" });
    ipc.emit("engine.streamDone", {
      streamId: "stream-1",
      meta: { reply: "hi there", sessionId: "sess-1" },
    });
    await drain;
    expect(events.map((e) => e.type)).toEqual(["token", "token", "done"]);
    expect(events[0]).toMatchObject({ type: "token", text: "hi" });
    expect(events[2]).toMatchObject({ type: "done", sessionId: "sess-1" });
  });

  test("ignores notifications for a different streamId", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamToken", { streamId: "stream-OTHER", text: "nope" });
    ipc.emit("engine.streamToken", { streamId: "stream-1", text: "yes" });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    expect(events.length).toBe(2);
    expect((events[0] as { text: string }).text).toBe("yes");
  });

  test("error event terminates iterator", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamError", {
      streamId: "stream-1",
      code: "boom",
      error: "bad",
    });
    await drain;
    expect(events).toEqual([{ type: "error", code: "boom", message: "bad" }]);
  });

  test("cancel() calls engine.cancelStream and terminates iterator", async () => {
    const { handle, drain } = await startAndDrain(ipc);
    await handle.cancel();
    await drain;
    const cancelCall = ipc.calls.find((c) => c.method === "engine.cancelStream");
    expect(cancelCall).toBeDefined();
    expect(cancelCall?.params).toMatchObject({ streamId: "stream-1" });
  });

  test("subTaskProgress and hitlBatch events flow through", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("agent.subTaskProgress", {
      streamId: "stream-1",
      subTaskId: "st1",
      status: "running",
      progress: 0.5,
    });
    ipc.emit("agent.hitlBatch", {
      streamId: "stream-1",
      requestId: "r1",
      prompt: "Approve?",
    });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    expect(events.map((e) => e.type)).toEqual(["subTaskProgress", "hitlBatch", "done"]);
  });

  // ── matchesStream false arms ───────────────────────────────────────────────

  test("ignores token notification when params is null", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamToken", null);
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    // null fails matchesStream, so only the done event lands
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  test("ignores token notification when params is a non-object primitive", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamToken", "not-an-object");
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  test("ignores token notification when streamId is missing from params", async () => {
    const { events, drain } = await startAndDrain(ipc);
    // streamId is missing → matchesStream returns false
    ipc.emit("engine.streamToken", { text: "orphan" });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  // ── onToken: text not a string ────────────────────────────────────────────

  test("ignores token notification when text is not a string", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamToken", { streamId: "stream-1", text: 42 });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    // non-string text skips push; only done lands
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  // ── onDone: meta absent / reply+sessionId fallback ────────────────────────

  test("done event uses empty-string defaults when meta is absent", async () => {
    const { events, drain } = await startAndDrain(ipc);
    // no meta field → meta ?? {} → reply="" sessionId=""
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    const done = events.find((e) => e.type === "done") as
      | { type: "done"; reply: string; sessionId: string }
      | undefined;
    expect(done?.reply).toBe("");
    expect(done?.sessionId).toBe("");
  });

  test("done event uses empty-string defaults when reply/sessionId are non-strings", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamDone", {
      streamId: "stream-1",
      meta: { reply: 123, sessionId: true },
    });
    await drain;
    const done = events.find((e) => e.type === "done") as
      | { type: "done"; reply: string; sessionId: string }
      | undefined;
    expect(done?.reply).toBe("");
    expect(done?.sessionId).toBe("");
  });

  // ── onError: code/error fallback defaults ─────────────────────────────────

  test("error event uses default code when code is absent", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamError", { streamId: "stream-1", error: "oops" });
    await drain;
    const err = events[0] as { type: "error"; code: string; message: string };
    expect(err.code).toBe("stream_error");
    expect(err.message).toBe("oops");
  });

  test("error event uses default message when error field is absent", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamError", { streamId: "stream-1", code: "e42" });
    await drain;
    const err = events[0] as { type: "error"; code: string; message: string };
    expect(err.code).toBe("e42");
    expect(err.message).toBe("Stream error");
  });

  test("error event uses both defaults when code and error fields are absent", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamError", { streamId: "stream-1" });
    await drain;
    const err = events[0] as { type: "error"; code: string; message: string };
    expect(err.code).toBe("stream_error");
    expect(err.message).toBe("Stream error");
  });

  // ── onSubTask: missing required fields / progress absent ──────────────────

  test("subTaskProgress ignored when subTaskId is missing", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("agent.subTaskProgress", {
      streamId: "stream-1",
      status: "running",
    });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  test("subTaskProgress ignored when status is not a string", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("agent.subTaskProgress", {
      streamId: "stream-1",
      subTaskId: "t1",
      status: 99,
    });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  test("subTaskProgress without progress field omits optional progress", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("agent.subTaskProgress", {
      streamId: "stream-1",
      subTaskId: "t2",
      status: "pending",
      // no progress field → takes the else branch (no progress property)
    });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    const subEv = events[0] as {
      type: "subTaskProgress";
      subTaskId: string;
      status: string;
      progress?: number;
    };
    expect(subEv.type).toBe("subTaskProgress");
    expect(subEv.subTaskId).toBe("t2");
    expect(subEv.status).toBe("pending");
    expect(subEv.progress).toBeUndefined();
  });

  // ── onHitl: missing required fields / details present ────────────────────

  test("hitlBatch ignored when requestId is missing", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("agent.hitlBatch", {
      streamId: "stream-1",
      prompt: "Approve?",
    });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  test("hitlBatch ignored when prompt is not a string", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("agent.hitlBatch", {
      streamId: "stream-1",
      requestId: "r1",
      prompt: 42,
    });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  test("hitlBatch carries details when present", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("agent.hitlBatch", {
      streamId: "stream-1",
      requestId: "r2",
      prompt: "Deploy?",
      details: { target: "prod" },
    });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    const hitl = events[0] as {
      type: "hitlBatch";
      requestId: string;
      prompt: string;
      details?: unknown;
    };
    expect(hitl.type).toBe("hitlBatch");
    expect(hitl.requestId).toBe("r2");
    expect(hitl.details).toEqual({ target: "prod" });
  });

  // ── startPromise: no_stream_id error branch ───────────────────────────────

  test("emits error and finishes when gateway returns no streamId", async () => {
    ipc.askStreamResult = {}; // streamId field absent → typeof sid !== "string"
    const handle = createAskStream(ipc as never, "hello");
    const events: StreamEvent[] = [];
    for await (const ev of handle) events.push(ev);
    expect(events).toEqual([
      { type: "error", code: "no_stream_id", message: "Gateway returned no streamId" },
    ]);
  });

  test("emits error and finishes when gateway returns null", async () => {
    ipc.askStreamResult = null;
    const handle = createAskStream(ipc as never, "hello");
    const events: StreamEvent[] = [];
    for await (const ev of handle) events.push(ev);
    expect(events).toEqual([
      { type: "error", code: "no_stream_id", message: "Gateway returned no streamId" },
    ]);
  });

  // ── opts.sessionId / opts.agent forwarded in params ───────────────────────

  test("forwards sessionId and agent options to engine.askStream call", async () => {
    const { drain } = await startAndDrain(ipc, { sessionId: "s42", agent: "myAgent" });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;
    const askCall = ipc.calls.find((c) => c.method === "engine.askStream");
    expect(askCall?.params).toMatchObject({ sessionId: "s42", agent: "myAgent" });
  });

  // ── cancel() before streamId resolves ─────────────────────────────────────

  test("cancel() before streamId resolves sets cancelled flag and sends cancelStream after resolve", async () => {
    // Use a slow IPC that resolves only after cancel() is called
    let resolveAskStream!: (v: unknown) => void;
    const slowIpc = {
      calls: [] as CallSpy[],
      notifHandlers: new Map<string, ((p: unknown) => void)[]>(),
      call(method: string, params: unknown): Promise<unknown> {
        slowIpc.calls.push({ method, params });
        if (method === "engine.askStream") {
          return new Promise<unknown>((res) => {
            resolveAskStream = res;
          });
        }
        return Promise.resolve({ ok: true });
      },
      onNotification(method: string, handler: (params: unknown) => void): void {
        let arr = slowIpc.notifHandlers.get(method);
        if (arr === undefined) {
          arr = [];
          slowIpc.notifHandlers.set(method, arr);
        }
        arr.push(handler);
      },
    };

    const handle = createAskStream(slowIpc as never, "hello");
    const events: StreamEvent[] = [];
    const drain = (async () => {
      for await (const ev of handle) events.push(ev);
    })();

    // Cancel before askStream resolves (cancelled=true, streamIdResolved=undefined)
    await handle.cancel();

    // Now resolve the askStream call → should trigger the cancelled branch
    resolveAskStream({ streamId: "stream-delayed" });
    await Promise.resolve();
    await Promise.resolve();
    await drain;

    const cancelCall = slowIpc.calls.find((c) => c.method === "engine.cancelStream");
    expect(cancelCall).toBeDefined();
    expect(cancelCall?.params).toMatchObject({ streamId: "stream-delayed" });
  });

  // ── cancel() when streamIdResolved is undefined ───────────────────────────

  test("cancel() before start resolves does not call cancelStream with undefined", async () => {
    let resolveAskStream!: (v: unknown) => void;
    const slowIpc = {
      calls: [] as CallSpy[],
      notifHandlers: new Map<string, ((p: unknown) => void)[]>(),
      call(method: string, params: unknown): Promise<unknown> {
        slowIpc.calls.push({ method, params });
        if (method === "engine.askStream") {
          return new Promise<unknown>((res) => {
            resolveAskStream = res;
          });
        }
        return Promise.resolve({ ok: true });
      },
      onNotification(): void {},
    };

    const handle = createAskStream(slowIpc as never, "hello");
    // Cancel immediately (streamIdResolved is still undefined)
    await handle.cancel();

    // No cancelStream call should have been made yet (streamId not known)
    const cancelCalls = slowIpc.calls.filter((c) => c.method === "engine.cancelStream");
    expect(cancelCalls).toHaveLength(0);

    // Resolve the stream so the startPromise doesn't hang
    resolveAskStream({ streamId: "s-late" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  // ── opts.signal: already aborted ──────────────────────────────────────────

  test("opts.signal already aborted → sends cancelStream immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    const { drain } = await startAndDrain(ipc, { signal: controller.signal });
    await drain;

    const cancelCall = ipc.calls.find((c) => c.method === "engine.cancelStream");
    expect(cancelCall).toBeDefined();
    expect(cancelCall?.params).toMatchObject({ streamId: "stream-1" });
  });

  // ── opts.signal: abort fires after stream starts ───────────────────────────

  test("opts.signal abort event fires → sends cancelStream and terminates iterator", async () => {
    const controller = new AbortController();
    const { events, drain } = await startAndDrain(ipc, { signal: controller.signal });

    ipc.emit("engine.streamToken", { streamId: "stream-1", text: "before" });
    // Abort while stream is running
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await drain;

    // token "before" was already pushed; then finish() was called by the abort handler
    expect(events.some((e) => e.type === "token")).toBe(true);
    const cancelCall = ipc.calls.find((c) => c.method === "engine.cancelStream");
    expect(cancelCall).toBeDefined();
  });

  // ── iterator return() / early break ───────────────────────────────────────

  test("break from for-await calls iterator return() and cleans up", async () => {
    const handle = createAskStream(ipc as never, "hello");
    const events: StreamEvent[] = [];

    // We break after the first token, which calls the iterator's return() method
    const drain = (async () => {
      for await (const ev of handle) {
        events.push(ev);
        break;
      }
    })();
    await Promise.resolve();
    await Promise.resolve();

    ipc.emit("engine.streamToken", { streamId: "stream-1", text: "first" });
    await drain;

    expect(events).toHaveLength(1);
    expect((events[0] as { text: string }).text).toBe("first");
  });

  // ── push() after done is a no-op ──────────────────────────────────────────

  test("notifications after stream is done are ignored", async () => {
    const { events, drain } = await startAndDrain(ipc);
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await drain;

    // These arrive after done=true — push() should be no-ops
    ipc.emit("engine.streamToken", { streamId: "stream-1", text: "ghost" });
    ipc.emit("engine.streamError", { streamId: "stream-1" });

    await Promise.resolve();
    // events should not grow after done
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  // ── finish() idempotence ───────────────────────────────────────────────────

  test("double finish() (cancel + streamError) is safe", async () => {
    const { handle, events, drain } = await startAndDrain(ipc);
    // Finish via error, then cancel — second finish() is a no-op
    ipc.emit("engine.streamError", { streamId: "stream-1", code: "e1", error: "e1msg" });
    await handle.cancel();
    await drain;
    // Only the error event should be present, not duplicated
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  // ── iterator next() after done (queue empty, done=true) ───────────────────

  test("calling next() after iterator is done returns done:true immediately", async () => {
    const handle = createAskStream(ipc as never, "hello");
    await Promise.resolve();
    await Promise.resolve();

    const iter = handle[Symbol.asyncIterator]();

    // Terminate the stream by emitting done before pulling
    ipc.emit("engine.streamDone", { streamId: "stream-1" });
    await Promise.resolve();
    await Promise.resolve();

    // Pull all remaining from queue
    let result = await iter.next();
    while (!result.done) {
      result = await iter.next();
    }
    expect(result.done).toBe(true);

    // Call next() again — should return done:true immediately (done=true, queue empty)
    const extra = await iter.next();
    expect(extra.done).toBe(true);
  });

  // ── queue.length > 0 path in next() ───────────────────────────────────────

  test("events queued before iterator polls are drained from queue", async () => {
    // Create the handle but do NOT start iterating yet
    const handle = createAskStream(ipc as never, "hello");
    // Tick to let startPromise resolve and subscribe() register handlers
    await Promise.resolve();
    await Promise.resolve();

    // Emit events before the consumer starts polling
    ipc.emit("engine.streamToken", { streamId: "stream-1", text: "queued1" });
    ipc.emit("engine.streamToken", { streamId: "stream-1", text: "queued2" });
    ipc.emit("engine.streamDone", { streamId: "stream-1" });

    // Now collect — items should come straight from the queue
    const events: StreamEvent[] = [];
    for await (const ev of handle) events.push(ev);

    expect(events.map((e) => e.type)).toEqual(["token", "token", "done"]);
    expect((events[0] as { text: string }).text).toBe("queued1");
  });

  // ── streamId getter ────────────────────────────────────────────────────────

  test("streamId getter returns empty string before resolve and correct id after", async () => {
    let resolveAskStream!: (v: unknown) => void;
    const slowIpc = {
      calls: [] as CallSpy[],
      notifHandlers: new Map<string, ((p: unknown) => void)[]>(),
      call(method: string, params: unknown): Promise<unknown> {
        slowIpc.calls.push({ method, params });
        if (method === "engine.askStream") {
          return new Promise<unknown>((res) => {
            resolveAskStream = res;
          });
        }
        return Promise.resolve({});
      },
      onNotification(method: string, handler: (params: unknown) => void): void {
        let arr = slowIpc.notifHandlers.get(method);
        if (arr === undefined) {
          arr = [];
          slowIpc.notifHandlers.set(method, arr);
        }
        arr.push(handler);
      },
    };

    const handle = createAskStream(slowIpc as never, "hello");
    // Before resolve, streamId is ""
    expect(handle.streamId).toBe("");

    resolveAskStream({ streamId: "resolved-id" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.streamId).toBe("resolved-id");

    // Cleanup: finish the stream so no pending waiter hangs
    slowIpc.notifHandlers.get("engine.streamDone")?.forEach((h) => {
      h({ streamId: "resolved-id" });
    });
    await Promise.resolve();
  });
});
