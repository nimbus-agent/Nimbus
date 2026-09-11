import { describe, expect, it } from "bun:test";

import {
  decodeBase64,
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "./extension-signing.ts";

describe("extension-signing", () => {
  it("round-trips base64 over every byte value", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  it("encodes standard padded base64, not base64url", () => {
    expect(encodeBase64(new Uint8Array([0xfb, 0xef, 0xff]))).toBe("++//");
    expect(encodeBase64(new Uint8Array([1]))).toBe("AQ==");
  });

  it("generates a distinct 32/32-byte keypair each call", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(a.privkey).toHaveLength(32);
    expect(a.pubkey).toHaveLength(32);
    expect(encodeBase64(a.privkey)).not.toBe(encodeBase64(b.privkey));
  });

  it("signs a manifest into a 64-byte base64 signature, ignoring any existing one", async () => {
    const { privkey } = generateEd25519Keypair();
    const manifest = { name: "demo", version: "1.0.0" };
    const sig = await signManifest(manifest, privkey);
    expect(decodeBase64(sig)).toHaveLength(64);
    // A pre-existing `signature` member is stripped before canonicalization, so it cannot
    // influence the bytes that get signed.
    expect(await signManifest({ ...manifest, signature: "stale" }, privkey)).toBe(sig);
  });

  it("signs deterministically regardless of property order", async () => {
    const { privkey } = generateEd25519Keypair();
    const a = await signManifest({ name: "demo", version: "1.0.0" }, privkey);
    const b = await signManifest({ version: "1.0.0", name: "demo" }, privkey);
    expect(a).toBe(b);
  });
});
