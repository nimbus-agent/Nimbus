// packages/gateway/src/ipc/consent.test.ts
// Phase 9.7 D0a: the consent wire's type-to-confirm arm. The coordinator never compares what the
// owner typed (the comparison is `engine/executor.ts`'s alone, static D41); it carries `confirmText`
// out and `typed` back.
import { afterEach, describe, expect, test } from "bun:test";
import {
  type ConsentCoordinator,
  ConsentCoordinatorImpl,
  ConsentDisconnectedError,
  vetoingConsent,
} from "./consent.ts";
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
    expect(await p).toEqual({
      approved: true,
      typed: "github/acme/api#42",
      answerSource: "unknown",
    });
    expect(c.pendingCount()).toBe(0);
  });

  test("a missing typed on a confirm request resolves as the empty string", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    expect(c.handleRespond("a", { requestId: "r1", approved: true })).toBeNull();
    expect(await p).toEqual({ approved: true, typed: "", answerSource: "unknown" });
  });

  test("a decline resolves approved false", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    c.handleRespond("a", { requestId: "r1", approved: false, typed: "x" });
    expect(await p).toEqual({ approved: false, typed: "x", answerSource: "unknown" });
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
    expect(await p).toEqual({ approved: true, answerSource: "unknown" });
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

describe("handleRespond answerSource (Phase 10 SA1, spec 6.1)", () => {
  test("each client-reported source is carried back with the decision", async () => {
    for (const answerSource of ["human", "auto", "script"] as const) {
      const { c } = setup();
      const p = c.requestConsent("a", { requestId: "r1", prompt: "p" });
      expect(c.handleRespond("a", { requestId: "r1", approved: true, answerSource })).toBeNull();
      expect(await p).toEqual({ approved: true, answerSource });
    }
  });

  test("the confirmed arm carries it with the typed text", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    c.handleRespond("a", { requestId: "r1", approved: true, typed: "x", answerSource: "auto" });
    expect(await p).toEqual({ approved: true, typed: "x", answerSource: "auto" });
  });

  test("an absent field (an older client) is recorded as unknown", async () => {
    const { c } = setup();
    const p = c.requestConsent("a", { requestId: "r1", prompt: "p" });
    c.handleRespond("a", { requestId: "r1", approved: true });
    expect(await p).toEqual({ approved: true, answerSource: "unknown" });
  });

  test("any other value is malformed: the request is DENIED and settled, never approved or left hanging", async () => {
    for (const bad of ["robot", "delegate", "remote", "none", "unknown", "", 1, true, null, {}]) {
      const { c } = setup();
      const p = c.requestConsent("a", { requestId: "r1", prompt: "p" });
      expect(c.handleRespond("a", { requestId: "r1", approved: true, answerSource: bad })).toEqual({
        code: -32602,
        message: "Invalid params",
      });
      expect(await p).toEqual({ approved: false, answerSource: "unknown" });
      expect(c.pendingCount()).toBe(0);
    }
  });

  test("a malformed source on a confirmed request denies it too", async () => {
    const { c } = setup();
    const p = c.requestConfirmedConsent("a", { requestId: "r1", prompt: "p", confirmText: "x" });
    c.handleRespond("a", { requestId: "r1", approved: true, typed: "x", answerSource: "robot" });
    expect(await p).toEqual({ approved: false, typed: "x", answerSource: "unknown" });
  });

  test("another client's malformed reply settles nothing", () => {
    const { c } = setup();
    void c.requestConsent("a", { requestId: "r1", prompt: "p" });
    expect(
      c.handleRespond("b", { requestId: "r1", approved: true, answerSource: "robot" })?.code,
    ).toBe(-32602);
    expect(c.pendingCount()).toBe(1);
  });
});

describe("vetoingConsent (AD3a-2a: the post-answer re-check)", () => {
  function fakeInner(approved: boolean, answerSource: "human" | "auto" = "human") {
    const calls: string[] = [];
    const inner: ConsentCoordinator = {
      requestConsent: () => {
        calls.push("plain");
        return Promise.resolve({ approved, answerSource });
      },
      requestConfirmedConsent: () => {
        calls.push("typed");
        return Promise.resolve({ approved, typed: "owner/typed", answerSource });
      },
      rejectAllPending: () => {
        calls.push("rejectAll");
      },
      pendingCount: () => 7,
    };
    return { inner, calls };
  }
  const REQ = { requestId: "r1", prompt: "p" };

  test("an approved answer with a passing re-check is returned unchanged, on both requests", async () => {
    const { inner } = fakeInner(true);
    let vetoed = 0;
    const w = vetoingConsent(
      inner,
      async () => undefined,
      () => vetoed++,
    );
    expect(await w.requestConsent("c", REQ)).toEqual({ approved: true, answerSource: "human" });
    expect(await w.requestConfirmedConsent("c", { ...REQ, confirmText: "x" })).toEqual({
      approved: true,
      typed: "owner/typed",
      answerSource: "human",
    });
    expect(vetoed).toBe(0);
  });

  test("a failing re-check turns the approval into a decline (typed is emptied) and tells onVeto why", async () => {
    const { inner } = fakeInner(true);
    const reasons: string[] = [];
    const w = vetoingConsent(
      inner,
      async () => "changed since approval",
      (r) => reasons.push(r),
    );
    expect(await w.requestConsent("c", REQ)).toEqual({ approved: false, answerSource: "human" });
    expect(await w.requestConfirmedConsent("c", { ...REQ, confirmText: "x" })).toEqual({
      approved: false,
      typed: "",
      answerSource: "human",
    });
    expect(reasons).toEqual(["changed since approval", "changed since approval"]);
  });

  test("a declined answer never runs the re-check", async () => {
    const { inner } = fakeInner(false);
    let rechecks = 0;
    const w = vetoingConsent(
      inner,
      async () => {
        rechecks++;
        return "never";
      },
      () => undefined,
    );
    expect(await w.requestConsent("c", REQ)).toEqual({ approved: false, answerSource: "human" });
    expect((await w.requestConfirmedConsent("c", { ...REQ, confirmText: "x" })).approved).toBe(
      false,
    );
    expect(rechecks).toBe(0);
  });

  test("a re-check that throws is a veto (fail closed) with a fixed reason that echoes nothing", async () => {
    const { inner } = fakeInner(true);
    const reasons: string[] = [];
    const w = vetoingConsent(
      inner,
      async () => {
        throw new Error("SENTINEL listing failure");
      },
      (r) => reasons.push(r),
    );
    expect((await w.requestConsent("c", REQ)).approved).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).not.toContain("SENTINEL");
  });

  test("the re-check runs AFTER the inner answer, and pending bookkeeping passes through", async () => {
    const { inner, calls } = fakeInner(true);
    const order: string[] = [];
    const w = vetoingConsent(
      {
        ...inner,
        requestConsent: async (c, p) => {
          const a = await inner.requestConsent(c, p);
          order.push("answered");
          return a;
        },
      },
      async () => {
        order.push("recheck");
        return undefined;
      },
      () => undefined,
    );
    await w.requestConsent("c", REQ);
    expect(order).toEqual(["answered", "recheck"]);
    expect(w.pendingCount()).toBe(7);
    w.rejectAllPending("m", "r");
    expect(calls).toContain("rejectAll");
  });
});
