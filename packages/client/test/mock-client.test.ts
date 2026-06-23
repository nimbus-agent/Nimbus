import { describe, expect, test } from "bun:test";

import { MockClient } from "../src/mock-client.ts";

describe("MockClient", () => {
  test("queryItems returns fixture items", async () => {
    const c = new MockClient({
      items: [
        {
          id: "1",
          service: "github",
          itemType: "file",
          name: "Demo",
          modifiedAt: 1,
        },
      ],
    });
    const r = await c.queryItems({});
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.id).toBe("1");
    await c.close();
  });

  test("agentInvoke returns default then fixture reply", async () => {
    expect((await new MockClient().agentInvoke("hi")).reply).toBe("[MockClient] agent.invoke");
    expect((await new MockClient({ reply: "R" }).agentInvoke("hi")).reply).toBe("R");
  });

  test("askStream yields default tokens then a done event", async () => {
    const evs: { type: string }[] = [];
    for await (const e of new MockClient().askStream("hi")) evs.push(e);
    expect(evs.map((e) => e.type)).toEqual(["token", "token", "done"]);
  });

  test("askStream honours custom streamTokens", async () => {
    const evs: { type: string }[] = [];
    for await (const e of new MockClient({ streamTokens: ["a"] }).askStream("hi")) evs.push(e);
    expect(evs.filter((e) => e.type === "token")).toHaveLength(1);
  });

  test("askStream stops after cancel()", async () => {
    const h = new MockClient().askStream("hi");
    await h.cancel();
    const evs: unknown[] = [];
    for await (const e of h) evs.push(e);
    expect(evs).toEqual([]);
  });

  test("subscribeHitl returns a disposer", () => {
    const sub = new MockClient().subscribeHitl(() => undefined);
    expect(typeof sub.dispose).toBe("function");
    sub.dispose();
  });

  test("getSessionTranscript / cancelStream / querySql / auditList / close", async () => {
    const c = new MockClient();
    expect((await c.getSessionTranscript()).sessionId).toBe("mock-session");
    expect(await c.cancelStream()).toEqual({ ok: true });
    expect(await c.querySql("SELECT 1")).toEqual({ rows: [] });
    expect(await c.auditList()).toEqual([]);
    await c.close();
  });

  test("queryItems returns empty meta without fixtures", async () => {
    const r = await new MockClient().queryItems({});
    expect(r).toEqual({ items: [], meta: { limit: 0, total: 0 } });
  });
});
