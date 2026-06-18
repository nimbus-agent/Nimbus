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
    expect(r.hopsTotal).toBe(1);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("defensive branches", () => {
  test("appendForwardingHop throws when the pubkey does not match the seed", () => {
    const base = originShare();
    // valid 32-byte seed for key #2, but the WRONG pubkey (key #3's) → mismatch.
    expect(() =>
      appendForwardingHop(base, {
        gatewayLabel: "bob",
        pubkeyB64: kp(3).pubkeyB64,
        privkeyB64: kp(2).privkeyB64,
      }),
    ).toThrow(/does not match/);
  });

  test("appendForwardingHop throws on a non-32-byte seed", () => {
    const base = originShare();
    const badPriv = Buffer.from(new Uint8Array(16).fill(9)).toString("base64"); // 16 bytes, not 32
    expect(() =>
      appendForwardingHop(base, {
        gatewayLabel: "bob",
        pubkeyB64: kp(2).pubkeyB64,
        privkeyB64: badPriv,
      }),
    ).toThrow(/32-byte seed/);
  });

  test("a hop with a wrong-length pubkey is reported invalid (not a verify call)", () => {
    const base = originShare();
    const hop1 = appendForwardingHop(base, { gatewayLabel: "bob", ...kp(2) });
    // Replace the hop's pubkey with a too-short key → the length guard short-circuits to invalid.
    const shortPubHop = {
      ...hop1,
      forwarding: {
        hops: 1,
        chain: [
          {
            ...hop1.forwarding.chain[0]!,
            pubkey: Buffer.from(new Uint8Array(16)).toString("base64"),
          },
        ],
      },
    };
    const r = verifyForwardingChain(shortPubHop);
    expect(r.valid).toBe(false);
    expect(r.hopsValid).toBe(0);
    expect(r.errors[0]).toContain("signature invalid");
  });

  test("a hop with a malformed (undecodable) signature is reported, never throws out", () => {
    const base = originShare();
    const hop1 = appendForwardingHop(base, { gatewayLabel: "bob", ...kp(2) });
    const badSigHop = {
      ...hop1,
      forwarding: {
        hops: 1,
        // a too-short sig (decodes to <64 bytes) → length guard fails → reported invalid, no throw
        chain: [
          { ...hop1.forwarding.chain[0]!, sig: Buffer.from(new Uint8Array(8)).toString("base64") },
        ],
      },
    };
    const r = verifyForwardingChain(badSigHop);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
