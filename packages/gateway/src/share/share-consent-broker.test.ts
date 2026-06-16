import { afterEach, describe, expect, test } from "bun:test";
import { ShareConsentBroker } from "./share-consent-broker.ts";

// Track every broker so afterEach can clear its TTL timers. A fire-and-forget request() (result
// ignored) otherwise leaves a dangling unref'd setTimeout that hangs `bun test` teardown on Windows.
const liveBrokers: ShareConsentBroker[] = [];
function makeBroker(): ShareConsentBroker {
  const b = new ShareConsentBroker();
  liveBrokers.push(b);
  return b;
}
afterEach(() => {
  for (const b of liveBrokers.splice(0)) b.clear();
});

function input(over: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    kind: "transcript",
    preview: { redacted: true },
    redactionSet: ["emails"],
    sink: "file",
    ...over,
  };
}

describe("ShareConsentBroker", () => {
  test("broadcasts the approval request with a requestId and the input", () => {
    const broker = makeBroker();
    const seen: Array<{ method: string; params: unknown }> = [];
    broker.setBroadcast((method, params) => seen.push({ method, params }));
    void broker.request(input(), 10_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("share.approvalRequest");
    const params = seen[0]?.params as { requestId: string; sessionId: string };
    expect(typeof params.requestId).toBe("string");
    expect(params.sessionId).toBe("s1");
    expect(broker.pendingIds()).toContain(params.requestId);
  });

  test("respond(true) resolves the pending request and clears it", async () => {
    const broker = makeBroker();
    let requestId = "";
    broker.setBroadcast((_m, params) => {
      requestId = (params as { requestId: string }).requestId;
    });
    const pending = broker.request(input(), 10_000);
    expect(broker.respond(requestId, true)).toBe(true);
    expect(await pending).toBe(true);
    expect(broker.pendingIds()).not.toContain(requestId);
  });

  test("respond(false) resolves the pending request with a deny", async () => {
    const broker = makeBroker();
    let requestId = "";
    broker.setBroadcast((_m, params) => {
      requestId = (params as { requestId: string }).requestId;
    });
    const pending = broker.request(input(), 10_000);
    expect(broker.respond(requestId, false)).toBe(true);
    expect(await pending).toBe(false);
  });

  test("respond to an unknown id returns false", () => {
    const broker = makeBroker();
    broker.setBroadcast(() => {});
    expect(broker.respond("does-not-exist", true)).toBe(false);
  });

  test("the TTL safety-net resolves false (fail-closed) when the owner never answers", async () => {
    const broker = makeBroker();
    broker.setBroadcast(() => {});
    const pending = broker.request(input(), 5);
    expect(await pending).toBe(false);
    expect(broker.pendingIds()).toHaveLength(0);
  });

  test("a fresh broker with no broadcast bound does not throw on request", async () => {
    const broker = makeBroker();
    const pending = broker.request(input(), 5);
    expect(await pending).toBe(false);
  });

  test("clear() cancels pending requests and their TTL timers", () => {
    const broker = makeBroker();
    broker.setBroadcast(() => {});
    void broker.request(input(), 10_000);
    void broker.request(input(), 10_000);
    expect(broker.pendingIds()).toHaveLength(2);
    broker.clear();
    expect(broker.pendingIds()).toHaveLength(0);
  });
});
