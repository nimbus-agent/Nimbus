import type { Database } from "bun:sqlite";

import type { AnomalyScoreEvent } from "../watcher/anomaly-detector.ts";
import { clearFinding, openFinding } from "./finding-store.ts";

/**
 * Sync telemetry anomalies as findings (Phase 10 IC8, incident-engine spec § 5.8). The sync detector
 * (`watcher/anomaly-detector.ts`) keeps its rolling z-score and its notifier (`[watcher.anomaly]`, #2017); this
 * module gives it a persisted baseline and a record:
 *
 * - {@link readSyncTelemetrySeed}: the newest `perSeries` error-free rows of `sync_telemetry` per connector, as the
 *   two series the detector watches (`sync:duration_ms:<id>`, `sync:items_upserted:<id>`), oldest first. Read once
 *   at boot, so a restart scores the next sync against the persisted history instead of an empty window.
 * - {@link recordSyncScore}: a sample scored against at least 3 samples opens (at or above `minScore`) or clears
 *   (below it) the series' `anomaly` finding. A finding only: the toast stays the notifier's.
 */

export function readSyncTelemetrySeed(db: Database, perSeries: number): Map<string, number[]> {
  const rows = db
    .query(
      `SELECT service, duration_ms, items_upserted FROM (
         SELECT service, started_at, id, duration_ms, items_upserted,
                ROW_NUMBER() OVER (PARTITION BY service ORDER BY started_at DESC, id DESC) AS rn
           FROM sync_telemetry WHERE error_msg IS NULL)
        WHERE rn <= ? ORDER BY service, started_at, id`,
    )
    .all(perSeries) as { service: string; duration_ms: number; items_upserted: number }[];
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const d = `sync:duration_ms:${r.service}`;
    const u = `sync:items_upserted:${r.service}`;
    if (!out.has(d)) out.set(d, []);
    if (!out.has(u)) out.set(u, []);
    out.get(d)?.push(r.duration_ms);
    out.get(u)?.push(r.items_upserted);
  }
  return out;
}

export function recordSyncScore(db: Database, e: AnomalyScoreEvent, minScore: number): void {
  if (e.samples < 3) return;
  if (e.score >= minScore) {
    openFinding(db, {
      kind: "anomaly",
      key: e.seriesId,
      service: e.seriesId.split(":").slice(2).join(":"),
      detail: {
        value: e.value,
        z: Number.isFinite(e.score) ? Math.round(e.score * 10) / 10 : null,
        samples: e.samples,
        atMs: e.atMs,
      },
      nowMs: e.atMs,
    });
  } else {
    clearFinding(db, "anomaly", e.seriesId, e.atMs);
  }
}
