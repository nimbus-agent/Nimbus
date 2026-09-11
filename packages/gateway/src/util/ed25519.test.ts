import { describe, expect, it } from "bun:test";
import nacl from "tweetnacl";

import { generateEd25519Keypair } from "./ed25519.ts";

describe("generateEd25519Keypair", () => {
  it("returns a 32-byte seed and a 32-byte public key", () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    expect(privkey).toHaveLength(32);
    expect(pubkey).toHaveLength(32);
  });

  it("returns a fresh keypair each call", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(Buffer.from(a.privkey).toString("hex")).not.toBe(Buffer.from(b.privkey).toString("hex"));
  });

  it("emits a seed tweetnacl expands to the SAME public key", () => {
    // The seed/pubkey pairing is the load-bearing property: the Vault stores the seed, and
    // `nacl.sign.keyPair.fromSeed` is what every signing site re-derives the pair from.
    const { privkey, pubkey } = generateEd25519Keypair();
    const derived = nacl.sign.keyPair.fromSeed(privkey);
    expect(Buffer.from(derived.publicKey).toString("hex")).toBe(
      Buffer.from(pubkey).toString("hex"),
    );
  });

  it("produces a keypair that round-trips a detached signature", () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const pair = nacl.sign.keyPair.fromSeed(privkey);
    const msg = new TextEncoder().encode("nimbus");
    const sig = nacl.sign.detached(msg, pair.secretKey);
    expect(nacl.sign.detached.verify(msg, sig, pubkey)).toBe(true);
  });
});
