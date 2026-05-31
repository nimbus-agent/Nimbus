/**
 * Ed25519 sign + verify primitives for extension manifest signatures.
 * Connector authors use this to sign manifests; the gateway uses it to verify
 * at install + every startup (I16 wiring sites).
 */

import { canonicalizeManifest } from "./canonical-json";

export class PublisherKeyMismatch extends Error {
  override readonly name = "PublisherKeyMismatch";
}
export class SignatureInvalidFormat extends Error {
  override readonly name = "SignatureInvalidFormat";
}
export class SignatureInvalid extends Error {
  override readonly name = "SignatureInvalid";
}

export type SignatureDisableReason =
  | "publisher_key_missing"
  | "publisher_key_mismatch"
  | "signature_failed"
  | "signature_malformed";

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

type SignedManifestShape = {
  publisher?: { id: string; key: string };
  signature?: string;
  [k: string]: unknown;
};

/**
 * Verify `manifest.signature` against the canonical bytes of the manifest
 * (with `signature` stripped), the declared `manifest.publisher.key`, and
 * the externally-resolved `resolvedPubkey`. Throws on any mismatch.
 *
 * Caller must check `manifest.publisher !== undefined` first — this function
 * does not gate the unsigned case.
 */
export async function verifyManifestSignature(
  manifest: SignedManifestShape,
  resolvedPubkey: Uint8Array,
): Promise<void> {
  if (manifest.publisher === undefined || manifest.signature === undefined) {
    throw new Error(
      "verifyManifestSignature called on unsigned manifest — caller must check first",
    );
  }
  if (resolvedPubkey.length !== 32) throw new SignatureInvalidFormat();
  const declaredPubkey = decodeBase64(manifest.publisher.key);
  if (declaredPubkey.length !== 32) throw new SignatureInvalidFormat();
  if (!constantTimeBytesEqual(declaredPubkey, resolvedPubkey)) {
    throw new PublisherKeyMismatch();
  }
  const sig = decodeBase64(manifest.signature);
  if (sig.length !== 64) throw new SignatureInvalidFormat();
  const canonical = canonicalizeManifest(manifest);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(resolvedPubkey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    new Uint8Array(sig),
    new Uint8Array(canonical),
  );
  if (!ok) throw new SignatureInvalid();
}

/**
 * Deterministically sign a manifest's canonical bytes with `privkey` (32-byte
 * Ed25519 seed). Returns the 64-byte signature as base64. Any existing
 * `signature` field on the manifest is ignored (stripped by
 * `canonicalizeManifest`).
 */
export async function signManifest(
  manifest: SignedManifestShape,
  privkey: Uint8Array,
): Promise<string> {
  if (privkey.length !== 32) throw new SignatureInvalidFormat();
  const d = Buffer.from(privkey).toString("base64url");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", d },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const canonical = canonicalizeManifest(manifest);
  const sig = await crypto.subtle.sign("Ed25519", cryptoKey, new Uint8Array(canonical));
  return encodeBase64(new Uint8Array(sig));
}

/**
 * Generate a fresh Ed25519 keypair via WebCrypto and export both halves as
 * raw 32-byte arrays. Used by `nimbus extension keygen` and by every test
 * fixture (no committed crypto material — see spec §6.3).
 */
export function generateEd25519Keypair(): { privkey: Uint8Array; pubkey: Uint8Array } {
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("ed25519");
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const privkey = new Uint8Array(Buffer.from(privJwk.d, "base64url"));
  const pubkey = new Uint8Array(Buffer.from(pubJwk.x, "base64url"));
  return { privkey, pubkey };
}

/**
 * Map a verification error class to the `SignatureDisableReason` string the
 * `SignatureDisabledRegistry` (hard-disable.ts) records.
 */
export function errorToHardDisableReason(err: unknown): SignatureDisableReason {
  if (err instanceof PublisherKeyMismatch) return "publisher_key_mismatch";
  if (err instanceof SignatureInvalidFormat) return "signature_malformed";
  if (err instanceof SignatureInvalid) return "signature_failed";
  return "signature_failed";
}
