import { type BoxKeypair, boxKeypairFromSecretKey, generateBoxKeypair } from "../ipc/lan-crypto.ts";
import type { VaultReader, VaultWriter } from "../vault/nimbus-vault.ts";

export const FEDERATION_IDENTITY_VAULT_KEY = "federation.identity_secret";

/**
 * Load-or-create the gateway's persistent NaCl box identity. The 32-byte secret is stored
 * base64-encoded in the Vault; the public key is the gateway's stable peer identity. Vault-only
 * (non-negotiable #3). A corrupt/short stored value is regenerated and overwritten.
 */
export async function loadOrCreateFederationIdentity(
  vault: VaultReader & VaultWriter,
): Promise<BoxKeypair> {
  const existing = await vault.get(FEDERATION_IDENTITY_VAULT_KEY);
  if (existing !== null) {
    const secret = new Uint8Array(Buffer.from(existing, "base64"));
    if (secret.length === 32) return boxKeypairFromSecretKey(secret);
    // fall through: corrupt → regenerate
  }
  const kp = generateBoxKeypair();
  await vault.set(FEDERATION_IDENTITY_VAULT_KEY, Buffer.from(kp.secretKey).toString("base64"));
  return kp;
}
