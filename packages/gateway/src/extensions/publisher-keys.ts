/**
 * Publisher-key vault cache. Stores 32-byte Ed25519 pubkeys base64-encoded
 * under `extension.publisher_key.<publisher-id>`. The vault-key allow-list
 * (D11 static audit) restricts this namespace.
 */

import { readFileSync } from "node:fs";

import type { NimbusVault } from "../vault/index.ts";
import type { PublisherKeyFetcher } from "./registry-client.ts";
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

export class AirGapNoPublisherKey extends Error {
  override readonly name = "AirGapNoPublisherKey";
  constructor(publisherId: string) {
    super(
      `air-gap is enforced; publisher key for "${publisherId}" is not in your local cache — re-run \`nimbus extension install <path-or-url> --publisher-key <path>\` with the key locally available`,
    );
  }
}

export class PublisherNotRegistered extends Error {
  override readonly name = "PublisherNotRegistered";
  constructor(publisherId: string) {
    super(`publisher "${publisherId}" is not registered with the registry; install refused`);
  }
}

export class RegistryUnreachable extends Error {
  override readonly name = "RegistryUnreachable";
  constructor(publisherId: string, reason: string) {
    super(
      `could not reach registry for publisher "${publisherId}" (${reason}); check your network connection and re-run the install, or re-run \`nimbus extension install <path-or-url> --publisher-key <path>\` with the key locally available — \`nimbus extension sync\` cannot help here because it only refreshes already-installed extensions`,
    );
  }
}

export interface ResolvePublisherKeyOpts {
  publisherId: string;
  explicitKeyPath: string | undefined;
  vault: NimbusVault;
  fetcher: PublisherKeyFetcher;
  enforceAirGap: boolean;
}

/**
 * Resolve a publisher's 32-byte pubkey in priority order:
 *   1. --publisher-key <path>
 *   2. cached vault key extension.publisher_key.<id>
 *   3. registry fetch (refused under enforceAirGap)
 * Throws on the documented error classes.
 */
export async function resolvePublisherKey(opts: ResolvePublisherKeyOpts): Promise<Uint8Array> {
  // Priority 1: explicit file
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
  // Priority 2: vault cache
  const cached = await readPublisherKey(opts.vault, opts.publisherId);
  if (cached !== undefined) return cached;
  // Priority 3: registry
  if (opts.enforceAirGap) throw new AirGapNoPublisherKey(opts.publisherId);
  const result = await opts.fetcher.fetch(opts.publisherId);
  if (result.kind === "ok") return result.pubkey;
  if (result.kind === "not_found") throw new PublisherNotRegistered(opts.publisherId);
  if (result.kind === "transient") {
    throw new RegistryUnreachable(opts.publisherId, result.message);
  }
  throw new RegistryUnreachable(
    opts.publisherId,
    `${String(result.statusCode)}: ${result.message}`,
  );
}
