/**
 * Guards for reading connector-written `item.metadata` JSON.
 *
 * Both functions lived in `standup-time-basis.ts` until `oncall` needed them. Neither has
 * anything to do with a time basis — they are the generic "this string came from a connector and
 * SQLite already lied to me about its type once" pair — and importing a module named for one
 * agent's windowing concept from another agent's queries is the kind of coupling that reads as
 * accidental, so they moved here rather than being called across or copied. `standup-time-basis.ts`
 * re-exports NOTHING: a re-export would leave two import paths for one definition, which is the
 * shape that drifts.
 */

/**
 * A finite number from connector-written JSON, or `null`.
 *
 * Re-checked in TypeScript even when SQL has already compared it: `json_extract` returns whatever
 * the JSON held, and SQLite compares a STRING in a numeric position by its own type ordering
 * rather than numerically — every text value sorts above every number, so a
 * `"2026-09-11T00:00:00Z"` in `merged_at` passes `>= fromMs` for ANY window. The same guard
 * `changelog-event-time.ts` applies, for the same reason.
 */
export function finiteNumberField(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Connector metadata as a plain record, or `null` when it is not a JSON object.
 *
 * An array is rejected as well as a non-object: `json_valid` accepts `[1,2]`, and indexing a key
 * on an array yields `undefined` rather than failing, so without this an array-valued `metadata`
 * would read as "the field is absent" instead of "this row is malformed".
 */
export function metadataRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * A non-empty string from connector-written JSON, or `null`.
 *
 * Empty-string-to-`null` is deliberate and matches what `pagerduty-sync.ts` writes: it omits
 * `severity`/`urgency`/`pagerduty_service_id` entirely when the source value is blank, so a blank
 * arriving by some other route means the same thing — no value — and a renderer printing an empty
 * severity beside a populated one would read as a severity of "".
 */
export function nonEmptyStringField(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * A list of non-empty strings from connector-written JSON — never `null`, always an array.
 *
 * `assignee_emails` is written UNCONDITIONALLY by `pagerduty-sync.ts` (its own comment says an
 * absent key would be indistinguishable from a connector version that never captured actors), so
 * the empty array is the honest representation of "nobody is assigned" and a `null` here would
 * force every caller to re-decide what that means. Non-string members are dropped rather than
 * coerced: a number in an email list is malformed data, and `String(42)` would render as an
 * assignee named "42".
 */
export function stringArrayField(meta: Record<string, unknown>, key: string): readonly string[] {
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is string => typeof e === "string" && e !== "");
}
