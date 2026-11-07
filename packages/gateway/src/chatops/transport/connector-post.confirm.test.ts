import { describe, expect, test } from "bun:test";
import type { RunChatopsTool } from "../chatops-tool-runner.ts";
import {
  buildConnectorPost,
  buildConnectorViewsOpen,
  CHATOPS_POST_TOOL_IDS,
} from "./connector-post.ts";

interface Call {
  platform: string;
  toolId: string;
  args: unknown;
}

function recorder(calls: Call[]): RunChatopsTool {
  return (platform, toolId, args) => {
    calls.push({ platform, toolId, args });
    return Promise.resolve({ ok: true });
  };
}

describe("buildConnectorPost with a card", () => {
  const blocks = [{ type: "section" }];
  const attachment = { contentType: "application/vnd.microsoft.card.adaptive", content: {} };

  test("slack: blocks are forwarded beside the text", async () => {
    const calls: Call[] = [];
    await buildConnectorPost(recorder(calls), () => undefined)("slack", "C0", "t", {
      slackBlocks: blocks,
    });
    expect(calls[0]?.args).toEqual({ channel: "C0", text: "t", blocks });
  });

  test("teams: the attachment is forwarded as a one-element attachments array", async () => {
    const calls: Call[] = [];
    await buildConnectorPost(recorder(calls), () => undefined)("teams", "19:x", "t", {
      teamsAttachment: attachment,
    });
    expect(calls[0]?.args).toEqual({
      conversationId: "19:x",
      text: "t",
      attachments: [attachment],
    });
  });

  test("a card for the other platform is ignored; no card adds no field", async () => {
    const calls: Call[] = [];
    const post = buildConnectorPost(recorder(calls), () => undefined);
    await post("slack", "C0", "t", { teamsAttachment: attachment });
    await post("teams", "19:x", "t", { slackBlocks: blocks });
    expect(calls[0]?.args).toEqual({ channel: "C0", text: "t" });
    expect(calls[1]?.args).toEqual({ conversationId: "19:x", text: "t" });
  });
});

describe("buildConnectorViewsOpen", () => {
  test("calls slack_views_open with { trigger_id, view }", async () => {
    const calls: Call[] = [];
    const view = { type: "modal" };
    await buildConnectorViewsOpen(recorder(calls))("trig-1", view);
    expect(calls).toEqual([
      { platform: "slack", toolId: "slack_views_open", args: { trigger_id: "trig-1", view } },
    ]);
  });

  test("slack_views_open is a ChatOps operational tool id (the I26 federated refusal reads the set)", () => {
    expect(CHATOPS_POST_TOOL_IDS.has("slack_views_open")).toBe(true);
  });
});
