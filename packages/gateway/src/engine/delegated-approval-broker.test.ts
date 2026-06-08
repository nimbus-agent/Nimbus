import { describe, expect, it } from "bun:test";
import { delegatedApprovalBroker } from "./delegated-approval-broker.ts";

describe("delegatedApprovalBroker", () => {
  it("resolves with the responder's peerId + decision", async () => {
    const ids: string[] = [];
    delegatedApprovalBroker.setBroadcast((requestId) => ids.push(requestId));
    const p = delegatedApprovalBroker.request({ prompt: "approve deploy?" }, 5000);
    delegatedApprovalBroker.respond(ids[0]!, "peer:bob", true);
    expect(await p).toEqual({ kind: "answered", peerId: "peer:bob", approved: true });
  });

  it("times out to {kind:'timeout'}", async () => {
    delegatedApprovalBroker.setBroadcast(() => {});
    const r = await delegatedApprovalBroker.request({ prompt: "x" }, 20);
    expect(r).toEqual({ kind: "timeout" });
  });

  it("respond() to an unknown requestId returns false (no pending entry)", () => {
    const ok = delegatedApprovalBroker.respond("does-not-exist", "peer:bob", true);
    expect(ok).toBe(false);
  });

  it("listPending() reflects open requests and clears after respond()", () => {
    const ids: string[] = [];
    delegatedApprovalBroker.setBroadcast((requestId) => ids.push(requestId));
    const p = delegatedApprovalBroker.request({ prompt: "ship it?" }, 5000);
    const pending = delegatedApprovalBroker.listPending();
    expect(pending.some((e) => e.requestId === ids[0] && e.prompt === "ship it?")).toBe(true);
    delegatedApprovalBroker.respond(ids[0]!, "peer:ann", false);
    expect(delegatedApprovalBroker.listPending().some((e) => e.requestId === ids[0])).toBe(false);
    return p; // settle the pending promise so the test doesn't leak a timer
  });
});
