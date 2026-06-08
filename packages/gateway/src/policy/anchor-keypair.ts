import { decodeBase64, encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/** True only if `v` decodes from base64 to exactly `expected` bytes (Ed25519 seed/pubkey = 32). */
function isValidB64Len(v: string, expected: number): boolean {
  try {
    return decodeBase64(v).length === expected;
  } catch {
    return false;
  }
}

/** Vault key for the anchor's Ed25519 signing seed (base64). NEVER leaves the Vault. */
export const POLICY_SIGNING_PRIVKEY = "policy.signing.privkey";
/** Vault key for the anchor's Ed25519 public key (base64). Safe to surface (it's pinned locally). */
export const POLICY_SIGNING_PUBKEY = "policy.signing.pubkey";

/**
 * Resolve the anchor signing keypair from the Vault, generating + storing it on first use. The
 * private seed is Vault-only — it is read here solely to thread into the in-process signing call;
 * it is never returned over IPC/HTTP, persisted to a DB column, or logged.
 */
export async function ensureAnchorKeypair(
  vault: NimbusVault,
): Promise<{ privkeyB64: string; pubkeyB64: string }> {
  const existingPriv = await vault.get(POLICY_SIGNING_PRIVKEY);
  const existingPub = await vault.get(POLICY_SIGNING_PUBKEY);
  // Reuse persisted material only when BOTH values decode to valid 32-byte keys. Corrupt/
  // truncated Vault contents are regenerated here rather than deferring failure to a later
  // signing/verify path.
  if (
    existingPriv !== null &&
    existingPub !== null &&
    isValidB64Len(existingPriv, 32) &&
    isValidB64Len(existingPub, 32)
  ) {
    return { privkeyB64: existingPriv, pubkeyB64: existingPub };
  }
  const kp = generateEd25519Keypair();
  const privkeyB64 = encodeBase64(kp.privkey);
  const pubkeyB64 = encodeBase64(kp.pubkey);
  await vault.set(POLICY_SIGNING_PRIVKEY, privkeyB64);
  await vault.set(POLICY_SIGNING_PUBKEY, pubkeyB64);
  return { privkeyB64, pubkeyB64 };
}
