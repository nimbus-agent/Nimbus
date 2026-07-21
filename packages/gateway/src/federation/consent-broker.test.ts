import { expect, test } from "bun:test";
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
  expect(await p).toBe("denied");
  expect(broker.pendingIds()).toHaveLength(0);
});
