import { beforeEach, describe, expect, test } from "bun:test";

import { createAskStream } from "../src/ask-stream.ts";
import type { StreamEvent } from "../src/stream-events.ts";

type CallSpy = { method: string; params: unknown };

class FakeIpc {
  public calls: CallSpy[] = [];
  public notifHandlers = new Map<string, ((p: unknown) => void)[]>();

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "engine.askStream") return { streamId: "stream-1" };
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

async function startAndDrain(ipcInstance: FakeIpc): Promise<{
  handle: ReturnType<typeof createAskStream>;
  events: StreamEvent[];
  drain: Promise<void>;
}> {
  const handle = createAskStream(ipcInstance as never, "hello");
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
});
