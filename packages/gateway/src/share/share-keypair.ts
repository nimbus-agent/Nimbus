import { decodeBase64, encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/** Vault key for the share signing seed (base64, 32-byte Ed25519 seed). NEVER leaves the Vault. */
export const SHARE_SIGNING_PRIVKEY = "share.signing.privkey";
/** Vault key for the share signing public key (base64). Safe to surface — it's embedded in shares. */
export const SHARE_SIGNING_PUBKEY = "share.signing.pubkey";

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
 * privkey from one keypair next to a pubkey from another), which would sign shares verifiers reject.
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
 * Resolve the share signing keypair from the Vault, generating + storing it on first use. The
 * private seed is Vault-only — it is read here solely to thread into the in-process signing call;
 * it is never returned over IPC/HTTP, persisted to a DB column, or logged. Mirrors
 * `policy/anchor-keypair.ts`.
 */
export async function ensureShareKeypair(
  vault: NimbusVault,
): Promise<{ privkeyB64: string; pubkeyB64: string }> {
  const existingPriv = await vault.get(SHARE_SIGNING_PRIVKEY);
  const existingPub = await vault.get(SHARE_SIGNING_PUBKEY);
  // Reuse persisted material only when BOTH values decode to valid 32-byte keys. Corrupt/
  // truncated Vault contents are regenerated here rather than deferring failure to a later
  // signing/verify path.
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
  await vault.set(SHARE_SIGNING_PRIVKEY, privkeyB64);
  await vault.set(SHARE_SIGNING_PUBKEY, pubkeyB64);
  return { privkeyB64, pubkeyB64 };
}
