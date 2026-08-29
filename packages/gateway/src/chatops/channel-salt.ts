import { blake3 } from "@noble/hashes/blake3.js";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * Vault key for the per-install channel-id hashing salt (base64, 32 bytes). NEVER leaves the Vault
 * and is never written to the ledger, a log, IPC or config.
 */
export const CHATOPS_CHANNEL_SALT = "chatops.channel.salt";

const SALT_BYTES = 32;

function isValidSalt(b64: string): boolean {
  try {
    return Buffer.from(b64, "base64").length === SALT_BYTES;
  } catch {
    return false;
  }
}

/**
 * Resolve the channel-hash salt from the Vault, generating and storing it on first use. Mirrors
 * `share/share-keypair.ts`'s `ensureShareKeypair`.
 *
 * Nothing ever reverses the hash, so losing or rotating this salt costs only the ability to
 * correlate rows across the rotation — a fail-safe direction, which is why a corrupt stored value
 * is regenerated here rather than raising.
 */
export async function ensureChannelSalt(vault: NimbusVault): Promise<string> {
  const existing = await vault.get(CHATOPS_CHANNEL_SALT);
  if (existing !== null && isValidSalt(existing)) return existing;
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(SALT_BYTES))).toString("base64");
  try {
    await vault.set(CHATOPS_CHANNEL_SALT, salt);
  } catch (err) {
    // This is called on the chatops boot path, so a Vault write failure BLOCKS THE BOT FROM
    // STARTING. That is the correct fail-closed posture -- without a salt the alternative is an
    // unsalted hash, which is reversible by dictionary -- but a bare DPAPI/libsecret error at boot
    // reads as "chatops is broken" with no indication of why. Name the key and the consequence.
    throw new Error(
      `chatops: cannot persist the channel-hash salt ("${CHATOPS_CHANNEL_SALT}") to the Vault, ` +
        `so ChatOps will not start. Every outbound post must be ledgered with a salted channel ` +
        `hash (I29), and an unsalted fallback is not offered because channel ids are enumerable. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return salt;
}

/**
 * `BLAKE3(salt ‖ channelId)` as lowercase hex.
 *
 * The salt is REQUIRED, not defence in depth. Slack and Teams channel ids come from a small,
 * enumerable set: anyone with workspace access can list every channel, hash each one and match
 * against the ledger, recovering exactly which rooms the gateway posted into. That is a dictionary
 * attack, and the id's own entropy does not defend against it.
 */
export function hashChannelId(saltB64: string, channelId: string): string {
  const salt = Buffer.from(saltB64, "base64");
  const id = Buffer.from(channelId, "utf8");
  return Buffer.from(blake3(Buffer.concat([salt, id]))).toString("hex");
}
