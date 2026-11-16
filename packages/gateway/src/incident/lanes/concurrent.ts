import type { Database } from "bun:sqlite";

import type { ConcurrentLane, ConcurrentView, GapNote } from "../incident-record-types.ts";
import { CONCURRENT_CAP, CONCURRENT_WINDOW_MS, codeUnitCompare, gap } from "./caps.ts";

/**
 * Lane 5, concurrent records (Phase 10 IC3, design C step 7): OTHER services' open records that opened within
 * 30 minutes either side of this one (the spec's cascade window), read from `incident_record`, so only
 * assembled records are visible. A record bound to the same service is not concurrent; an unbound record is
 * (it belongs to no service this one could share). The trigger's own record is excluded.
 */

export type ConcurrentResult = { readonly lane: ConcurrentLane; readonly gaps: readonly GapNote[] };

type Row = {
  id: string;
  trigger_item_id: string;
  trigger_service: string;
  severity: string | null;
  service: string | null;
  opened_at_ms: number;
};

export function skippedConcurrent(): ConcurrentResult {
  return { lane: { skipped: "no_open_time", total: 0, records: [] }, gaps: [] };
}

export function concurrentLane(
  db: Database,
  input: {
    readonly triggerItemId: string;
    readonly boundService: string | null;
    readonly openedAtMs: number;
  },
): ConcurrentResult {
  const from = input.openedAtMs - CONCURRENT_WINDOW_MS;
  const to = input.openedAtMs + CONCURRENT_WINDOW_MS;
  const where = `status = 'open' AND opened_at_ms BETWEEN ? AND ? AND trigger_item_id <> ?
    AND (service IS NULL OR service IS NOT ?)`;
  const params = [from, to, input.triggerItemId, input.boundService];
  const total = (
    db.query(`SELECT count(*) AS n FROM incident_record WHERE ${where}`).get(...params) as {
      n: number;
    }
  ).n;
  const rows = db
    .query(
      `SELECT id, trigger_item_id, trigger_service, severity, service, opened_at_ms
         FROM incident_record WHERE ${where}
        ORDER BY opened_at_ms DESC, id ASC LIMIT ?`,
    )
    .all(...params, CONCURRENT_CAP) as Row[];
  const records: ConcurrentView[] = rows
    .map((r) => ({
      recordId: r.id,
      triggerItemId: r.trigger_item_id,
      source: r.trigger_service,
      severity: r.severity,
      service: r.service,
      openedAtMs: r.opened_at_ms,
      rule: "concurrent_30m" as const,
    }))
    .sort((a, b) =>
      a.openedAtMs === b.openedAtMs
        ? codeUnitCompare(a.recordId, b.recordId)
        : b.openedAtMs - a.openedAtMs,
    );
  return {
    lane: { skipped: null, total, records },
    gaps: [
      gap(
        "missing_relation_emit",
        "Only incident records already assembled are listed here; an alert whose record is not assembled yet is absent until the next pass.",
      ),
    ],
  };
}
