import { describe, expect, test } from "bun:test";
import {
  parseTeamsConfirmSubmit,
  type TeamsConfirmSubmit,
  TeamsWebhookAdapter,
} from "./teams-webhook-adapter.ts";

function submit(value: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    id: "act-1",
    from: { id: "29:alice" },
    conversation: { id: "19:conv" },
    value,
    ...overrides,
  };
}

describe("parseTeamsConfirmSubmit", () => {
  test("an Approve submit carries the typed text verbatim, with no text on the activity", () => {
    expect(
      parseTeamsConfirmSubmit(
        submit({ nimbusConfirm: "req-1", verdict: "approve", typed: "  A/b  " }),
      ),
    ).toEqual({
      requestId: "req-1",
      userId: "29:alice",
      conversationId: "19:conv",
      approved: true,
      typed: "  A/b  ",
    });
  });

  test("a Reject submit is approved false", () => {
    expect(
      parseTeamsConfirmSubmit(submit({ nimbusConfirm: "r", verdict: "reject" }))?.approved,
    ).toBe(false);
  });

  test("a non-string or missing typed value becomes the empty string", () => {
    expect(
      parseTeamsConfirmSubmit(submit({ nimbusConfirm: "r", verdict: "approve", typed: 5 }))?.typed,
    ).toBe("");
    expect(parseTeamsConfirmSubmit(submit({ nimbusConfirm: "r", verdict: "approve" }))?.typed).toBe(
      "",
    );
  });

  test.each([
    ["null", null],
    [
      "a non-message activity",
      submit({ nimbusConfirm: "r", verdict: "approve" }, { type: "invoke" }),
    ],
    ["no value", submit(undefined)],
    ["an array value", submit([])],
    ["a null value", submit(null)],
    ["a wrong verdict", submit({ nimbusConfirm: "r", verdict: "maybe" })],
    ["no verdict", submit({ nimbusConfirm: "r" })],
    ["a non-string request id", submit({ nimbusConfirm: 7, verdict: "approve" })],
    ["an empty request id", submit({ nimbusConfirm: "", verdict: "approve" })],
    ["no sender", submit({ nimbusConfirm: "r", verdict: "approve" }, { from: {} })],
    ["no conversation", submit({ nimbusConfirm: "r", verdict: "approve" }, { conversation: {} })],
  ])("%s gives undefined", (_n, activity) => {
    expect(parseTeamsConfirmSubmit(activity)).toBeUndefined();
  });
});

describe("TeamsWebhookAdapter card submits", () => {
  const value = { nimbusConfirm: "req-1", verdict: "approve", typed: "t" };

  test("a submit reaches the confirm handler, not the message handler", async () => {
    const adapter = new TeamsWebhookAdapter();
    const msgs: unknown[] = [];
    const subs: TeamsConfirmSubmit[] = [];
    adapter.onMessage(async (m) => {
      msgs.push(m);
    });
    adapter.onConfirmSubmit(async (s) => {
      subs.push(s);
    });
    await adapter.start();
    await adapter.onActivity(submit(value));
    expect(subs).toHaveLength(1);
    expect(msgs).toHaveLength(0);
  });

  test("a redelivered activity id is handled once", async () => {
    const adapter = new TeamsWebhookAdapter();
    const subs: TeamsConfirmSubmit[] = [];
    adapter.onConfirmSubmit(async (s) => {
      subs.push(s);
    });
    await adapter.start();
    await adapter.onActivity(submit(value));
    await adapter.onActivity(submit(value));
    expect(subs).toHaveLength(1);
    await adapter.onActivity(submit(value, { id: "act-2" }));
    expect(subs).toHaveLength(2);
  });

  test("a submit with no activity id is handled every time; with no handler it is dropped", async () => {
    const adapter = new TeamsWebhookAdapter();
    await adapter.start();
    await adapter.onActivity(submit(value, { id: undefined })); // no handler: no throw
    const subs: TeamsConfirmSubmit[] = [];
    adapter.onConfirmSubmit(async (s) => {
      subs.push(s);
    });
    await adapter.onActivity(submit(value, { id: undefined }));
    await adapter.onActivity(submit(value, { id: undefined }));
    expect(subs).toHaveLength(2);
  });

  test("a stopped adapter drops a submit", async () => {
    const adapter = new TeamsWebhookAdapter();
    const subs: TeamsConfirmSubmit[] = [];
    adapter.onConfirmSubmit(async (s) => {
      subs.push(s);
    });
    await adapter.onActivity(submit(value));
    expect(subs).toHaveLength(0);
  });
});
