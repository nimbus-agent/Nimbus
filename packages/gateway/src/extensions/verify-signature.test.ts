import { describe, expect, it } from "bun:test";

import {
  decodeBase64,
  encodeBase64,
  errorToHardDisableReason,
  generateEd25519Keypair,
  PublisherKeyMismatch,
  SignatureInvalid,
  SignatureInvalidFormat,
  signManifest,
  verifyManifestSignature,
} from "./verify-signature.ts";

const baseManifest = (pubkeyB64: string) => ({
  id: "test-ext",
  version: "1.0.0",
  permissions: {},
  publisher: { id: "test-pub", key: pubkeyB64 },
});

describe("generateEd25519Keypair", () => {
  it("returns 32-byte privkey and 32-byte pubkey", () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    expect(privkey).toBeInstanceOf(Uint8Array);
    expect(pubkey).toBeInstanceOf(Uint8Array);
    expect(privkey).toHaveLength(32);
    expect(pubkey).toHaveLength(32);
  });

  it("produces distinct keypairs", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(encodeBase64(a.pubkey)).not.toBe(encodeBase64(b.pubkey));
  });
});

describe("signManifest + verifyManifestSignature round-trip", () => {
  it("verify(sign(m)) succeeds for matching key", async () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const m = baseManifest(encodeBase64(pubkey));
    const signature = await signManifest(m, privkey);
    const signed = { ...m, signature };
    await expect(verifyManifestSignature(signed, pubkey)).resolves.toBeUndefined();
  });

  it("rejects manifest tampered after signing", async () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const m = baseManifest(encodeBase64(pubkey));
    const signature = await signManifest(m, privkey);
    const tampered = { ...m, version: "9.9.9", signature };
    await expect(verifyManifestSignature(tampered, pubkey)).rejects.toThrow(SignatureInvalid);
  });

  it("rejects when verifier holds a different key", async () => {
    const signer = generateEd25519Keypair();
    const otherKey = generateEd25519Keypair().pubkey;
    const m = baseManifest(encodeBase64(signer.pubkey));
    const signature = await signManifest(m, signer.privkey);
    const signed = { ...m, signature };
    await expect(verifyManifestSignature(signed, otherKey)).rejects.toThrow(PublisherKeyMismatch);
  });

  it("rejects signature with wrong base64 length", async () => {
    const { pubkey } = generateEd25519Keypair();
    const m = baseManifest(encodeBase64(pubkey));
    const tooShort = { ...m, signature: encodeBase64(new Uint8Array(63)) };
    await expect(verifyManifestSignature(tooShort, pubkey)).rejects.toThrow(SignatureInvalidFormat);
  });

  it("rejects manifest.publisher.key with wrong length", async () => {
    const { pubkey } = generateEd25519Keypair();
    const sig = encodeBase64(new Uint8Array(64));
    const bad = {
      id: "test-ext",
      version: "1.0.0",
      permissions: {},
      publisher: { id: "test-pub", key: encodeBase64(new Uint8Array(31)) },
      signature: sig,
    };
    await expect(verifyManifestSignature(bad, pubkey)).rejects.toThrow(SignatureInvalidFormat);
  });

  it("ignores existing signature field when signing (idempotent re-sign)", async () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const m = baseManifest(encodeBase64(pubkey));
    const sig1 = await signManifest(m, privkey);
    const sig2 = await signManifest({ ...m, signature: "garbage" }, privkey);
    expect(sig1).toBe(sig2);
  });
});

describe("encodeBase64 / decodeBase64", () => {
  it("round-trip", () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 64]);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});

describe("errorToHardDisableReason", () => {
  it("maps error classes to reason strings", () => {
    expect(errorToHardDisableReason(new SignatureInvalid())).toBe("signature_failed");
    expect(errorToHardDisableReason(new SignatureInvalidFormat())).toBe("signature_malformed");
    expect(errorToHardDisableReason(new PublisherKeyMismatch())).toBe("publisher_key_mismatch");
  });

  it("falls back to signature_failed for unknown errors", () => {
    expect(errorToHardDisableReason(new Error("???"))).toBe("signature_failed");
  });
});
