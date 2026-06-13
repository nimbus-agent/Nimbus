import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../types.ts";
import { normalizeTeamsActivity, TeamsWebhookAdapter } from "./teams-webhook-adapter.ts";

describe("Teams activity normalization", () => {
  test("message activity → ChatMessage", () => {
    const m = normalizeTeamsActivity({
      type: "message",
      text: "<at>Nimbus</at> who's on call?",
      id: "act-1",
      from: { id: "29:user" },
      conversation: { id: "19:conv" },
    });
    expect(m).toEqual({
      platform: "teams",
      channelId: "19:conv",
      userId: "29:user",
      text: "<at>Nimbus</at> who's on call?",
      ts: "act-1",
      addressedToBot: true,
    });
  });

  test("non-message activity → undefined", () => {
    expect(normalizeTeamsActivity({ type: "conversationUpdate" })).toBeUndefined();
    expect(normalizeTeamsActivity(null)).toBeUndefined();
    expect(normalizeTeamsActivity({ type: "message", from: { id: "u" } })).toBeUndefined();
  });
});

describe("TeamsWebhookAdapter", () => {
  test("dispatches a normalized activity to the handler only while running", async () => {
    const got: ChatMessage[] = [];
    const adapter = new TeamsWebhookAdapter();
    adapter.onMessage(async (m) => {
      got.push(m);
    });

    // not started yet → dropped
    await adapter.onActivity({
      type: "message",
      text: "hi",
      id: "a1",
      from: { id: "29:u" },
      conversation: { id: "19:c" },
    });
    expect(got).toHaveLength(0);

    await adapter.start();
    expect(adapter.connected()).toBe(true);
    await adapter.onActivity({
      type: "message",
      text: "hi",
      id: "a2",
      from: { id: "29:u" },
      conversation: { id: "19:c" },
    });
    expect(got).toHaveLength(1);

    // non-message activity ignored
    await adapter.onActivity({ type: "conversationUpdate" });
    expect(got).toHaveLength(1);

    await adapter.stop();
    expect(adapter.connected()).toBe(false);
  });
});
