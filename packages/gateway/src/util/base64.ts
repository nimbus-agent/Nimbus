/**
 * Base64 codec owned by the gateway.
 *
 * `@nimbus-dev/sdk` exports `encodeBase64`/`decodeBase64` too, and this is byte-for-byte the
 * same implementation — but the SDK deprecated both in 1.32.0, pointing at a
 * `@nimbus-dev/sdk/signing` replacement whose detached-JWS envelope has not shipped. The
 * deprecation is real (they are slated for removal in SDK 2.0.0) and the migration target does
 * not exist, so every gateway call site was carrying a warning it had no way to clear.
 *
 * Base64 is not part of the signing envelope being replaced — it is a codec the gateway uses for
 * Vault-stored key material, signature wire format, salts and digests — so the gateway owns it
 * rather than tracking the SDK's signing-contract lifecycle for it. The signing contract proper
 * (`signManifest`, `verifyManifestSignature`, `errorToHardDisableReason`) still comes from the
 * SDK, confined to `extensions/verify-signature.ts`.
 */

/** Encode bytes as standard (padded, non-URL-safe) base64. */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode standard base64. Lenient about padding, matching `Buffer`'s own behaviour. */
export function decodeBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
