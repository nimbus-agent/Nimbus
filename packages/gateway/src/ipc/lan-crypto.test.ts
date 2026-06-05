import { describe, expect, test } from "bun:test";
import {
  boxKeypairFromSecretKey,
  generateBoxKeypair,
  openBoxFrame,
  sealBoxFrame,
} from "./lan-crypto.ts";

describe("LAN crypto — NaCl box round-trip", () => {
  test("seal + open recovers the plaintext", () => {
    const alice = generateBoxKeypair();
    const bob = generateBoxKeypair();
    const message = new TextEncoder().encode('{"method":"index.search","params":{"q":"x"}}');
    const frame = sealBoxFrame(message, bob.publicKey, alice.secretKey);
    const plain = openBoxFrame(frame, alice.publicKey, bob.secretKey);
    expect(new TextDecoder().decode(plain)).toBe('{"method":"index.search","params":{"q":"x"}}');
  });

  test("open throws on tampered ciphertext", () => {
    const alice = generateBoxKeypair();
    const bob = generateBoxKeypair();
    const frame = sealBoxFrame(new TextEncoder().encode("hi"), bob.publicKey, alice.secretKey);
    frame[frame.length - 1] = (frame.at(-1) ?? 0) ^ 0xff;
    expect(() => openBoxFrame(frame, alice.publicKey, bob.secretKey)).toThrow();
  });

  test("open throws when wrong peer pubkey", () => {
    const alice = generateBoxKeypair();
    const bob = generateBoxKeypair();
    const eve = generateBoxKeypair();
    const frame = sealBoxFrame(new TextEncoder().encode("hi"), bob.publicKey, alice.secretKey);
    expect(() => openBoxFrame(frame, eve.publicKey, bob.secretKey)).toThrow();
  });

  test("nonces are unique across 1000 frames", () => {
    const alice = generateBoxKeypair();
    const bob = generateBoxKeypair();
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const frame = sealBoxFrame(
        new TextEncoder().encode(`msg-${i}`),
        bob.publicKey,
        alice.secretKey,
      );
      const nonceHex = Buffer.from(frame.slice(0, 24)).toString("hex");
      nonces.add(nonceHex);
    }
    expect(nonces.size).toBe(1000);
  });
});

test("boxKeypairFromSecretKey recovers the same keypair from its secret", () => {
  const kp = generateBoxKeypair();
  const recovered = boxKeypairFromSecretKey(kp.secretKey);
  expect(Buffer.from(recovered.publicKey).toString("hex")).toBe(
    Buffer.from(kp.publicKey).toString("hex"),
  );
  expect(Buffer.from(recovered.secretKey).toString("hex")).toBe(
    Buffer.from(kp.secretKey).toString("hex"),
  );
});

test("boxKeypairFromSecretKey rejects a wrong-length secret", () => {
  expect(() => boxKeypairFromSecretKey(new Uint8Array(31))).toThrow();
});
