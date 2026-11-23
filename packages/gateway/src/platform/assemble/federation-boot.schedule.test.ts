import { afterEach, expect, test } from "bun:test";
import { scheduleConsent } from "../../federation/schedule-consent-broker.ts";
import { bindFederationBroadcasts } from "./federation-boot.ts";

afterEach(() => {
  scheduleConsent.setBroadcast(() => {});
  scheduleConsent.clear();
});

test("a booted federation delivers an inbound free/busy request to the owner's clients", () => {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  bindFederationBroadcasts(
    { broadcast: (method, params) => sent.push({ method, params: params ?? {} }) },
    {} as never,
  );
  void scheduleConsent.request({ peerId: "peer:aa", fromMs: 1, toMs: 2 }, 5_000);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("federation.scheduleRequest");
  expect(sent[0]?.params).toMatchObject({ peerId: "peer:aa", fromMs: 1, toMs: 2 });
  expect(typeof sent[0]?.params["requestId"]).toBe("string");
});

test("a federation that did not boot binds nothing", () => {
  const sent: string[] = [];
  bindFederationBroadcasts({ broadcast: (m) => sent.push(m) }, undefined);
  void scheduleConsent.request({ peerId: "p", fromMs: 1, toMs: 2 }, 5_000);
  expect(sent).toEqual([]);
});
