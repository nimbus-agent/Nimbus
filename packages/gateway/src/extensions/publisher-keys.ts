import { readFileSync } from "node:fs";

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

/**
 * Thrown when a signed LOCAL install has no publisher key to verify with: none was passed and the
 * Vault caches none for that publisher. A local install never fetches a key (spec § 8.9).
 */
export class PublisherKeyRequired extends Error {
  override readonly name = "PublisherKeyRequired";
  constructor(publisherId: string) {
    super(
      `extension is signed by publisher "${publisherId}" and no key for it is cached in the Vault; re-run with \`--publisher-key <path>\` naming that publisher's public key file`,
    );
  }
}

export interface ResolvePublisherKeyOpts {
  publisherId: string;
  explicitKeyPath: string | undefined;
  vault: NimbusVault;
}

/** The key file the owner named, else the Vault's cached key, else `PublisherKeyRequired`. */
export async function resolvePublisherKey(opts: ResolvePublisherKeyOpts): Promise<Uint8Array> {
  if (opts.explicitKeyPath !== undefined) {
    let text: string;
    try {
      text = readFileSync(opts.explicitKeyPath, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`publisher key file ${opts.explicitKeyPath} could not be read: ${msg}`);
    }
    const trimmed = text.trim();
    if (trimmed.length !== 44) {
      throw new Error(
        `publisher key file ${opts.explicitKeyPath} must contain exactly 44 base64 chars (got ${String(trimmed.length)})`,
      );
    }
    const bytes = decodeBase64(trimmed);
    if (bytes.length !== 32) {
      throw new Error(`publisher key file ${opts.explicitKeyPath} did not decode to 32 bytes`);
    }
    return bytes;
  }
  const cached = await readPublisherKey(opts.vault, opts.publisherId);
  if (cached !== undefined) return cached;
  throw new PublisherKeyRequired(opts.publisherId);
}
