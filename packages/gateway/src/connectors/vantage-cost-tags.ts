/**
 * The value of each `tag:<key>` grouping of a Vantage `GET /v2/costs` row.
 *
 * Shape verified against one live account's reply (2026-11-25, groupings
 * `provider,service,tag:owner,tag:repo`, `date_bin=day`):
 * - `tags` is an array of `"<key>:<value>"` strings, one per tag grouping, in the order the
 *   groupings were requested: `["owner:acme", "repo:web"]`.
 * - A row without that tag carries `"<key>:"` (an empty value) and no `tag` field.
 * - `tag` (a string) is the value of the FIRST tag grouping only; the published OpenAPI file marks
 *   it deprecated ("does not support multiple tags"). It is read only when `tags` is absent.
 *
 * A tag key can itself hold a colon (`aws:cloudformation:stack-name`), so a requested key is matched
 * by its own `<key>:` prefix, never by splitting on the first colon. Only an entry no requested key
 * claims (a saved report's own tag groupings, which this gateway does not know) is split at its
 * first colon; that is a stated bound.
 */

/** The value of a `tag:<key>` grouping on a row that does not carry that tag. */
export const VANTAGE_UNTAGGED = "__untagged__";

const TAG_PREFIX = "tag:";

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

function valueOrUntagged(v: string): string {
  return v === "" ? VANTAGE_UNTAGGED : v;
}

/** `tags` entries claimed by the requested keys, positionally first, then by prefix anywhere. */
function claimRequested(
  entries: readonly string[],
  keys: readonly string[],
  out: Record<string, string>,
): Set<number> {
  const used = new Set<number>();
  keys.forEach((key, position) => {
    const prefix = `${key}:`;
    let at = -1;
    const positional = entries[position];
    if (!used.has(position) && positional?.startsWith(prefix) === true) {
      at = position;
    } else {
      at = entries.findIndex((e, i) => !used.has(i) && e.startsWith(prefix));
    }
    if (at >= 0) used.add(at);
    // A requested tag missing from the row entirely is the same fact as `"<key>:"`: untagged.
    out[`${TAG_PREFIX}${key}`] =
      at >= 0 ? valueOrUntagged(entries[at]?.slice(prefix.length) ?? "") : VANTAGE_UNTAGGED;
  });
  return used;
}

/**
 * The tag dimensions of one row, as `{ "tag:<key>": value }`, and whether the row's own `tag` and
 * `tags` fields were consumed (so the caller drops them rather than read `tag` as a dimension).
 */
export function vantageTagDimensions(
  row: Readonly<Record<string, unknown>>,
  groupBy: readonly string[],
): { readonly dims: Record<string, string>; readonly consumed: boolean } {
  const keys = requestedTagKeys(groupBy);
  const dims: Record<string, string> = {};
  const raw = row["tags"];
  if (Array.isArray(raw)) {
    const entries = raw.filter((e): e is string => typeof e === "string");
    const used = claimRequested(entries, keys, dims);
    entries.forEach((entry, i) => {
      if (used.has(i)) return;
      const colon = entry.indexOf(":");
      if (colon <= 0) return;
      const name = `${TAG_PREFIX}${entry.slice(0, colon)}`;
      if (dims[name] === undefined) dims[name] = valueOrUntagged(entry.slice(colon + 1));
    });
    return { dims, consumed: true };
  }
  const single = row["tag"];
  const firstKey = keys[0];
  if (
    firstKey !== undefined &&
    (typeof single === "string" || single === undefined || single === null)
  ) {
    // The deprecated single-tag shape: `tag` is the first tag grouping's value; a later requested
    // key has no value in this shape and reads as untagged.
    keys.forEach((key, i) => {
      const v = i === 0 && typeof single === "string" ? single : "";
      dims[`${TAG_PREFIX}${key}`] = valueOrUntagged(v);
    });
    return { dims, consumed: true };
  }
  return { dims, consumed: false };
}
