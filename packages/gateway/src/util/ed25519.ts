/**
 * Ed25519 keypair generation, owned by the gateway.
 *
 * `@nimbus-dev/sdk` exports the same function and this is the same implementation, but the SDK
 * deprecated it in 1.32.0 alongside its flat manifest-signature contract, pointing at a
 * `@nimbus-dev/sdk/signing` replacement that has not shipped. Keygen is not part of the envelope
 * being replaced — the share keypair (I27), the policy anchor (I22) and the toolgen signing seed
 * (I40) all need Ed25519 keys and none of them signs a manifest — so the gateway owns it.
 *
 * The manifest-signature contract proper stays with the SDK, confined to
 * `extensions/verify-signature.ts`.
 */
import { generateKeyPairSync } from "node:crypto";

/**
 * Generate a fresh Ed25519 keypair, both halves as raw 32-byte arrays: `privkey` is the seed
 * (not tweetnacl's 64-byte expanded secret key), `pubkey` the public point.
 *
 * Synchronous, hence `node:crypto` rather than WebCrypto's async `generateKey`.
 */
export function generateEd25519Keypair(): { privkey: Uint8Array; pubkey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    privkey: new Uint8Array(Buffer.from(privJwk.d, "base64url")),
    pubkey: new Uint8Array(Buffer.from(pubJwk.x, "base64url")),
  };
}
