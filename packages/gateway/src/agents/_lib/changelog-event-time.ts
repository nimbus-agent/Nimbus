/**
 * Per-category event time, and whether it is a real event timestamp or the index's own
 * last-touch column.
 *
 * `item.modified_at` is "last touched", NOT "when it happened" — `connectors/github-sync.ts`
 * says so in a comment about stats going stale when an event bumps it. A PR merged in June
 * that received a comment yesterday has `modified_at` = yesterday, so a changelog keyed on
 * that column reports what MOVED IN THE INDEX rather than what HAPPENED.
 */
export type ChangelogCategory =
  | "merged_pr"
  | "deployment"
  | "incident_opened"
  | "incident_resolved";

/** `source: "index"` means the time came from `item.modified_at`, not an event field. */
export type EventTime = { readonly atMs: number; readonly source: "event" | "index" };

type Extractor = (meta: Record<string, unknown>, modifiedAt: number) => EventTime | null;

function numberField(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  // Re-checked here rather than trusted from SQL: this is connector-written metadata, and a
  // string in this position would compare by SQLite's type ordering rather than numerically.
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function eventField(key: string): Extractor {
  return (meta) => {
    const at = numberField(meta, key);
    return at === null ? null : { atMs: at, source: "event" };
  };
}

/**
 * `modified_at` is the event time for these two, and that is not a degradation this design
 * chose: `metrics/dora.ts` uses exactly the same basis and ships it, noting that for a
 * resolved incident `modified_at` is effectively resolution time.
 */
const fromIndex: Extractor = (_meta, modifiedAt) => ({ atMs: modifiedAt, source: "index" });

/**
 * Checks the status itself rather than trusting the caller's `WHERE` clause.
 *
 * The SQL does filter on `$.status`, so this is defence in depth — but a pure function that
 * ignores the only field distinguishing a resolved incident from an open one is also a
 * function whose unit test cannot fail in the direction that matters.
 */
const incidentResolved: Extractor = (meta, modifiedAt) =>
  meta["status"] === "resolved" ? { atMs: modifiedAt, source: "index" } : null;

const EVENT_TIME = {
  // Absence is a FILTER, not a fallback: github-sync.ts writes merged_at only on a merged PR,
  // so a missing value means "not merged" and the row leaves the category entirely.
  merged_pr: eventField("merged_at"),
  deployment: fromIndex,
  incident_opened: eventField("opened_at_ms"),
  incident_resolved: incidentResolved,
} satisfies Readonly<Record<ChangelogCategory, Extractor>>;

export function eventTimeFor(
  category: ChangelogCategory,
  meta: unknown,
  modifiedAt: number,
): EventTime | null {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  return EVENT_TIME[category](meta as Record<string, unknown>, modifiedAt);
}
