import { expect, test } from "bun:test";
import type { TribalCaptureResult } from "../ipc/tribal-rpc.ts";
import { handleTribalCaptureCommand, parseTribalCaptureCommand } from "./tribal-chat-capture.ts";

test("parses a capture command, stripping the mention", () => {
  expect(parseTribalCaptureCommand("<@U0> tribal capture k1")).toEqual({ clusterId: "k1" });
  expect(parseTribalCaptureCommand("@nimbus tribal capture k1 --target confluence")).toEqual({
    clusterId: "k1",
    target: "confluence",
  });
  expect(parseTribalCaptureCommand("tribal capture k9 --target notion")).toEqual({
    clusterId: "k9",
    target: "notion",
  });
});

test("returns undefined for non-capture messages", () => {
  expect(parseTribalCaptureCommand("who is on call?")).toBeUndefined();
  expect(parseTribalCaptureCommand("tribal capture")).toBeUndefined();
  expect(parseTribalCaptureCommand("tribal capture --target notion")).toBeUndefined();
});

test("handler calls the capture gate and replies on success", async () => {
  const calls: { clusterId: string; target: string | undefined }[] = [];
  const replies: string[] = [];
  await handleTribalCaptureCommand(
    {
      capture: async (clusterId, target) => {
        calls.push({ clusterId, target });
        return { ok: true, pageRef: "notion:pg1" } satisfies TribalCaptureResult;
      },
      reply: async (t) => void replies.push(t),
    },
    { clusterId: "k1", target: "notion" },
  );
  expect(calls).toEqual([{ clusterId: "k1", target: "notion" }]);
  expect(replies[0]).toContain("Captured k1");
  expect(replies[0]).toContain("notion:pg1");
});

test("handler reports a failed capture in-channel", async () => {
  const replies: string[] = [];
  await handleTribalCaptureCommand(
    {
      capture: async () => ({ ok: false, error: "not_configured" }),
      reply: async (t) => void replies.push(t),
    },
    { clusterId: "k1" },
  );
  expect(replies[0]).toContain("not_configured");
});

test("handler never throws if the capture gate throws", async () => {
  const replies: string[] = [];
  await handleTribalCaptureCommand(
    {
      capture: async () => {
        throw new Error("boom");
      },
      reply: async (t) => void replies.push(t),
    },
    { clusterId: "k1" },
  );
  expect(replies[0]).toContain("failed");
  expect(replies[0]).toContain("boom");
});

test("handler stringifies a non-Error throw (the String(err) branch)", async () => {
  const replies: string[] = [];
  await handleTribalCaptureCommand(
    {
      capture: async () => {
        // intentionally throwing a non-Error to exercise the String(err) branch
        throw "plain string failure";
      },
      reply: async (t) => void replies.push(t),
    },
    { clusterId: "k1" },
  );
  expect(replies[0]).toContain("failed");
  expect(replies[0]).toContain("plain string failure");
});

test("handler reports a successful capture with its page ref in-channel", async () => {
  const replies: string[] = [];
  await handleTribalCaptureCommand(
    {
      capture: async () => ({ ok: true, pageRef: "confluence:42" }),
      reply: async (t) => void replies.push(t),
    },
    { clusterId: "k1", target: "confluence" },
  );
  expect(replies[0]).toContain("Captured k1");
  expect(replies[0]).toContain("confluence:42");
});
