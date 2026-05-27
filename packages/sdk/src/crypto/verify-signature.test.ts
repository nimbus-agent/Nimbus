import { describe, expect, test } from "bun:test";

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

type Manifest = {
  publisher?: { id: string; key: string };
  signature?: string;
  [k: string]: unknown;
};

async function signedManifest(): Promise<{
  manifest: Manifest;
  pubkey: Uint8Array;
  privkey: Uint8Array;
}> {
  const { privkey, pubkey } = generateEd25519Keypair();
  const manifest: Manifest = {
    id: "com.example.demo",
    version: "1.0.0",
    publisher: { id: "demo", key: encodeBase64(pubkey) },
  };
  manifest.signature = await signManifest(manifest, privkey);
  return { manifest, pubkey, privkey };
}

describe("base64 round-trip", () => {
  test("encode then decode is identity", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(decodeBase64(encodeBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("verifyManifestSignature", () => {
  test("accepts a correctly signed manifest", async () => {
    const { manifest, pubkey } = await signedManifest();
    await expect(verifyManifestSignature(manifest, pubkey)).resolves.toBeUndefined();
  });
  test("throws SignatureInvalid when a field is tampered after signing", async () => {
    const { manifest, pubkey } = await signedManifest();
    manifest["version"] = "9.9.9";
    await expect(verifyManifestSignature(manifest, pubkey)).rejects.toBeInstanceOf(
      SignatureInvalid,
    );
  });
  test("throws PublisherKeyMismatch when resolved key differs from declared", async () => {
    const { manifest } = await signedManifest();
    const other = generateEd25519Keypair().pubkey;
    await expect(verifyManifestSignature(manifest, other)).rejects.toBeInstanceOf(
      PublisherKeyMismatch,
    );
  });
  test("throws SignatureInvalidFormat for a wrong-length resolved pubkey", async () => {
    const { manifest } = await signedManifest();
    await expect(verifyManifestSignature(manifest, new Uint8Array(31))).rejects.toBeInstanceOf(
      SignatureInvalidFormat,
    );
  });
  test("throws SignatureInvalidFormat for a wrong-length declared pubkey", async () => {
    const { manifest, pubkey } = await signedManifest();
    manifest.publisher = { id: "demo", key: encodeBase64(new Uint8Array(31)) };
    await expect(verifyManifestSignature(manifest, pubkey)).rejects.toBeInstanceOf(
      SignatureInvalidFormat,
    );
  });
  test("throws SignatureInvalidFormat for a wrong-length signature", async () => {
    const { manifest, pubkey } = await signedManifest();
    manifest.signature = encodeBase64(new Uint8Array(63));
    await expect(verifyManifestSignature(manifest, pubkey)).rejects.toBeInstanceOf(
      SignatureInvalidFormat,
    );
  });
  test("throws when manifest is unsigned (no publisher / no signature)", async () => {
    const { pubkey } = await signedManifest();
    await expect(verifyManifestSignature({ id: "x" }, pubkey)).rejects.toThrow(/unsigned manifest/);
  });
  test("throws when publisher is present but signature is missing", async () => {
    const pubkey = generateEd25519Keypair().pubkey;
    await expect(
      verifyManifestSignature(
        { id: "x", publisher: { id: "p", key: encodeBase64(pubkey) } },
        pubkey,
      ),
    ).rejects.toThrow(/unsigned manifest/);
  });
  test("throws when signature is present but publisher is missing", async () => {
    const pubkey = generateEd25519Keypair().pubkey;
    await expect(verifyManifestSignature({ id: "x", signature: "AA==" }, pubkey)).rejects.toThrow(
      /unsigned manifest/,
    );
  });
});

describe("signManifest", () => {
  test("throws SignatureInvalidFormat for a non-32-byte private key", async () => {
    await expect(signManifest({ id: "x" }, new Uint8Array(16))).rejects.toBeInstanceOf(
      SignatureInvalidFormat,
    );
  });
});

describe("errorToHardDisableReason", () => {
  test("maps each error class to its reason", () => {
    expect(errorToHardDisableReason(new PublisherKeyMismatch())).toBe("publisher_key_mismatch");
    expect(errorToHardDisableReason(new SignatureInvalidFormat())).toBe("signature_malformed");
    expect(errorToHardDisableReason(new SignatureInvalid())).toBe("signature_failed");
    expect(errorToHardDisableReason(new Error("unknown"))).toBe("signature_failed");
  });
});
