/**
 * Where a standup entry's timestamp CAME FROM, and therefore whether the entry can be
 * misplaced in time.
 *
 * `nimbus changelog` carries a two-valued `timeSource: "event" | "index"` for the same job, and
 * two values are not enough here. Standup's window is 24 hours by default rather than a week, so
 * the question "could this entry be in the wrong window?" is the difference between a useful
 * standup and a wrong one — and standup reads two lanes (`review`, `message`) whose timestamp
 * lives in the `modified_at` COLUMN yet is nonetheless the real event instant, because those
 * rows are written once per event and never updated. Folding them in with `pr`/`incident` under
 * one `"index"` label would state a caveat that does not apply to them; folding them in with
 * `merged_at` under `"event"` would claim a dedicated event field they do not have.
 *
 * Three values, each a distinct factual claim:
 *
 * - `event_field` — a dedicated event timestamp in connector metadata (`metadata.merged_at`,
 *   `metadata.created_at_ms`). Cannot be misplaced.
 * - `event_column` — `item.modified_at` on a row the connector writes ONCE PER EVENT and never
 *   updates, from that event's own timestamp. Cannot be misplaced in practice; see the narrow
 *   fallback named below, which is what keeps this from being `event_field`.
 * - `last_touch` — `item.modified_at` on a MUTABLE row, where the column means "when the index
 *   last wrote this row" and nothing more. CAN be misplaced, and is the one the disclosure warns
 *   about.
 *
 * **`item.modified_at` is "last touched", not "when it happened."** `connectors/github-sync.ts`
 * says so directly, in a comment about PR stats going stale when an event bumps the column. A
 * `pr` row's `modified_at` is GitHub's `updated_at` (`modifiedMsFromGithubTimestamps`), so a pull
 * request opened in June that received one comment yesterday has `modified_at` = yesterday.
 *
 * **Why `review` and `message` are genuinely different, and the exception that stops them being
 * `event_field`:**
 *
 * - A `review` row is keyed `<repo>#<pr>#<reviewId>` — one row per review — and
 *   `github-sync.ts` sets `modifiedAt` from the review's own `submitted_at`. Re-syncing recomputes
 *   the same value. **The exception:** when `submitted_at` is absent from the API payload that
 *   line falls back to the sync clock (`submitted === undefined ? now : Date.parse(submitted)`),
 *   and the row carries no `submitted_at` in metadata, so a consumer cannot tell the two apart
 *   afterwards. That is unobservable here and is why this is not `event_field`; it is named in
 *   the brief's own basis disclosure rather than left to the reader to discover.
 * - A `message` row is keyed `<channel>:<ts>` and `slack-sync.ts` sets `modifiedAt` to
 *   `round(parseFloat(ts) * 1000)` — the post instant itself, from the key. Its fallback is the
 *   same shape (an unparseable `ts`), and a `ts` that does not parse also fails the `typeof ts
 *   !== "string"` guard above it in almost every case.
 */
export type StandupTimeBasis = "event_field" | "event_column" | "last_touch";

/**
 * Whether an entry on this basis can sit in the wrong window.
 *
 * The ONE definition of that predicate. `standup.ts` counts rows with it for the brief's
 * `approximateCount`, and `brief-disclosures.ts` decides whether to emit the basis disclosure
 * from that count — so the number the reader sees and the sentence explaining it cannot disagree
 * about which entries are meant.
 */
export function basisCanBeMisplaced(basis: StandupTimeBasis): boolean {
  return basis === "last_touch";
}

/**
 * A finite number from connector-written JSON, or `null`.
 *
 * Re-checked in TypeScript even though the SQL already compared it: `json_extract` returns
 * whatever the JSON held, and SQLite would compare a STRING in this position by its own type
 * ordering rather than numerically — every text value sorts above every number, so a
 * `"2026-09-11T00:00:00Z"` in `merged_at` would pass `>= fromMs` for any window. The same guard
 * `changelog-event-time.ts` applies, for the same reason.
 */
export function finiteNumberField(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Connector metadata as a plain record, or `null` when it is not a JSON object.
 *
 * An array is rejected as well as a non-object: `json_valid` accepts `[1,2]`, and indexing a
 * key on an array yields `undefined` rather than failing, so without this an array-valued
 * `metadata` would read as "the field is absent" instead of "this row is malformed".
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
