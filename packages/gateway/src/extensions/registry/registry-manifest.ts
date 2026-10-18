/**
 * Fetching and checking one version's `manifest.json` from a registry (spec § 8.6 steps 2–4),
 * shared by `install-from-registry.ts` and the update path so an install and an update can never
 * disagree about what a registry manifest must satisfy.
 */
import { createHash } from "node:crypto";
import {
  RegistryError,
  type RegistryExtensionEntry,
  type RegistryVersionEntry,
} from "@nimbus-dev/registry-format";
import { sha256HexEqualConstantTime } from "../../util/timing-safe-compare.ts";
import type { NimbusVault } from "../../vault/index.ts";
import { type ExtensionManifest, parseExtensionManifestForRegistry } from "../manifest.ts";
import { readPublisherKey } from "../publisher-keys.ts";
import { decodeBase64, verifyManifestSignature } from "../verify-signature.ts";
import { fetchRegistryBytes, type RegistryFetchDeps } from "./registry-fetch.ts";

/** A registry manifest is a small JSON document; anything larger is refused. */
export const MAX_REGISTRY_MANIFEST_BYTES = 64 * 1024;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function registryHashMismatch(what: string, id: string, version: string): RegistryError {
  return new RegistryError(
    "ERR_REGISTRY_HASH_MISMATCH",
    `the ${what} of ${id}@${version} does not match the hash the index signed`,
  );
}

export interface RegistryManifest {
  /** The fetched bytes as text — exactly what the index's `manifestSha256` covers. */
  text: string;
  manifest: ExtensionManifest;
  /** The publisher key the signed index names, decoded (the manifest declares the same one). */
  publisherKey: Uint8Array;
}

/**
 * One ledgered `registry.manifest` fetch, then: the bytes match the index's `manifestSha256`
 * before anything parses them, the manifest is `id@version`, and its publisher id and key are the
 * ones the index lists. The I16 signature is NOT verified here; see `verifyRegistryManifestSignature`.
 */
export async function fetchRegistryManifest(
  deps: RegistryFetchDeps,
  reg: { name: string; url: string },
  entry: RegistryExtensionEntry,
  id: string,
  version: string,
  vEntry: RegistryVersionEntry,
  signal?: AbortSignal,
): Promise<RegistryManifest> {
  const bytes = await fetchRegistryBytes(
    deps,
    reg,
    vEntry.manifest,
    {
      method: "registry.manifest",
      extensionId: id,
      version,
      maxBytes: MAX_REGISTRY_MANIFEST_BYTES,
    },
    signal,
  );
  if (!sha256HexEqualConstantTime(sha256Hex(bytes), vEntry.manifestSha256)) {
    throw registryHashMismatch("manifest", id, version);
  }
  const text = new TextDecoder().decode(bytes);
  let manifest: ExtensionManifest;
  try {
    manifest = parseExtensionManifestForRegistry(text).manifest;
  } catch (e) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_INVALID",
      `the manifest of ${id}@${version} is not valid: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (manifest.id !== id || manifest.version !== version) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_MISMATCH",
      `the manifest declares ${manifest.id}@${manifest.version}, not ${id}@${version}`,
    );
  }
  if (
    manifest.publisher === undefined ||
    manifest.publisher.id !== entry.publisher.id ||
    manifest.publisher.key !== entry.publisher.key
  ) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_MISMATCH",
      `the manifest's publisher differs from the one the index lists for ${id}`,
    );
  }
  return { text, manifest, publisherKey: decodeBase64(entry.publisher.key) };
}

/** `verifyManifestSignature` over a parsed manifest object (the shape check is the verifier's own). */
export function verifySignedManifest(manifest: object, key: Uint8Array): Promise<void> {
  return verifyManifestSignature(manifest as Parameters<typeof verifyManifestSignature>[0], key);
}

/** Verifies the manifest's I16 signature with the index's publisher key; throws `ERR_REGISTRY_SIGNATURE_INVALID`. */
export async function verifyRegistryManifestSignature(
  fetched: RegistryManifest,
  id: string,
  version: string,
  verify: (manifest: object, key: Uint8Array) => Promise<void> = verifySignedManifest,
): Promise<void> {
  try {
    await verify(JSON.parse(fetched.text) as Record<string, unknown>, fetched.publisherKey);
  } catch (e) {
    throw new RegistryError(
      "ERR_REGISTRY_SIGNATURE_INVALID",
      `the manifest signature of ${id}@${version} does not verify: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Whether the Vault already caches a DIFFERENT key for `publisherId` (spec § 8.6 step 4). */
export async function vaultPublisherKeyConflicts(
  vault: NimbusVault,
  publisherId: string,
  publisherKey: Uint8Array,
): Promise<boolean> {
  const cached = await readPublisherKey(vault, publisherId);
  return cached !== undefined && !Buffer.from(cached).equals(Buffer.from(publisherKey));
}
