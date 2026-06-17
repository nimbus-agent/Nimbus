// packages/gateway/src/share/share-forwarding.test.ts
import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { buildShareFile, type ShareBody } from "./share-format.ts";
import { appendForwardingHop, verifyForwardingChain } from "./share-forwarding.ts";

function kp(seedByte: number): { privkeyB64: string; pubkeyB64: string } {
  const seed = new Uint8Array(32).fill(seedByte);
  const pair = nacl.sign.keyPair.fromSeed(seed);
  return {
    privkeyB64: Buffer.from(seed).toString("base64"),
    pubkeyB64: Buffer.from(pair.publicKey).toString("base64"),
  };
}

function originShare(): ReturnType<typeof buildShareFile> {
  const origin = kp(1);
  const body: ShareBody = {
    kind: "recipe",
    sessionId: "s1",
    createdAt: 1,
    expiresAt: null,
    redactionSet: ["secrets"],
    origin: { label: "alice", pubkey: origin.pubkeyB64 },
    recipe: {
      recipeVersion: 1,
      sourceSessionId: "s1",
      generatedAt: 1,
      steps: [],
      graphTraversals: [],
    },
  };
  return buildShareFile(body, origin.privkeyB64, origin.pubkeyB64);
}

describe("appendForwardingHop", () => {
  test("leaves body + sig + contentHash byte-identical; increments hops; adds one hop", () => {
    const base = originShare();
    const bob = kp(2);
    const fwd = appendForwardingHop(base, { gatewayLabel: "bob", ...bob });
    expect(JSON.stringify(fwd.body)).toBe(JSON.stringify(base.body)); // body untouched
    expect(fwd.sig).toEqual(base.sig); // origin sig untouched
    expect(fwd.contentHash).toBe(base.contentHash);
    expect(fwd.forwarding.hops).toBe(1);
    expect(fwd.forwarding.chain).toHaveLength(1);
    expect(fwd.forwarding.chain[0]?.gatewayLabel).toBe("bob");
    expect(fwd.forwarding.chain[0]?.pubkey).toBe(bob.pubkeyB64);
  });

  test("a second hop chains over the prior chain; both verify", () => {
    const base = originShare();
    const hop1 = appendForwardingHop(base, { gatewayLabel: "bob", ...kp(2) });
    const hop2 = appendForwardingHop(hop1, { gatewayLabel: "carol", ...kp(3) });
    expect(hop2.forwarding.hops).toBe(2);
    expect(hop2.forwarding.chain.map((h) => h.gatewayLabel)).toEqual(["bob", "carol"]);
    expect(verifyForwardingChain(hop2).valid).toBe(true);
    expect(verifyForwardingChain(hop2).hopsValid).toBe(2);
  });
});

describe("verifyForwardingChain", () => {
  test("empty chain is valid (0 hops)", () => {
    const r = verifyForwardingChain(originShare());
    expect(r.valid).toBe(true);
    expect(r.hopsTotal).toBe(0);
  });

  test("a tampered hop sig fails its own sig but is detected without touching content", () => {
    const hop1 = appendForwardingHop(originShare(), { gatewayLabel: "bob", ...kp(2) });
    const tampered: typeof hop1 = {
      ...hop1,
      forwarding: {
        hops: 1,
        chain: [{ ...hop1.forwarding.chain[0]!, gatewayLabel: "mallory" }], // label changed, sig now stale
      },
    };
    const r = verifyForwardingChain(tampered);
    expect(r.valid).toBe(false);
    expect(r.hopsValid).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
