import { describe, expect, test } from "bun:test";
import { type ChatopsRpcCtx, dispatchChatopsRpc } from "./chatops-rpc.ts";

const ctx: ChatopsRpcCtx = {
  status: () => ({
    enabled: true,
    platforms: [{ name: "slack", connected: true, channels: 2 }],
    lastEventAt: 123,
  }),
  start: async () => {},
  stop: async () => {},
  testParse: (text: string) => ({ kind: "read" as const, query: text }),
};

describe("chatops-rpc", () => {
  test("chatops.status returns a snapshot", async () => {
    const r = await dispatchChatopsRpc("chatops.status", {}, ctx);
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") expect((r.value as { enabled: boolean }).enabled).toBe(true);
  });

  test("unknown method → miss", async () => {
    expect((await dispatchChatopsRpc("chatops.nope", {}, ctx)).kind).toBe("miss");
  });

  test("chatops.test parses a message", async () => {
    const r = await dispatchChatopsRpc("chatops.test", { text: "hi" }, ctx);
    if (r.kind === "hit") expect(r.value).toEqual({ kind: "read", query: "hi" });
  });

  test("chatops.start / chatops.stop return ok", async () => {
    expect((await dispatchChatopsRpc("chatops.start", {}, ctx)).kind).toBe("hit");
    const stop = await dispatchChatopsRpc("chatops.stop", {}, ctx);
    if (stop.kind === "hit") expect(stop.value).toEqual({ ok: true });
  });

  test("chatops.test without text → throws ERR_INVALID_PARAMS", async () => {
    await expect(dispatchChatopsRpc("chatops.test", {}, ctx)).rejects.toThrow(/ERR_INVALID_PARAMS/);
  });
});
