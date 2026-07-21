import { expect, test } from "bun:test";
import { PreflightConsentBroker } from "./preflight-consent-broker.ts";

test("request broadcasts federation.preflightRequest and resolves true on approve", async () => {
  const b = new PreflightConsentBroker();
  const sent: Array<{ method: string; params: unknown }> = [];
  b.setBroadcast((m, p) => sent.push({ method: m, params: p }));
  const p = b.request({ peerId: "peer:a", namespace: "n", ref: "HEAD", purpose: "x" }, 1000);
  const request = sent[0];
  expect(request?.method).toBe("federation.preflightRequest");
  if (!request) throw new Error("expected a preflight request to be broadcast");
  const rid = (request.params as { requestId: string }).requestId;
  expect(b.respond(rid, true)).toBe(true);
  expect(await p).toBe(true);
});

test("respond(false) resolves false; unknown id is a no-op", async () => {
  const b = new PreflightConsentBroker();
  b.setBroadcast(() => {});
  const p = b.request({ peerId: "p", namespace: "n", ref: "HEAD", purpose: "x" }, 1000);
  const rid = b.pendingIds()[0] as string;
  expect(b.respond("nope", true)).toBe(false);
  expect(b.respond(rid, false)).toBe(true);
  expect(await p).toBe(false);
});

test("TTL safety-net resolves false and purges if no response", async () => {
  const b = new PreflightConsentBroker();
  b.setBroadcast(() => {});
  const p = b.request({ peerId: "p", namespace: "n", ref: "HEAD", purpose: "x" }, 20);
  expect(await p).toBe(false);
  expect(b.pendingIds()).toHaveLength(0);
});
