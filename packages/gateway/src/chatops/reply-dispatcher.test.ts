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

  test("send resolves to the number of channels posted to: 1, N and 0", async () => {
    const posted: string[] = [];
    const d = new ReplyDispatcher({
      post: async (_p, channelId) => {
        posted.push(channelId);
      },
      notifyChannelsFor: (ns) => (ns === "two" ? ["C_A", "C_B"] : []),
    });
    expect(await d.send({ kind: "originating", platform: "slack", channelId: "C_O" }, "x")).toBe(1);
    expect(await d.send({ kind: "namespaceNotify", namespace: "two" }, "x")).toBe(2);
    expect(await d.send({ kind: "namespaceNotify", namespace: "none" }, "x")).toBe(0);
    expect(posted).toEqual(["C_O", "C_A", "C_B"]);
  });
});
