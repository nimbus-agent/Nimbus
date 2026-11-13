/**
 * Canonical JSON for hashing: object keys sorted by UTF-16 code unit at every depth, no whitespace,
 * array order kept, `undefined` members dropped, and NO Unicode normalisation (a one-byte change in a
 * string is a different string). Shared by the workflow step hash, the standing-rule scope hash and
 * the connector-write definition hash, so each is stable on every machine and in every locale.
 *
 * Not `extensions/canonical-json.ts`: that one NFC-normalises string values and refuses non-integer
 * numbers, which would hide a one-byte change and throw on a schema holding `0.5`.
 */

/**
 * Code-unit order, NOT `localeCompare`: a hash must be the same on every machine and in every locale,
 * so the key order cannot depend on collation.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** One `"key":value` member of a canonical object. */
function canonicalMember(rec: Record<string, unknown>, k: string): string {
  return `${JSON.stringify(k)}:${canonicalJson(rec[k])}`;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort(byCodeUnit);
  return `{${keys.map((k) => canonicalMember(rec, k)).join(",")}}`;
}
