/**
 * The CLI's single seam onto `@nimbus-dev/sdk`'s extension-manifest signature contract, backing
 * `nimbus extension keygen` and `nimbus extension sign`.
 *
 * SDK 1.32.0 deprecated that contract — sign, verify, keygen and the base64 codec — in favour of a
 * detached-JWS envelope under `@nimbus-dev/sdk/signing` that has not shipped; the subpath exports
 * canonicalization and nothing else today. Removal is slated for SDK 2.0.0, so the warnings are
 * real, but there is nothing to migrate to and the gateway still verifies the flat
 * `publisher.key` + `signature` shape at install and at every startup (I16).
 *
 * Keygen and base64 are not part of the envelope being replaced, so they are owned outright here —
 * byte-for-byte the SDK's implementations. `signManifest` IS the contract and must stay the SDK's,
 * because what this CLI signs is what the gateway verifies; it is wrapped rather than re-exported
 * so the deprecation stops at this file.
 *
 * The gateway keeps its own copy of this seam (`extensions/verify-signature.ts`) — the two
 * packages are IPC-only neighbours and neither may import the other's source.
 */
import { generateKeyPairSync } from "node:crypto";

// NOSONAR S1874: deprecated in SDK 1.32.0 with NO shipped replacement. `signManifest` IS the
// contract — what this CLI signs is what the gateway verifies at install and every startup (I16) —
// so it must stay the SDK's, unlike the codec and keygen above, which this file owns outright.
import { signManifest as sdkSignManifest } from "@nimbus-dev/sdk"; // NOSONAR S1874

/** Encode bytes as standard (padded, non-URL-safe) base64. */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode standard base64. */
export function decodeBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Generate a fresh Ed25519 keypair: a 32-byte seed and the 32-byte public point. */
export function generateEd25519Keypair(): { privkey: Uint8Array; pubkey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    privkey: new Uint8Array(Buffer.from(privJwk.d, "base64url")),
    pubkey: new Uint8Array(Buffer.from(pubJwk.x, "base64url")),
  };
}

/**
 * Sign a manifest's canonical bytes with a 32-byte Ed25519 seed; returns the 64-byte signature as
 * base64. Any existing `signature` field is stripped before canonicalization.
 */
export async function signManifest(
  manifest: { publisher?: { id: string; key: string }; signature?: string; [k: string]: unknown },
  privkey: Uint8Array,
): Promise<string> {
  return await sdkSignManifest(manifest, privkey); // NOSONAR S1874
}
