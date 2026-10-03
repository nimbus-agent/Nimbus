/**
 * Ed25519 keypair generation and Vault-backed keypair resolution, owned by the gateway.
 *
 * `@nimbus-dev/sdk` exports the same keygen function and this is the same implementation, but the
 * SDK deprecated it in 1.32.0 alongside its flat manifest-signature contract, pointing at a
 * `@nimbus-dev/sdk/signing` replacement that has not shipped. Keygen is not part of the envelope
 * being replaced — the share keypair (I27), the policy anchor (I22) and the toolgen signing seed
 * (I40) all need Ed25519 keys and none of them signs a manifest — so the gateway owns it.
 *
 * The manifest-signature contract proper stays with the SDK, confined to
 * `extensions/verify-signature.ts`.
 */
import { generateKeyPairSync } from "node:crypto";
import nacl from "tweetnacl";
import type { VaultReader, VaultWriter } from "../vault/nimbus-vault.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";

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

/** True only if `b64` decodes from base64 to exactly `len` bytes (Ed25519 seed/pubkey = 32). */
function isValidB64Len(b64: string, len: number): boolean {
  try {
    return decodeBase64(b64).length === len;
  } catch {
    return false;
  }
}

/**
 * True only if the stored public key is the one derived from the stored private seed — i.e. they
 * form a consistent Ed25519 keypair. Guards against a partially-rotated / mismatched Vault (a
 * privkey from one keypair next to a pubkey from another), which would sign with a seed whose
 * signatures the published pubkey then fails to verify.
 */
function isMatchingKeypair(privkeyB64: string, pubkeyB64: string): boolean {
  try {
    const derivedPub = nacl.sign.keyPair.fromSeed(decodeBase64(privkeyB64)).publicKey;
    return encodeBase64(derivedPub) === pubkeyB64;
  } catch {
    return false;
  }
}

/**
 * Resolve the Ed25519 signing keypair stored in the Vault under `privKeyName` / `pubKeyName`,
 * generating + storing a fresh one on first use. Both values are base64: the 32-byte seed and the
 * 32-byte public key.
 *
 * The private seed is Vault-only — it is read here solely to be handed back to the in-process
 * signing call of the module that owns the key names; it is never returned over IPC/HTTP,
 * persisted to a DB column, or logged.
 *
 * A stored pair that is absent, malformed (wrong decoded length) or internally inconsistent (a
 * privkey that does not derive the stored pubkey) is treated as unusable and replaced — this
 * never throws on a corrupted Vault, it regenerates, rather than deferring the failure to a later
 * signing/verify call. A Vault read or write that itself fails still rejects.
 *
 * The key NAMES are parameters, never literals here, so each name keeps its one home: static rule
 * D21 confines `share.signing.privkey` to `share/share-keypair.ts` (I27), and
 * `toolgen/toolgen-keypair.ts` (I40) is the D11 vault-key allow-list entry for the toolgen
 * signing keys. Not used by `policy/anchor-keypair.ts` (I22), whose resolver reuses a stored pair
 * WITHOUT the consistency check — a different rule, not a copy of this one.
 */
export async function ensureVaultEd25519Keypair(
  vault: VaultReader & VaultWriter,
  privKeyName: string,
  pubKeyName: string,
): Promise<{ privkeyB64: string; pubkeyB64: string }> {
  const existingPriv = await vault.get(privKeyName);
  const existingPub = await vault.get(pubKeyName);
  // Reuse persisted material only when BOTH values decode to valid 32-byte keys AND form a
  // consistent keypair.
  if (
    existingPriv !== null &&
    existingPub !== null &&
    isValidB64Len(existingPriv, 32) &&
    isValidB64Len(existingPub, 32) &&
    isMatchingKeypair(existingPriv, existingPub)
  ) {
    return { privkeyB64: existingPriv, pubkeyB64: existingPub };
  }
  const kp = generateEd25519Keypair();
  const privkeyB64 = encodeBase64(kp.privkey);
  const pubkeyB64 = encodeBase64(kp.pubkey);
  await vault.set(privKeyName, privkeyB64);
  await vault.set(pubKeyName, pubkeyB64);
  return { privkeyB64, pubkeyB64 };
}
