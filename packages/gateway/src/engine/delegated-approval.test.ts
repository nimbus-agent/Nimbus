import { describe, expect, it } from "bun:test";
import { resolveDelegatedApproval } from "./delegated-approval.ts";

const baseDeps = {
  isActiveDelegate: (peerId: string) => peerId === "peer:bob",
  isOperatorValid: () => true,
};

describe("resolveDelegatedApproval (I20)", () => {
  it("honors an approval from a live, in-scope, identity-valid delegate", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: true }),
    });
    expect(r).toBe("approved");
  });

  it("honors a denial from the delegate (no fallback)", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: false }),
    });
    expect(r).toBe("rejected");
  });

  it("REJECTS a forged approval from a non-delegate peer (wire not trusted)", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:eve", approved: true }),
    });
    expect(r).toBe("fallback_to_owner");
  });

  it("REJECTS an approval when the delegate's operator identity is invalid (I18)", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      isOperatorValid: () => false,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: true }),
    });
    expect(r).toBe("fallback_to_owner");
  });

  it("falls back to owner on timeout/offline (D10)", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      requestRemote: async () => ({ kind: "timeout" }),
    });
    expect(r).toBe("fallback_to_owner");
  });
});
