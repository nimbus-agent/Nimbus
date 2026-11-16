import type { Database } from "bun:sqlite";

import type { GapNote, HistoryLane, HistoryRowView } from "../incident-record-types.ts";
import { gap, HISTORY_CAP, oneLine } from "./caps.ts";

/**
 * History (Phase 10 IC3, design C step 10): the trigger's own `item_history` rows, oldest first, at most 20 with
 * the truncated count, plus where this service's history begins. A key that holds addresses
 * (`assignee_emails`, `resolved_by_email`) is shown as a COUNT or a presence flag, never as the addresses.
 * Times in `item_history` are the sync's observation time unless a `source_at_ms` is present.
 */

export type HistoryResult = { readonly lane: HistoryLane; readonly gaps: readonly GapNote[] };

type Row = {
  key: string;
  old_value: string | null;
  new_value: string | null;
  observed_at_ms: number;
  source_at_ms: number | null;
};

const ADDRESS_KEYS: ReadonlySet<string> = new Set(["assignee_emails", "resolved_by_email"]);

/** A JSON array value reduced to its length; anything else to `set` or `unset`. Never the content. */
function redact(key: string, value: string | null): string | null {
  if (!ADDRESS_KEYS.has(key)) return value === null ? null : oneLine(value);
  if (value === null || value === "") return null;
  try {
    const v: unknown = JSON.parse(value);
    if (Array.isArray(v)) return `${String(v.length)} assigned`;
  } catch {
    // not JSON: fall through to the presence flag
  }
  return "set";
}

export function historyLane(
  db: Database,
  input: {
    readonly itemId: string;
    readonly openedAtMs: number | null;
    readonly historyStartsMs: number | null;
  },
): HistoryResult {
  const total = (
    db.query("SELECT count(*) AS n FROM item_history WHERE item_id = ?").get(input.itemId) as {
      n: number;
    }
  ).n;
  const rows = db
    .query(
      `SELECT key, old_value, new_value, observed_at_ms, source_at_ms FROM item_history
        WHERE item_id = ? ORDER BY observed_at_ms ASC, id ASC LIMIT ?`,
    )
    .all(input.itemId, HISTORY_CAP) as Row[];
  const views: HistoryRowView[] = rows.map((r) => ({
    key: r.key,
    from: redact(r.key, r.old_value),
    to: redact(r.key, r.new_value),
    observedAtMs: r.observed_at_ms,
    sourceAtMs: r.source_at_ms,
  }));
  const gaps: GapNote[] = [];
  if (
    input.openedAtMs !== null &&
    input.historyStartsMs !== null &&
    input.openedAtMs < input.historyStartsMs
  ) {
    gaps.push(
      gap(
        "missing_relation_emit",
        "State changes before this service's history began were not recorded; the first observed state stands in for earlier ones.",
      ),
    );
  }
  return {
    lane: {
      startsMs: input.historyStartsMs,
      total,
      truncated: Math.max(0, total - views.length),
      rows: views,
    },
    gaps,
  };
}
