import { describe, expect, test } from "bun:test";

import { NimbusClient } from "../src/nimbus-client.ts";
import type { HitlRequest } from "../src/stream-events.ts";

type CallSpy = { method: string; params: unknown };

class FakeIpc {
  public calls: CallSpy[] = [];
  public notifHandlers = new Map<string, ((p: unknown) => void)[]>();
  private readonly responses: unknown[];
  constructor(responses: unknown[] = []) {
    this.responses = responses;
  }
  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return this.responses.shift() ?? { ok: true };
  }
  onNotification(method: string, handler: (p: unknown) => void): void {
    const arr = this.notifHandlers.get(method) ?? [];
    arr.push(handler);
    this.notifHandlers.set(method, arr);
  }
  emit(method: string, params: unknown): void {
    for (const h of this.notifHandlers.get(method) ?? []) h(params);
  }
  async disconnect(): Promise<void> {}
}

function makeClient(ipc: FakeIpc): NimbusClient {
  return new (NimbusClient as unknown as { new (ipc: unknown): NimbusClient })(ipc);
}

describe("NimbusClient method dispatch", () => {
  test("agentInvoke sends defaults and omits undefined optionals", async () => {
    const ipc = new FakeIpc([{ reply: "ok" }]);
    await makeClient(ipc).agentInvoke("hello");
    expect(ipc.calls[0]).toEqual({
      method: "agent.invoke",
      params: { input: "hello", stream: false },
    });
  });

  test("agentInvoke includes sessionId + agent when provided", async () => {
    const ipc = new FakeIpc([{}]);
    await makeClient(ipc).agentInvoke("hi", { stream: true, sessionId: "s1", agent: "a1" });
    expect(ipc.calls[0]?.params).toEqual({
      input: "hi",
      stream: true,
      sessionId: "s1",
      agent: "a1",
    });
  });

  test("getSessionTranscript / cancelStream / querySql / auditList route correctly", async () => {
    const ipc = new FakeIpc([
      { sessionId: "s", turns: [], hasMore: false },
      { ok: true },
      { rows: [] },
      [],
    ]);
    const c = makeClient(ipc);
    await c.getSessionTranscript({ sessionId: "s" });
    await c.cancelStream("stream-9");
    await c.querySql("SELECT 1");
    await c.auditList();
    expect(ipc.calls.map((x) => x.method)).toEqual([
      "engine.getSessionTranscript",
      "engine.cancelStream",
      "index.querySql",
      "audit.list",
    ]);
    expect(ipc.calls[1]?.params).toEqual({ streamId: "stream-9" });
    expect(ipc.calls[3]?.params).toEqual({ limit: 50 });
  });

  test("auditList passes a custom limit", async () => {
    const ipc = new FakeIpc([[]]);
    await makeClient(ipc).auditList(7);
    expect(ipc.calls[0]?.params).toEqual({ limit: 7 });
  });

  test("queryItems forwards all filter params", async () => {
    const ipc = new FakeIpc([{ items: [], meta: { limit: 0, total: 0 } }]);
    await makeClient(ipc).queryItems({ services: ["github"], types: ["pr"], limit: 5 });
    expect(ipc.calls[0]).toMatchObject({ method: "index.queryItems" });
    expect((ipc.calls[0]?.params as Record<string, unknown>)["services"]).toEqual(["github"]);
  });

  test("askStream returns a handle with a string streamId", async () => {
    const ipc = new FakeIpc([{ streamId: "stream-1" }]);
    const h = makeClient(ipc).askStream("hi");
    expect(typeof h.streamId).toBe("string");
  });

  test("subscribeHitl forwards valid batches and filters malformed ones", () => {
    const ipc = new FakeIpc();
    const got: HitlRequest[] = [];
    makeClient(ipc).subscribeHitl((r) => got.push(r));
    ipc.emit("agent.hitlBatch", { requestId: "r1", prompt: "Approve?", streamId: "s1" });
    ipc.emit("agent.hitlBatch", { requestId: "r2", prompt: "No stream" });
    ipc.emit("agent.hitlBatch", { prompt: "no requestId" });
    ipc.emit("agent.hitlBatch", null);
    expect(got.length).toBe(2);
    expect(got[0]).toMatchObject({ requestId: "r1", prompt: "Approve?", streamId: "s1" });
    expect(got[1]).toMatchObject({ requestId: "r2", prompt: "No stream" });
    expect(got[1]).not.toHaveProperty("streamId");
  });

  test("close disconnects the transport", async () => {
    const ipc = new FakeIpc();
    let disconnected = false;
    ipc.disconnect = async () => {
      disconnected = true;
    };
    await makeClient(ipc).close();
    expect(disconnected).toBe(true);
  });
});
