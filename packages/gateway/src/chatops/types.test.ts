import { describe, expect, test } from "bun:test";
import type { ChatMessage, ParsedCommand } from "./types.ts";

describe("chatops types", () => {
  test("ChatMessage + ParsedCommand are structurally usable", () => {
    const m: ChatMessage = {
      platform: "slack",
      channelId: "C1",
      userId: "U1",
      text: "@nimbus ping",
      ts: "1.2",
    };
    const c: ParsedCommand = { kind: "read", query: "ping" };
    expect(m.platform).toBe("slack");
    expect(c.kind).toBe("read");
  });
});
