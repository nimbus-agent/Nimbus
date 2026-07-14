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

  test("egress methods return safe defaults without fixtures", async () => {
    const c = new MockClient();
    expect(await c.egressHead()).toEqual({ head: "", count: 0 });
    // Params accepted for drop-in parity with NimbusClient (TS would reject if not).
    expect(await c.egressList({ since: 1, limit: 5 })).toEqual({ rows: [] });
    expect(await c.egressVerify()).toEqual({ ok: true, verifiedRows: 0 });
    expect(await c.egressProveWindow({ since: 1, sign: true })).toEqual({
      rows: [],
      completeness: { tier: "authorized-actions", outboundEgressEvents: 0 },
      verify: { ok: true, verifiedRows: 0 },
    });
  });

  test("egress methods return configured fixtures", async () => {
    const row = {
      id: 1,
      timestamp: 100,
      sourceType: "agent",
      sourceId: "s1",
      destination: "github",
      method: "github.issue.create",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
      rowHash: "h1",
      prevHash: "h0",
    };
    const c = new MockClient({
      egressHead: { head: "h1", count: 1 },
      egressRows: [row],
      egressVerify: { ok: false, verifiedRows: 1, brokenAt: 2, reason: "mismatch" },
      egressProveWindow: {
        rows: [row],
        completeness: { tier: "authorized-actions", outboundEgressEvents: 1 },
        verify: { ok: true, verifiedRows: 1 },
      },
    });
    expect((await c.egressHead()).count).toBe(1);
    expect((await c.egressList()).rows).toHaveLength(1);
    expect((await c.egressVerify()).brokenAt).toBe(2);
    expect((await c.egressProveWindow()).completeness.outboundEgressEvents).toBe(1);
  });

  test("searchRanked returns [] by default and ranked fixtures when configured", async () => {
    expect(await new MockClient().searchRanked({ name: "x" })).toEqual([]);
    const c = new MockClient({
      rankedItems: [
        {
          id: "d1",
          service: "drive",
          itemType: "file",
          name: "Plan",
          score: 0.9,
          indexPrimaryKey: "1",
          indexedType: "file",
        },
      ],
    });
    const r = await c.searchRanked();
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe("Plan");
  });
});
