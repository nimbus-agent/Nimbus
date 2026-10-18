import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { publisherKeyFingerprint } from "./fingerprint.ts";

describe("publisherKeyFingerprint", () => {
  test("is the first 32 hex chars of the SHA-256 of the DECODED key bytes", () => {
    const key = Buffer.alloc(32, 7);
    const expected = createHash("sha256").update(key).digest("hex").slice(0, 32);
    expect(publisherKeyFingerprint(key.toString("base64"))).toBe(expected);
  });

  test("hashes the key bytes, not the base64 text", () => {
    const b64 = Buffer.alloc(32, 1).toString("base64");
    const ofText = createHash("sha256").update(b64).digest("hex").slice(0, 32);
    expect(publisherKeyFingerprint(b64)).not.toBe(ofText);
  });

  test("is stable for one key and differs between two real Ed25519 keys", () => {
    const a = Buffer.from(nacl.sign.keyPair().publicKey).toString("base64");
    const b = Buffer.from(nacl.sign.keyPair().publicKey).toString("base64");
    const fa = publisherKeyFingerprint(a);
    expect(fa).toMatch(/^[0-9a-f]{32}$/);
    expect(publisherKeyFingerprint(a)).toBe(fa);
    expect(publisherKeyFingerprint(b)).not.toBe(fa);
  });
});
