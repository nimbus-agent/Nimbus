import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

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
  if (existingPriv !== null && existingPriv !== "" && existingPub !== null && existingPub !== "") {
    return { privkeyB64: existingPriv, pubkeyB64: existingPub };
  }
  const kp = generateEd25519Keypair();
  const privkeyB64 = encodeBase64(kp.privkey);
  const pubkeyB64 = encodeBase64(kp.pubkey);
  await vault.set(POLICY_SIGNING_PRIVKEY, privkeyB64);
  await vault.set(POLICY_SIGNING_PUBKEY, pubkeyB64);
  return { privkeyB64, pubkeyB64 };
}
