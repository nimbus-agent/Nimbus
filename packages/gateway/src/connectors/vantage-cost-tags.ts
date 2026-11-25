/**
 * The value of each `tag:<key>` grouping that `vantage.group_by` names, read from a Vantage
 * `GET /v2/costs` row.
 *
 * Shape verified against one live account's reply (2026-11-25, groupings
 * `provider,service,tag:owner,tag:repo`, `date_bin=day`):
 * - `tags` is an array of `"<key>:<value>"` strings, one per tag grouping, in the order the
 *   groupings were requested: `["owner:acme", "repo:web"]`.
 * - A row without that tag carries `"<key>:"` (an empty value) and no `tag` field.
 * - `tag` (a string) is the value of the FIRST tag grouping only; the published OpenAPI file marks
 *   it deprecated ("does not support multiple tags"). It is read only when `tags` is absent.
 *
 * Nothing here runs unless `vantage.group_by` names a `tag:` key. A saved report's own tag
 * groupings (with no `vantage.group_by`) keep FO2's reading, the raw `tag` field as a dimension, so
 * the identity of a series indexed before this change never moves.
 *
 * A tag key can hold a colon (`aws:cloudformation:stack-name`), so entries are matched by a
 * requested key's own `<key>:` prefix, never split on the first colon. When the array lines up
 * with the requested keys entry for entry (the live order), each entry belongs to its position.
 * Otherwise each entry goes to the LONGEST requested key whose prefix it carries, so a key `a`
 * never takes the entry of a requested key `a:b`.
 */

/** The series value of a `tag:<key>` grouping on a row that does not carry that tag. */
export const VANTAGE_UNTAGGED = "__untagged__";

const TAG_PREFIX = "tag:";

/** `dims[name]` is the tag's value, or null when the row does not carry the tag. */
export type VantageTagDims = Record<string, string | null>;

function requestedTagKeys(groupBy: readonly string[]): string[] {
  const keys: string[] = [];
  for (const name of groupBy) {
    if (name.startsWith(TAG_PREFIX) && name.length > TAG_PREFIX.length) {
      const key = name.slice(TAG_PREFIX.length);
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function valueAfter(entry: string, key: string): string | null {
  const v = entry.slice(key.length + 1);
  return v === "" ? null : v;
}

function linesUp(entries: readonly string[], keys: readonly string[]): boolean {
  return entries.length === keys.length && keys.every((k, i) => entries[i]?.startsWith(`${k}:`));
}

/** The requested key an entry belongs to when positions cannot be trusted: the longest match. */
function longestKeyOf(entry: string, keys: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    if (entry.startsWith(`${key}:`) && (best === undefined || key.length > best.length)) best = key;
  }
  return best;
}

function fromTagsArray(entries: readonly string[], keys: readonly string[]): VantageTagDims {
  const dims: VantageTagDims = {};
  // A requested tag the row does not list is the same fact as `"<key>:"`: untagged.
  for (const key of keys) dims[`${TAG_PREFIX}${key}`] = null;
  if (linesUp(entries, keys)) {
    keys.forEach((key, i) => {
      dims[`${TAG_PREFIX}${key}`] = valueAfter(entries[i] ?? "", key);
    });
    return dims;
  }
  const filled = new Set<string>();
  for (const entry of entries) {
    const key = longestKeyOf(entry, keys);
    if (key === undefined || filled.has(key)) continue;
    filled.add(key);
    dims[`${TAG_PREFIX}${key}`] = valueAfter(entry, key);
  }
  return dims;
}

/**
 * The tag dimensions of one row, as `{ "tag:<key>": value | null }`, and whether the row's own
 * `tag` and `tags` fields were consumed (the caller then drops them rather than read `tag` as a
 * dimension). With no `tag:` key in `groupBy` nothing is consumed: FO2's reading stands.
 */
export function vantageTagDimensions(
  row: Readonly<Record<string, unknown>>,
  groupBy: readonly string[],
): { readonly dims: VantageTagDims; readonly consumed: boolean } {
  const keys = requestedTagKeys(groupBy);
  if (keys.length === 0) {
    return { dims: {}, consumed: false };
  }
  const raw = row["tags"];
  if (Array.isArray(raw)) {
    const entries = raw.filter((e): e is string => typeof e === "string");
    return { dims: fromTagsArray(entries, keys), consumed: true };
  }
  // The deprecated single-tag shape: `tag` is the first requested key's value; a later requested
  // key has no value in this shape and reads as untagged.
  const single = row["tag"];
  const dims: VantageTagDims = {};
  keys.forEach((key, i) => {
    dims[`${TAG_PREFIX}${key}`] =
      i === 0 && typeof single === "string" && single !== "" ? single : null;
  });
  return { dims, consumed: true };
}
