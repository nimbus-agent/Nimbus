/**
 * The gateway's single seam onto `@nimbus-dev/sdk`'s extension-manifest signature contract (I16).
 *
 * `@nimbus-dev/sdk` 1.32.0 deprecated that whole contract — `signManifest`,
 * `verifyManifestSignature`, `errorToHardDisableReason`, `generateEd25519Keypair`, the base64
 * codec and the `SignatureDisableReason` union — in favour of a detached-JWS envelope under
 * `@nimbus-dev/sdk/signing`. That envelope **has not shipped**: the subpath exports
 * canonicalization and nothing else today. So the deprecation is real (removal is slated for SDK
 * 2.0.0) and there is no migration target, while the gateway must keep verifying the flat
 * `publisher.key` + `signature` shape that every already-installed extension carries.
 *
 * This module is where that stays true in one place instead of thirty. Three of the deprecated
 * symbols are not part of the envelope being replaced at all and are simply owned here or in
 * `util/base64.ts` — the base64 codec, Ed25519 keygen, and the reason union, each byte- or
 * shape-identical to the SDK's. The three that ARE the envelope contract — sign, verify, and the
 * error-to-reason mapping — must keep coming from the SDK, because a connector author signs with
 * the SDK and the gateway has to verify what they produced. Those are wrapped rather than
 * re-exported, so the deprecation warning stops here and every consumer imports a live symbol.
 *
 * When the JWS envelope ships, this file is the one that changes.
 */
// NOSONAR S1874: deprecated in SDK 1.32.0 with NO shipped replacement — the `@nimbus-dev/sdk/signing`
// JWS envelope it points at exports canonicalization and nothing else. Deliberately concentrated on
// these three lines: see this module's docstring for why the gateway cannot migrate yet, and why
// wrapping (rather than re-exporting) keeps every consumer bound to a live symbol.
import {
  errorToHardDisableReason as sdkErrorToHardDisableReason, // NOSONAR S1874
  signManifest as sdkSignManifest, // NOSONAR S1874
  verifyManifestSignature as sdkVerifyManifestSignature, // NOSONAR S1874
} from "@nimbus-dev/sdk";

export { PublisherKeyMismatch, SignatureInvalid, SignatureInvalidFormat } from "@nimbus-dev/sdk";
export { decodeBase64, encodeBase64 } from "../util/base64.ts";
export { generateEd25519Keypair } from "../util/ed25519.ts";

/**
 * The manifest shape the flat signature contract reads. Structurally identical to the SDK's own
 * (unexported) `SignedManifestShape`; the index signature is what lets an arbitrary parsed
 * manifest object be passed straight through.
 */
export type SignedManifestShape = {
  publisher?: { id: string; key: string };
  signature?: string;
  [k: string]: unknown;
};

/**
 * Why a `publisher` extension was hard-disabled at verification time. Same four members as the
 * SDK's deprecated union, so values still cross the boundary in both directions.
 */
export type SignatureDisableReason =
  | "publisher_key_missing"
  | "publisher_key_mismatch"
  | "signature_failed"
  | "signature_malformed";

/**
 * Verify `manifest.signature` against the canonical manifest bytes, the declared
 * `manifest.publisher.key` and the externally-resolved `resolvedPubkey`. Throws on any mismatch.
 *
 * The caller must establish `manifest.publisher !== undefined` first — this does not gate the
 * unsigned case.
 */
export async function verifyManifestSignature(
  manifest: SignedManifestShape,
  resolvedPubkey: Uint8Array,
): Promise<void> {
  await sdkVerifyManifestSignature(manifest, resolvedPubkey); // NOSONAR S1874
}

/**
 * Sign a manifest's canonical bytes with a 32-byte Ed25519 seed; returns the 64-byte signature as
 * base64. Any existing `signature` field is stripped before canonicalization.
 */
export async function signManifest(
  manifest: SignedManifestShape,
  privkey: Uint8Array,
): Promise<string> {
  return await sdkSignManifest(manifest, privkey); // NOSONAR S1874
}

/** Map a verification error thrown above to the reason `hard-disable.ts` records. */
export function errorToHardDisableReason(err: unknown): SignatureDisableReason {
  return sdkErrorToHardDisableReason(err); // NOSONAR S1874
}
