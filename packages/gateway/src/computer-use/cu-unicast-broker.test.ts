// The computer-use approval round-trip (I35, owner ruling OR-MCU-2): one connection asked, and only
// that connection's human answer approves.
import { afterEach, describe, expect, test } from "bun:test";

import { CuUnicastConsentBroker } from "./cu-unicast-broker.ts";

const brokers: Array<CuUnicastConsentBroker<object>> = [];
afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
});

function make(live: ReadonlySet<string> = new Set(["owner"])): {
  b: CuUnicastConsentBroker<{ what: string }>;
  sent: Array<{ clientId: string; method: string; params: Record<string, unknown> }>;
} {
  const b = new CuUnicastConsentBroker<{ what: string }>("computer.actionRequest");
  brokers.push(b);
  const sent: Array<{ clientId: string; method: string; params: Record<string, unknown> }> = [];
  b.setUnicast((clientId, method, params) => {
    if (!live.has(clientId)) return false;
    sent.push({ clientId, method, params: params as Record<string, unknown> });
    return true;
  });
  return { b, sent };
}

describe("CuUnicastConsentBroker", () => {
  test("the prompt goes to the asking connection only", () => {
    const { b, sent } = make();
    void b.requestFor("owner", { what: "click" }, 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.clientId).toBe("owner");
    expect(sent[0]?.method).toBe("computer.actionRequest");
    expect(sent[0]?.params["what"]).toBe("click");
    expect(typeof sent[0]?.params["requestId"]).toBe("string");
  });

  test("a connection that is gone is a denial at once; nobody else is asked", async () => {
    const { b, sent } = make(new Set());
    expect(await b.requestFor("owner", { what: "click" }, 60_000)).toBe(false);
    expect(sent).toEqual([]);
    expect(b.pendingIds()).toEqual([]);
  });

  test("a person's approval from the asking connection approves", async () => {
    const { b } = make();
    const p = b.requestFor("owner", { what: "click" }, 60_000);
    const id = b.pendingIds()[0] ?? "";
    expect(b.respondFrom(id, true, { clientId: "owner", answerSource: "human" })).toBe(true);
    expect(await p).toBe(true);
  });

  test("another connection's answer matches nothing: not an approval, not even a denial", async () => {
    const { b } = make();
    const p = b.requestFor("owner", { what: "click" }, 60_000);
    const id = b.pendingIds()[0] ?? "";
    expect(b.respondFrom(id, true, { clientId: "intruder", answerSource: "human" })).toBe(false);
    expect(b.respondFrom(id, false, { clientId: "intruder", answerSource: "human" })).toBe(false);
    // Still open, and still the owner's to answer.
    expect(b.pendingIds()).toEqual([id]);
    expect(b.respondFrom(id, true, { clientId: "owner", answerSource: "human" })).toBe(true);
    expect(await p).toBe(true);
  });

  test.each(["auto", "script", "unknown", "delegate", "remote", "none", undefined])(
    "an approval whose source is %s, from the asking connection, is a denial",
    async (answerSource) => {
      const { b } = make();
      const p = b.requestFor("owner", { what: "click" }, 60_000);
      const id = b.pendingIds()[0] ?? "";
      expect(b.respondFrom(id, true, { clientId: "owner", answerSource })).toBe(true);
      expect(await p).toBe(false);
    },
  );

  test("a person's decline is a denial", async () => {
    const { b } = make();
    const p = b.requestFor("owner", { what: "click" }, 60_000);
    const id = b.pendingIds()[0] ?? "";
    b.respondFrom(id, false, { clientId: "owner", answerSource: "human" });
    expect(await p).toBe(false);
  });

  test("no answer before the deadline is a denial", async () => {
    const { b } = make();
    expect(await b.requestFor("owner", { what: "click" }, 1)).toBe(false);
    expect(b.pendingIds()).toEqual([]);
  });

  test("an unknown or settled request id matches nothing", async () => {
    const { b } = make();
    expect(b.respondFrom("nope", true, { clientId: "owner", answerSource: "human" })).toBe(false);
    const p = b.requestFor("owner", { what: "click" }, 60_000);
    const id = b.pendingIds()[0] ?? "";
    b.respondFrom(id, true, { clientId: "owner", answerSource: "human" });
    await p;
    expect(b.respondFrom(id, true, { clientId: "owner", answerSource: "human" })).toBe(false);
  });

  test("a connection that goes away settles its own prompts as denials, and only its own", async () => {
    const { b } = make(new Set(["owner", "other"]));
    const mine = b.requestFor("owner", { what: "click" }, 60_000);
    const theirs = b.requestFor("other", { what: "type" }, 60_000);
    b.onClientDisconnect("owner");
    expect(await mine).toBe(false);
    expect(b.pendingIds()).toHaveLength(1);
    const id = b.pendingIds()[0] ?? "";
    expect(b.respondFrom(id, true, { clientId: "other", answerSource: "human" })).toBe(true);
    expect(await theirs).toBe(true);
  });

  test("the class has no broadcast arm", () => {
    const b = new CuUnicastConsentBroker<object>("computer.envelopeRequest");
    brokers.push(b);
    expect("setBroadcast" in b).toBe(false);
    expect("request" in b).toBe(false);
  });
});
