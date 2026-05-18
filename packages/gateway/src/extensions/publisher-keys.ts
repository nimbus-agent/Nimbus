/**
 * Publisher-key vault cache. Stores 32-byte Ed25519 pubkeys base64-encoded
 * under `extension.publisher_key.<publisher-id>`. The vault-key allow-list
 * (D11 static audit) restricts this namespace.
 */

import type { NimbusVault } from "../vault/index.ts";
import { decodeBase64, encodeBase64 } from "./verify-signature.ts";

export const PUBLISHER_KEY_VAULT_PREFIX = "extension.publisher_key." as const;

function key(publisherId: string): string {
  return `${PUBLISHER_KEY_VAULT_PREFIX}${publisherId}`;
}

export async function readPublisherKey(
  vault: NimbusVault,
  publisherId: string,
): Promise<Uint8Array | undefined> {
  const raw = await vault.get(key(publisherId));
  if (raw === null || raw === "") return undefined;
  const bytes = decodeBase64(raw);
  if (bytes.length !== 32) return undefined;
  return bytes;
}

export async function writePublisherKey(
  vault: NimbusVault,
  publisherId: string,
  pubkey: Uint8Array,
): Promise<void> {
  if (pubkey.length !== 32) {
    throw new Error(`publisher key must be 32 bytes (got ${String(pubkey.length)})`);
  }
  await vault.set(key(publisherId), encodeBase64(pubkey));
}

export async function evictPublisherKey(vault: NimbusVault, publisherId: string): Promise<void> {
  await vault.delete(key(publisherId));
}

export async function listCachedPublisherIds(vault: NimbusVault): Promise<readonly string[]> {
  const all = await vault.listKeys(PUBLISHER_KEY_VAULT_PREFIX);
  const out: string[] = [];
  for (const k of all) {
    if (k.startsWith(PUBLISHER_KEY_VAULT_PREFIX)) {
      out.push(k.slice(PUBLISHER_KEY_VAULT_PREFIX.length));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}
