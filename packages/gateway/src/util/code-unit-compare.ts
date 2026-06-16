/**
 * Deterministic, locale-independent code-unit comparison for canonical key/array ordering.
 *
 * Must NOT use `localeCompare` (locale-dependent → would break the cross-machine stability of any
 * signed canonical form). Matches the default `Array.prototype.sort()` lexicographic order.
 *
 * Shared by the share canonicalizer (`share/share-format.ts`) and the redaction-set ordering
 * (`share/share-redaction.ts`) so the comparison lives in exactly one place.
 */
export function codeUnitCompare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
