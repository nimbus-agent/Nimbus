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
});
