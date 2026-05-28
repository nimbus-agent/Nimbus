/**
 * Deterministic JSON canonicalization for extension manifests.
 *
 * Used as the input to Ed25519 manifest signing (T2 PR 2 / I16). The signed
 * bytes are the manifest with the `signature` field stripped, re-serialized
 * via the rules below. Signing and verifying both call into this module so
 * the byte sequences match exactly.
 *
 * Rules:
 * - Object keys sorted in lexicographic UTF-16 code-unit order (JS `Array.sort` default).
 * - String VALUES Unicode-normalized to NFC so semantically-equal strings
 *   yield identical bytes regardless of how the source editor encoded them.
 *   Object KEYS are NOT normalized — the publisher signs them byte-for-byte
 *   as serialized.
 * - Integer numbers only (manifests have no floating-point fields).
 * - No whitespace; UTF-8 encoded.
 * - Recursion capped at MAX_DEPTH (32) — real manifests have depth ≤ 4; the
 *   cap defends against a maliciously crafted manifest blowing the stack.
 *
 * Preconditions: callers pass values produced by `JSON.parse`. That domain
 * guarantees no cycles, no undefined / function / symbol values, no NaN /
 * Infinity. The thrown error classes below are defensive for callers that
 * violate the precondition (e.g. constructing the input in-memory).
 */

export class NonIntegerNumberInManifest extends Error {
  override readonly name = "NonIntegerNumberInManifest";
}
export class UnsupportedManifestValueType extends Error {
  override readonly name = "UnsupportedManifestValueType";
}
export class ManifestNestedTooDeep extends Error {
  override readonly name = "ManifestNestedTooDeep";
}

const MAX_DEPTH = 32;

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new ManifestNestedTooDeep();
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new NonIntegerNumberInManifest();
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" +
      keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k], depth + 1)}`).join(",") +
      "}"
    );
  }
  throw new UnsupportedManifestValueType();
}

export function canonicalizeManifest(manifest: object): Uint8Array {
  const clone: Record<string, unknown> = { ...(manifest as Record<string, unknown>) };
  delete clone["signature"];
  return new TextEncoder().encode(canonicalize(clone));
}
