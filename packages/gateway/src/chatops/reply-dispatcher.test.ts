import { describe, expect, test } from "bun:test";
import { ReplyDispatcher } from "./reply-dispatcher.ts";
import type { ReplyTarget } from "./types.ts";

function makeDispatcher() {
  const posted: { channelId: string; text: string }[] = [];
  const d = new ReplyDispatcher({
    post: async (platform, channelId, text) => {
      posted.push({ channelId, text });
      void platform;
    },
    notifyChannelsFor: (ns) => (ns === "project:pay" ? ["C_ALERT"] : []),
  });
  return { d, posted };
}

describe("ReplyDispatcher (I23)", () => {
  test("posts to the originating channel", async () => {
    const { d, posted } = makeDispatcher();
    const target: ReplyTarget = { kind: "originating", platform: "slack", channelId: "C_ORIG" };
    await d.send(target, "hello");
    expect(posted).toEqual([{ channelId: "C_ORIG", text: "hello" }]);
  });

  test("posts to a policy-declared notify channel for a namespace", async () => {
    const { d, posted } = makeDispatcher();
    await d.send({ kind: "namespaceNotify", namespace: "project:pay" }, "alert");
    expect(posted).toEqual([{ channelId: "C_ALERT", text: "alert" }]);
  });

  test("namespace with no notify channels -> posts nothing (no throw)", async () => {
    const { d, posted } = makeDispatcher();
    await d.send({ kind: "namespaceNotify", namespace: "project:none" }, "x");
    expect(posted).toEqual([]);
  });

  // The notify loop is sequential by design (the S9382 suppression on it): every post appends its
  // own egress-ledger row before it is sent (I29), so posts must not overlap and a failed one — an
  // `EgressAppendFailedError` included — must stop the channels after it.
  test("notify posts are sequential: each starts only after the previous one settled", async () => {
    const events: string[] = [];
    const d = new ReplyDispatcher({
      post: async (_platform, channelId) => {
        events.push(`start:${channelId}`);
        // The FIRST post is the slow one, so overlapping posts would interleave below.
        if (channelId === "C_ONE") await new Promise((r) => setTimeout(r, 5));
        events.push(`end:${channelId}`);
      },
      notifyChannelsFor: () => ["C_ONE", "C_TWO"],
    });
    await d.send({ kind: "namespaceNotify", namespace: "project:pay" }, "alert");
    expect(events).toEqual(["start:C_ONE", "end:C_ONE", "start:C_TWO", "end:C_TWO"]);
  });

  test("a failed notify post rejects send() and stops the channels after it", async () => {
    const attempted: string[] = [];
    const d = new ReplyDispatcher({
      post: (_platform, channelId) => {
        attempted.push(channelId);
        return channelId === "C_ONE"
          ? Promise.reject(new Error("egress append failed"))
          : Promise.resolve();
      },
      notifyChannelsFor: () => ["C_ONE", "C_TWO"],
    });
    await expect(
      d.send({ kind: "namespaceNotify", namespace: "project:pay" }, "alert"),
    ).rejects.toThrow("egress append failed");
    expect(attempted).toEqual(["C_ONE"]);
  });
});
