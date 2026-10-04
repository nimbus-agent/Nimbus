import { expect, spyOn, test } from "bun:test";
import { awaitHoldingEventLoop } from "../testing/hold-event-loop.ts";
import { FederationConsentBroker } from "./consent-broker.ts";

test("request broadcasts and resolves on respond(approved=true)", async () => {
  const broker = new FederationConsentBroker();
  const sent: Array<{ method: string; params: unknown }> = [];
  broker.setBroadcast((method, params) => sent.push({ method, params }));
  const p = broker.request(
    { peerId: "peer:a", namespace: "n", purpose: "x", role: "viewer" },
    1000,
  );
  expect(sent).toHaveLength(1);
  const request = sent[0];
  expect(request?.method).toBe("federation.consentRequest");
  if (!request) throw new Error("expected a consent request to be broadcast");
  const rid = (request.params as { requestId: string }).requestId;
  broker.respond(rid, true);
  expect(await p).toBe("approved");
});

test("respond(false) resolves denied; unknown id is a no-op", async () => {
  const broker = new FederationConsentBroker();
  broker.setBroadcast(() => {});
  const p = broker.request({ peerId: "p", namespace: "n", purpose: "x", role: "viewer" }, 1000);
  const rid = broker.pendingIds()[0] as string;
  expect(broker.respond("nope", true)).toBe(false); // unknown id → not matched
  expect(broker.respond(rid, false)).toBe(true); // matched
  expect(await p).toBe("denied");
});

test("TTL safety-net resolves denied and purges if no response", async () => {
  const broker = new FederationConsentBroker();
  broker.setBroadcast(() => {});
  const p = broker.request({ peerId: "p", namespace: "n", purpose: "x", role: "viewer" }, 20);
  // The TTL timer is unref'd (pinned below), so it is the ONLY thing that can settle `p` — and under
  // Bun 1.3 on Windows an unref'd timer never fires while nothing else is ref'd, so awaiting `p`
  // bare hangs this file when it runs alone (see testing/hold-event-loop.ts). The hold keeps the
  // loop alive; the TTL timer still settles `p`.
  expect(await awaitHoldingEventLoop(p)).toBe("denied");
  expect(broker.pendingIds()).toHaveLength(0);
});

test("the TTL timer is unref'd, so a pending consent request never holds the event loop open", () => {
  const broker = new FederationConsentBroker();
  broker.setBroadcast(() => {});
  const setTimeoutSpy = spyOn(globalThis, "setTimeout");
  let ttl: ReturnType<typeof setTimeout> | undefined;
  try {
    void broker.request({ peerId: "p", namespace: "n", purpose: "x", role: "viewer" }, 60_000);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    ttl = setTimeoutSpy.mock.results[0]?.value as ReturnType<typeof setTimeout>;
  } finally {
    setTimeoutSpy.mockRestore();
  }
  expect(ttl.hasRef()).toBe(false);
  // Settle it so the 60 s timer is cleared rather than left behind.
  expect(broker.respond(broker.pendingIds()[0] as string, false)).toBe(true);
});
