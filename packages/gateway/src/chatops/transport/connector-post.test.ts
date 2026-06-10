import { describe, expect, test } from "bun:test";
import type { RunChatopsTool } from "../chatops-tool-runner.ts";
import { buildConnectorPost } from "./connector-post.ts";

interface Call {
  platform: string;
  toolId: string;
  args: unknown;
  opts: { readonly serviceUrl?: string } | undefined;
}

function recordingRunTool(calls: Call[]): RunChatopsTool {
  return (platform, toolId, args, opts) => {
    calls.push({ platform, toolId, args, opts });
    return Promise.resolve({ ok: true });
  };
}

describe("buildConnectorPost (I23 reply surface → connector post tools)", () => {
  test("slack → slack_chat_post with { channel, text }", async () => {
    const calls: Call[] = [];
    const post = buildConnectorPost(recordingRunTool(calls), () => undefined);
    await post("slack", "C0", "hello");
    expect(calls).toEqual([
      {
        platform: "slack",
        toolId: "slack_chat_post",
        args: { channel: "C0", text: "hello" },
        opts: undefined,
      },
    ]);
  });

  test("teams → teams_chat_post with { conversationId, text } + the recorded serviceUrl", async () => {
    const calls: Call[] = [];
    const post = buildConnectorPost(recordingRunTool(calls), (conversationId) =>
      conversationId === "19:x" ? "https://smba.example/emea/" : undefined,
    );
    await post("teams", "19:x", "hi");
    expect(calls[0]?.toolId).toBe("teams_chat_post");
    expect(calls[0]?.args).toEqual({ conversationId: "19:x", text: "hi" });
    expect(calls[0]?.opts).toEqual({ serviceUrl: "https://smba.example/emea/" });
  });

  test("teams without a recorded serviceUrl posts with no serviceUrl override", async () => {
    const calls: Call[] = [];
    const post = buildConnectorPost(recordingRunTool(calls), () => undefined);
    await post("teams", "19:y", "hi");
    expect(calls[0]?.opts).toBeUndefined();
  });
});
