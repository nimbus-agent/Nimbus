import { describe, expect, test } from "bun:test";
import { dispatchPolicyRpc, type PolicyRpcCtx } from "./policy-rpc.ts";

function ctx(): PolicyRpcCtx {
  return {
    showPolicy: () => ({
      org: "acme",
      version: 1,
      signatureValid: true,
      pendingRestart: false,
      source: "peer",
    }),
    signPolicy: () => {
      throw new Error("anchor-only");
    },
    trustPubkey: () => {},
    refetch: async () => ({ applied: true }),
    purge: async () => ({ jobId: "j1", localDeleted: 0 }),
    isAnchor: false,
  };
}

describe("dispatchPolicyRpc", () => {
  test("policy.show returns the current state (hit)", async () => {
    const out = await dispatchPolicyRpc("policy.show", {}, ctx());
    expect(out.kind).toBe("hit");
  });
  test("policy.verify returns the current state (hit)", async () => {
    const out = await dispatchPolicyRpc("policy.verify", {}, ctx());
    expect(out.kind).toBe("hit");
  });
  test("policy.sign on a non-anchor fails closed", async () => {
    await expect(dispatchPolicyRpc("policy.sign", { toml: "x" }, ctx())).rejects.toThrow();
  });
  test("policy.sign on an anchor signs", async () => {
    const out = await dispatchPolicyRpc(
      "policy.sign",
      { toml: "x" },
      { ...ctx(), isAnchor: true, signPolicy: () => ({ org: "acme", version: 2 }) },
    );
    expect(out.kind).toBe("hit");
  });
  test("policy.trust pins the pubkey (hit)", async () => {
    const out = await dispatchPolicyRpc(
      "policy.trust",
      { pubkey: "abc" },
      { ...ctx(), isAnchor: true },
    );
    expect(out.kind).toBe("hit");
  });
  test("policy.trust on a non-anchor fails closed", async () => {
    await expect(
      dispatchPolicyRpc("policy.trust", { pubkey: "x" }, { ...ctx(), isAnchor: false }),
    ).rejects.toThrow();
  });
  test("policy.refetch returns the refresh outcome (hit)", async () => {
    const out = await dispatchPolicyRpc("policy.refetch", {}, ctx());
    expect(out.kind).toBe("hit");
  });
  test("unknown method => miss", async () => {
    expect((await dispatchPolicyRpc("policy.nope", {}, ctx())).kind).toBe("miss");
  });
  test("team.purge on a non-operator/non-anchor fails closed", async () => {
    await expect(
      dispatchPolicyRpc(
        "team.purge",
        { externalId: "u" },
        {
          ...ctx(),
          purge: () => {
            throw new Error("not permitted");
          },
        },
      ),
    ).rejects.toThrow();
  });
  test("team.purge on an operator runs (hit)", async () => {
    const out = await dispatchPolicyRpc(
      "team.purge",
      { externalId: "u" },
      { ...ctx(), isAnchor: true },
    );
    expect(out.kind).toBe("hit");
  });
});
