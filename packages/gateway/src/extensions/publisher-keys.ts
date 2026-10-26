import { readFileSync } from "node:fs";

import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";

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

/**
 * Per-fingerprint keys (marketplace trust layer, rotation). After a publisher rotates, sibling
 * extensions can be signed by different keys, so each key is kept under its own fingerprint and an
 * extension verifies with the key its row recorded. The fingerprint comes FIRST so a dotted
 * publisher id never makes a Vault key ambiguous: `extension.publisher_keyfp.<fp>.<publisherId>`.
 * The legacy one-per-publisher key above is never overwritten by a rotation: rows that predate
 * fingerprints keep verifying with it.
 */
export const PUBLISHER_KEY_FP_VAULT_PREFIX = "extension.publisher_keyfp." as const;
const FP_RE = /^[0-9a-f]{32}$/;

function fpKey(publisherId: string, fingerprint: string): string {
  if (!FP_RE.test(fingerprint)) throw new Error("publisher key fingerprint must be 32 hex chars");
  return `${PUBLISHER_KEY_FP_VAULT_PREFIX}${fingerprint}.${publisherId}`;
}

function decodeKey(raw: string | null): Uint8Array | undefined {
  if (raw === null || raw === "") return undefined;
  const bytes = decodeBase64(raw);
  return bytes.length === 32 ? bytes : undefined;
}

/**
 * Stores `pubkey` under its fingerprint, and as the publisher's legacy key when it has none yet.
 * Returns the fingerprint.
 */
export async function writePublisherKeyFor(
  vault: NimbusVault,
  publisherId: string,
  pubkey: Uint8Array,
): Promise<string> {
  if (pubkey.length !== 32) {
    throw new Error(`publisher key must be 32 bytes (got ${String(pubkey.length)})`);
  }
  const b64 = encodeBase64(pubkey);
  const fingerprint = publisherKeyFingerprint(b64);
  await vault.set(fpKey(publisherId, fingerprint), b64);
  if ((await readPublisherKey(vault, publisherId)) === undefined) {
    await vault.set(key(publisherId), b64);
  }
  return fingerprint;
}

/**
 * The key an extension verifies with. `fingerprint` null (a row that predates V76 and was never
 * backfilled) reads the legacy key. Otherwise the key stored under that fingerprint, else the
 * legacy key ONLY if it has that fingerprint — never a different key.
 */
export async function readPublisherKeyFor(
  vault: NimbusVault,
  publisherId: string,
  fingerprint: string | null,
): Promise<Uint8Array | undefined> {
  if (fingerprint === null) return readPublisherKey(vault, publisherId);
  if (!FP_RE.test(fingerprint)) return undefined;
  const exact = decodeKey(await vault.get(fpKey(publisherId, fingerprint)));
  if (exact !== undefined) {
    return publisherKeyFingerprint(encodeBase64(exact)) === fingerprint ? exact : undefined;
  }
  const legacy = await readPublisherKey(vault, publisherId);
  if (legacy === undefined) return undefined;
  return publisherKeyFingerprint(encodeBase64(legacy)) === fingerprint ? legacy : undefined;
}

/** Every key the Vault trusts for `publisherId` (legacy and per-fingerprint), base64, deduplicated. */
export async function listTrustedPublisherKeys(
  vault: NimbusVault,
  publisherId: string,
): Promise<string[]> {
  const out = new Set<string>();
  const legacy = await readPublisherKey(vault, publisherId);
  if (legacy !== undefined) out.add(encodeBase64(legacy));
  for (const k of await vault.listKeys(PUBLISHER_KEY_FP_VAULT_PREFIX)) {
    const rest = k.slice(PUBLISHER_KEY_FP_VAULT_PREFIX.length);
    const fingerprint = rest.slice(0, 32);
    if (!FP_RE.test(fingerprint) || rest.slice(32) !== `.${publisherId}`) continue;
    // Sequential: the Vault backends are not safe for unbounded concurrent reads on every OS.
    const bytes = decodeKey(await vault.get(k)); // NOSONAR S9382: one Vault read at a time
    if (bytes !== undefined && publisherKeyFingerprint(encodeBase64(bytes)) === fingerprint) {
      out.add(encodeBase64(bytes));
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Removes every key the Vault trusts for `publisherId`: the legacy one and each per-fingerprint one. */
export async function evictPublisherKey(vault: NimbusVault, publisherId: string): Promise<void> {
  await vault.delete(key(publisherId));
  for (const k of await vault.listKeys(PUBLISHER_KEY_FP_VAULT_PREFIX)) {
    if (k.slice(PUBLISHER_KEY_FP_VAULT_PREFIX.length + 32) === `.${publisherId}`) {
      await vault.delete(k); // NOSONAR S9382: one Vault write at a time
    }
  }
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
  /** The manifest's declared key: the cached key looked up is the one with ITS fingerprint. */
  declaredKey?: string;
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
  const cached =
    opts.declaredKey === undefined
      ? await readPublisherKey(opts.vault, opts.publisherId)
      : await readPublisherKeyFor(
          opts.vault,
          opts.publisherId,
          publisherKeyFingerprint(opts.declaredKey),
        );
  if (cached !== undefined) return cached;
  throw new PublisherKeyRequired(opts.publisherId);
}
