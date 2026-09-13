// packages/gateway/src/ipc/consent-events.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { formatConsentPrompt } from "../engine/executor.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

type Seen = { method: string; params: Record<string, unknown> };

function capture(): Seen[] {
  const seen: Seen[] = [];
  setGatewayEventBroadcast((method, params) => seen.push({ method, params }));
  return seen;
}

describe("HITL observation events", () => {
  test("a request broadcasts hitl.requested ALONGSIDE the unicast consent.request", () => {
    // `consent.request` is written to ONE session (`getWriter(clientId)`), so a separate
    // `nimbus tail` process can never see it. The broadcast is what makes `--filter hitl` real.
    const unicast: unknown[] = [];
    const c = new ConsentCoordinatorImpl(() => (n) => unicast.push(n));
    const seen = capture();
    void c.requestConsent("client-a", {
      requestId: "r1",
      prompt: "Post to Slack?",
      actionType: "chatops.message.post",
    });
    // The targeted notification is UNCHANGED — this lane observes a gate, it is not part of one.
    expect(unicast).toHaveLength(1);
    const ev = seen.find((s) => s.method === "gateway.event");
    expect(ev).toBeDefined();
    const p = ev?.params as { kind: string; payload: Record<string, unknown> };
    expect(p.kind).toBe("hitl.requested");
    expect(p.payload["requestId"]).toBe("r1");
    expect(p.payload["actionType"]).toBe("chatops.message.post");
  });

  test("the broadcast carries actionType, never the rendered prompt — even though the unicast still does", () => {
    // `prompt` is built by the real `formatConsentPrompt` (engine/executor.ts), the same way
    // production calls it: it stringifies the redacted action `details` straight into the prompt
    // text (channel names, message bodies, recipients). A recognisable, non-secret-looking value
    // (an email address) survives that redaction — `redactPayloadForConsentDisplay` masks only
    // secret-LOOKING key names — so if `prompt` ever rode the broadcast, every connected session
    // would see the recipient of an action nobody has approved yet. It must not.
    const action = {
      type: "chatops.message.post",
      payload: { to: "ceo@example.com", body: "quarterly numbers", password: "hunter2" },
    };
    const prompt = formatConsentPrompt(action);
    // Sanity: the real function DOES put the recognisable value in the text it builds — otherwise
    // the assertions below would pass for the wrong reason (nothing to withhold in the first place).
    expect(prompt).toContain("ceo@example.com");

    const unicast: unknown[] = [];
    const c = new ConsentCoordinatorImpl(() => (n) => unicast.push(n));
    const seen = capture();
    void c.requestConsent("client-a", { requestId: "r2", prompt, actionType: action.type });

    // The unicast `consent.request` is untouched: the one client actually being asked still gets
    // the full rendered prompt.
    expect(unicast).toHaveLength(1);
    const notif = unicast[0] as { params: Record<string, unknown> };
    expect(notif.params["prompt"]).toBe(prompt);

    // The broadcast is a different story. Neither the redacted `details` object nor the
    // recognisable value `formatConsentPrompt` folded into `prompt` may appear anywhere on it.
    const ev = seen.find((s) => s.method === "gateway.event");
    const p = ev?.params as { payload: Record<string, unknown> };
    expect("details" in p.payload).toBe(false);
    expect("prompt" in p.payload).toBe(false);
    expect(JSON.stringify(p.payload)).not.toContain("ceo@example.com");
    // What IS broadcast: an identifier a passive observer can act on, nothing more.
    expect(p.payload["actionType"]).toBe("chatops.message.post");
  });

  test("an answer broadcasts hitl.resolved with the verdict", () => {
    const c = new ConsentCoordinatorImpl(() => () => {});
    void c.requestConsent("client-a", { requestId: "r3", prompt: "ok?" });
    const seen = capture();
    c.handleRespond("client-a", { requestId: "r3", approved: true });
    const ev = seen.find(
      (s) =>
        s.method === "gateway.event" && (s.params as { kind: string }).kind === "hitl.resolved",
    );
    expect(ev).toBeDefined();
    const p = ev?.params as { payload: Record<string, unknown> };
    expect(p.payload["requestId"]).toBe("r3");
    expect(p.payload["approved"]).toBe(true);
  });

  test("a FOREIGN requestId is still refused — observation grants no authority", () => {
    // A `tail` client that tried to answer must not be able to. This is the existing behaviour;
    // the test pins that adding the broadcast did not loosen it.
    //
    // NOTE: this test alone cannot distinguish `entry?.clientId !== clientId` (the real,
    // client-scoped guard) from the weaker `entry === undefined` (an existence-only guard) —
    // "never-issued" trips the `entry === undefined` half of the condition either way. See the
    // next test for the guard's actual security property: a requestId that WAS issued, to a
    // DIFFERENT client, must still be refused.
    const c = new ConsentCoordinatorImpl(() => () => {});
    const seen = capture();
    const err = c.handleRespond("client-b", { requestId: "never-issued", approved: true });
    expect(err?.code).toBe(-32602);
    // The rejection must be silent, too: a foreign client must not be able to forge a
    // `hitl.resolved` event for a prompt it was never allowed to answer.
    expect(
      seen.some(
        (s) =>
          s.method === "gateway.event" && (s.params as { kind: string }).kind === "hitl.resolved",
      ),
    ).toBe(false);
  });

  test("a FOREIGN client cannot answer ANOTHER client's live consent request", async () => {
    // This branch makes every requestId VISIBLE to every connected client (the `hitl.requested`
    // broadcast added above), so `handleRespond`'s `entry?.clientId !== clientId` check is now
    // security-load-bearing in a way it was not before: without it, any `nimbus tail` client
    // could approve a prompt raised for someone else, having only OBSERVED its requestId.
    const c = new ConsentCoordinatorImpl(() => () => {});
    const seen = capture();

    let settled = false;
    const pending = c.requestConsent("client-a", { requestId: "r1", prompt: "Post to Slack?" });
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // client-b observed "r1" (e.g. via `nimbus tail --filter hitl`) and tries to answer it.
    const err = c.handleRespond("client-b", { requestId: "r1", approved: true });
    expect(err?.code).toBe(-32602);

    // No `hitl.resolved` was broadcast — a foreign answer must not even look like it landed.
    expect(
      seen.some(
        (s) =>
          s.method === "gateway.event" && (s.params as { kind: string }).kind === "hitl.resolved",
      ),
    ).toBe(false);

    // client-a's pending promise is still unresolved. Give any wrongly-scheduled settlement a
    // full turn of the event loop to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
  });
});
