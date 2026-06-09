import { describe, expect, it } from "bun:test";
import { type ChatopsIpc, parseChatopsArgs, runChatopsCommand } from "./chatops.ts";

function fakeClient(responses: ReadonlyArray<unknown> = []): {
  client: ChatopsIpc;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let idx = 0;
  const client: ChatopsIpc = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      const r = idx < responses.length ? responses[idx] : { ok: true };
      idx += 1;
      return r as T;
    },
  };
  return { client, calls };
}

describe("parseChatopsArgs", () => {
  it("defaults to status", () => {
    expect(parseChatopsArgs([])).toEqual({ kind: "status" });
    expect(parseChatopsArgs(["status"])).toEqual({ kind: "status" });
  });
  it("parses start/stop", () => {
    expect(parseChatopsArgs(["start"])).toEqual({ kind: "start" });
    expect(parseChatopsArgs(["stop"])).toEqual({ kind: "stop" });
  });
  it("parses test with a quoted message (joined)", () => {
    expect(parseChatopsArgs(["test", "who's", "on", "call?"])).toEqual({
      kind: "test",
      text: "who's on call?",
    });
  });
  it("rejects test with no message", () => {
    expect(() => parseChatopsArgs(["test"])).toThrow(/Usage/);
  });
  it("rejects unknown subcommand", () => {
    expect(() => parseChatopsArgs(["bogus"])).toThrow(/Unknown subcommand/);
  });
});

describe("runChatopsCommand", () => {
  it("status calls chatops.status with {}", async () => {
    const { client, calls } = fakeClient([{ enabled: true, platforms: [] }]);
    await runChatopsCommand(client, { kind: "status" });
    expect(calls).toEqual([{ method: "chatops.status", params: {} }]);
  });
  it("start/stop call their methods", async () => {
    const { client, calls } = fakeClient();
    await runChatopsCommand(client, { kind: "start" });
    await runChatopsCommand(client, { kind: "stop" });
    expect(calls.map((c) => c.method)).toEqual(["chatops.start", "chatops.stop"]);
  });
  it("test forwards the message text", async () => {
    const { client, calls } = fakeClient([{ kind: "read", query: "hi" }]);
    await runChatopsCommand(client, { kind: "test", text: "hi" });
    expect(calls).toEqual([{ method: "chatops.test", params: { text: "hi" } }]);
  });
});
