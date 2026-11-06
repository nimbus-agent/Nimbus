// packages/gateway/src/ipc/consent.test.ts
// Phase 9.7 D0a: the consent wire's type-to-confirm arm. The coordinator never compares what the
// owner typed (the comparison is `engine/executor.ts`'s alone, static D41); it carries `confirmText`
// out and `typed` back.
import { afterEach, describe, expect, test } from "bun:test";
import { ConsentCoordinatorImpl, ConsentDisconnectedError } from "./consent.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";
import type { JsonRpcNotification } from "./jsonrpc.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

function setup(): { c: ConsentCoordinatorImpl; sent: JsonRpcNotification[] } {
  const sent: JsonRpcNotification[] = [];
  return { c: new ConsentCoordinatorImpl(() => (n) => sent.push(n)), sent };
}

function paramsOf(n: JsonRpcNotification | undefined): Record<string, unknown> {
  return (n?.params ?? {}) as Record<string, unknown>;
}

describe("requestConfirmedConsent", () => {
  test("sends confirmText in consent.request and resolves with the typed answer", async () => {
    const { c, sent } = setup();
    const p = c.requestConfirmedConsent("a", {
      requestId: "r1",
      prompt: "p",
      actionType: "github.pr.merge",
      confirmText: "github/acme/api#42",
    });
    expect(sent).toHaveLength(1);
    expect(paramsOf(sent[0])["confirmText"]).toBe("github/acme/api#42");
    expect(
      c.handleRespond("a", { requestId: "r1", approved: true, typed: "github/acme/api#42" }),
    ).toBeNull();
    expect(await p).toEqual({ approved: true, typed: "github/acme/api#42" });
    expect(c.pendingCount()).toBe(0);
  });

  test("a missing typed on a confirm request resolves as the empty string", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    expect(c.handleRespond("a", { requestId: "r1", approved: true })).toBeNull();
    expect(await p).toEqual({ approved: true, typed: "" });
  });

  test("a decline resolves approved false", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    c.handleRespond("a", { requestId: "r1", approved: false, typed: "x" });
    expect(await p).toEqual({ approved: false, typed: "x" });
  });

  test("hitl.requested does not carry the confirm text or the prompt", () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    setGatewayEventBroadcast((method, params) => seen.push({ method, params }));
    const { c } = setup();
    void c.requestConfirmedConsent("a", {
      requestId: "r1",
      prompt: "details",
      actionType: "github.pr.merge",
      confirmText: "github/acme/api#42",
    });
    const payload = seen.find((s) => s.method === "gateway.event")?.params["payload"];
    expect(payload).toEqual({ requestId: "r1", actionType: "github.pr.merge" });
    expect(JSON.stringify(seen)).not.toContain("github/acme/api#42");
  });

  test("a disconnect rejects a confirm request like a plain one", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    c.onClientDisconnect("a");
    await expect(p).rejects.toBeInstanceOf(ConsentDisconnectedError);
  });

  test("no session rejects", async () => {
    const c = new ConsentCoordinatorImpl(() => undefined);
    await expect(
      c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" }),
    ).rejects.toBeInstanceOf(ConsentDisconnectedError);
  });

  test("rejectAllPending rejects a confirm request", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    c.rejectAllPending("shutting down", "shutdown");
    await expect(p).rejects.toBeInstanceOf(ConsentDisconnectedError);
  });
});

describe("consent.request for a plain request", () => {
  test("carries no confirmText", () => {
    const { c, sent } = setup();
    void c.requestConsent("a", { requestId: "r1", prompt: "p", actionType: "t" });
    expect(Object.keys(paramsOf(sent[0]))).not.toContain("confirmText");
  });
});

describe("handleRespond typed", () => {
  test("a plain request ignores typed", async () => {
    const { c } = setup();
    const p = c.requestConsent("a", { requestId: "r1", prompt: "p" });
    expect(c.handleRespond("a", { requestId: "r1", approved: true, typed: "anything" })).toBeNull();
    expect(await p).toBe(true);
  });

  test("a non-string typed is -32602 and leaves the request pending", () => {
    const { c } = setup();
    void c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    for (const typed of [1, true, null, {}, ["x"]]) {
      expect(c.handleRespond("a", { requestId: "r1", approved: true, typed })).toEqual({
        code: -32602,
        message: "Invalid params",
      });
    }
    expect(c.pendingCount()).toBe(1);
  });

  test("typed over 512 characters is -32602; exactly 512 is accepted", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    expect(
      c.handleRespond("a", { requestId: "r1", approved: true, typed: "x".repeat(513) }),
    ).toEqual({
      code: -32602,
      message: "Invalid params",
    });
    expect(
      c.handleRespond("a", { requestId: "r1", approved: true, typed: "x".repeat(512) }),
    ).toBeNull();
    expect((await p).typed).toHaveLength(512);
  });

  test("a foreign client cannot answer a confirm request", () => {
    const { c } = setup();
    void c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    expect(c.handleRespond("b", { requestId: "r1", approved: true, typed: "x" })?.code).toBe(
      -32602,
    );
    expect(c.pendingCount()).toBe(1);
  });
});
