import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { verifyBinarySignature, verifyManifestEnvelope } from "./signature-verifier.ts";

function makeKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const seed = new Uint8Array(randomBytes(32));
  return nacl.sign.keyPair.fromSeed(seed);
}

function signDigest(secretKey: Uint8Array, binary: Uint8Array): Uint8Array {
  const digest = createHash("sha256").update(binary).digest();
  return nacl.sign.detached(new Uint8Array(digest), secretKey);
}

describe("verifyBinarySignature", () => {
  test("accepts a valid signature", () => {
    const kp = makeKeypair();
    const binary = new Uint8Array(randomBytes(4096));
    const sig = signDigest(kp.secretKey, binary);
    expect(verifyBinarySignature(binary, sig, kp.publicKey)).toBe(true);
  });

  test("rejects when binary is modified", () => {
    const kp = makeKeypair();
    const binary = new Uint8Array(randomBytes(4096));
    const sig = signDigest(kp.secretKey, binary);
    binary[0] = (binary[0] ?? 0) ^ 0xff;
    expect(verifyBinarySignature(binary, sig, kp.publicKey)).toBe(false);
  });

  test("rejects with wrong public key", () => {
    const kpA = makeKeypair();
    const kpB = makeKeypair();
    const binary = new Uint8Array(randomBytes(4096));
    const sig = signDigest(kpA.secretKey, binary);
    expect(verifyBinarySignature(binary, sig, kpB.publicKey)).toBe(false);
  });

  test("rejects truncated signature", () => {
    const kp = makeKeypair();
    const binary = new Uint8Array(randomBytes(4096));
    const sig = signDigest(kp.secretKey, binary);
    expect(verifyBinarySignature(binary, sig.slice(0, 63), kp.publicKey)).toBe(false);
  });

  test("rejects signature of wrong key length", () => {
    const kp = makeKeypair();
    const binary = new Uint8Array(randomBytes(4096));
    const sig = signDigest(kp.secretKey, binary);
    expect(verifyBinarySignature(binary, sig, kp.publicKey.slice(0, 31))).toBe(false);
  });

  test("returns false when the underlying verify throws", () => {
    // Length guards pass (length 64 / 32) but the values are not Uint8Array,
    // so tweetnacl's checkArrayTypes throws and the catch arm returns false.
    const binary = new Uint8Array(randomBytes(4096));
    const badSignature = new Array<number>(64).fill(0) as unknown as Uint8Array;
    const badPublicKey = new Array<number>(32).fill(0) as unknown as Uint8Array;
    expect(verifyBinarySignature(binary, badSignature, badPublicKey)).toBe(false);
  });
});

function signEnvelope(
  secretKey: Uint8Array,
  input: { version: string; target: string; sha256: string },
): Uint8Array {
  const envelope = JSON.stringify({
    version: input.version,
    target: input.target,
    sha256: input.sha256,
  });
  return nacl.sign.detached(new TextEncoder().encode(envelope), secretKey);
}

describe("verifyManifestEnvelope", () => {
  const base = { version: "1.2.3", target: "x86_64-pc-windows-msvc", sha256: "abc123" };

  test("accepts a valid envelope signature", () => {
    const kp = makeKeypair();
    const signature = signEnvelope(kp.secretKey, base);
    expect(verifyManifestEnvelope({ ...base, signature, publicKey: kp.publicKey })).toBe(true);
  });

  test("rejects when an envelope field is altered", () => {
    const kp = makeKeypair();
    const signature = signEnvelope(kp.secretKey, base);
    expect(
      verifyManifestEnvelope({ ...base, version: "9.9.9", signature, publicKey: kp.publicKey }),
    ).toBe(false);
  });

  test("rejects an envelope with a truncated signature", () => {
    const kp = makeKeypair();
    const signature = signEnvelope(kp.secretKey, base);
    expect(
      verifyManifestEnvelope({
        ...base,
        signature: signature.slice(0, 63),
        publicKey: kp.publicKey,
      }),
    ).toBe(false);
  });

  test("returns false when the underlying envelope verify throws", () => {
    // Length guards pass (length 64 / 32) but the values are not Uint8Array,
    // so tweetnacl's checkArrayTypes throws and the catch arm returns false.
    const badSignature = new Array<number>(64).fill(0) as unknown as Uint8Array;
    const badPublicKey = new Array<number>(32).fill(0) as unknown as Uint8Array;
    expect(
      verifyManifestEnvelope({ ...base, signature: badSignature, publicKey: badPublicKey }),
    ).toBe(false);
  });
});
