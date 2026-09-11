/**
 * The gateway's single seam onto `@nimbus-dev/sdk`'s manifest canonicalization.
 *
 * SDK 1.32.0 deprecated this surface in favour of `@nimbus-dev/sdk/signing`, which binds
 * `docs/spec/signing/v1/canonical-json.md`. **The gateway cannot migrate to it, and the reason is
 * not that the replacement is missing — it is that the two disagree on bytes.** The deprecated
 * rules Unicode-normalize string VALUES to NFC; the spec binding deliberately does not, because Go
 * publishes no importable normalization and a cross-language binding could not honour it. So for
 * any manifest or artifact containing a non-ASCII string the two produce different canonical
 * bytes, and therefore different signatures.
 *
 * Those bytes are already load-bearing in two places that outlive a release: every installed
 * `publisher` extension's manifest signature (I16, re-verified at every startup) and every saved
 * generated tool's artifact signature (I40, re-verified at boot, at registry load, and before each
 * spawn). Switching canonicalizers would invalidate both on disk. The migration is therefore a
 * re-signing exercise, not an import swap, and it happens when the detached-JWS envelope lands.
 *
 * Until then the deprecated import stays here and nowhere else, wrapped rather than re-exported so
 * consumers bind a live symbol.
 */
// NOSONAR S1874: deprecated in SDK 1.32.0, and here the replacement EXISTS but produces different
// bytes — see this module's docstring. Migrating would invalidate every extension and saved-tool
// signature already on disk, so it is a re-signing exercise, not an import swap.
import {
  canonicalize as sdkCanonicalize, // NOSONAR S1874
  canonicalizeManifest as sdkCanonicalizeManifest, // NOSONAR S1874
} from "@nimbus-dev/sdk";

export {
  ManifestNestedTooDeep,
  NonIntegerNumberInManifest,
  UnsupportedManifestValueType,
} from "@nimbus-dev/sdk";

/**
 * Deterministically serialize a `JSON.parse`-domain value: keys sorted by UTF-16 code unit, string
 * values NFC-normalized, integers only, no whitespace. `depth` is the recursion guard's current
 * level and exists for the recursive calls; callers pass one argument.
 */
export function canonicalize(value: unknown, depth?: number): string {
  return sdkCanonicalize(value, depth); // NOSONAR S1874
}

/** Canonicalize a manifest with its top-level `signature` member stripped; returns UTF-8 bytes. */
export function canonicalizeManifest(manifest: object): Uint8Array {
  return sdkCanonicalizeManifest(manifest); // NOSONAR S1874
}
