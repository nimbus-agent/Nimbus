import type { Database } from "bun:sqlite";

import { collectPrFileCoverage } from "../prfiles/pr-changed-file-store.ts";
import {
  computeLatencyPercentilesMs,
  latencyRingBuffer,
  readLatencyPercentilesFromDb,
} from "./latency-ring-buffer.ts";

export type IndexMetrics = {
  itemCountByService: Record<string, number>;
  totalItems: number;
  indexSizeBytes: number;
  bodyBytes: number;
  ftsIndexBytes: number;
  embeddingCoveragePercent: number;
  lastSuccessfulSyncByConnector: Record<string, Date | null>;
  queryLatencyP50Ms: number;
  queryLatencyP95Ms: number;
  queryLatencyP99Ms: number;
  /** PR changed-file indexing progress. `covered` includes truncated PRs — they were fetched. */
  prFileCoverage: { covered: number; totalPrs: number; truncated: number };
};

function pageStats(db: Database): { bytes: number } {
  const row = db
    .query("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()")
    .get() as { b: number } | null;
  const b = row?.b;
  return { bytes: typeof b === "number" && Number.isFinite(b) ? Math.max(0, Math.floor(b)) : 0 };
}

export function collectIndexMetrics(db: Database): IndexMetrics {
  const byServiceRows = db
    .query("SELECT service, COUNT(*) AS c FROM item GROUP BY service")
    .all() as Array<{ service: string; c: number }> | undefined;
  const itemCountByService: Record<string, number> = {};
  let totalItems = 0;
  for (const r of byServiceRows ?? []) {
    const c = Math.max(0, Math.floor(r.c));
    itemCountByService[r.service] = c;
    totalItems += c;
  }

  const withEmbRow = db
    .query(
      `SELECT COUNT(DISTINCT ec.item_id) AS with_emb
       FROM embedding_chunk ec`,
    )
    .get() as { with_emb: number } | null;
  const withEmb = Math.max(0, Math.floor(withEmbRow?.with_emb ?? 0));
  const embeddingCoveragePercent = totalItems > 0 ? Math.min(100, (withEmb * 100) / totalItems) : 0;

  const syncRows = db.query("SELECT connector_id, last_sync_at FROM sync_state").all() as
    | Array<{ connector_id: string; last_sync_at: number | null }>
    | undefined;
  const lastSuccessfulSyncByConnector: Record<string, Date | null> = {};
  for (const r of syncRows ?? []) {
    const t = r.last_sync_at;
    lastSuccessfulSyncByConnector[r.connector_id] =
      typeof t === "number" && Number.isFinite(t) ? new Date(t) : null;
  }

  const inMem = latencyRingBuffer.snapshotOrdered();
  const lat =
    inMem.length > 0 ? computeLatencyPercentilesMs(inMem) : readLatencyPercentilesFromDb(db);

  const { bytes } = pageStats(db);

  // NOT dbstat: bun:sqlite is not built with SQLITE_ENABLE_DBSTAT_VTAB, so
  // `dbstat` raises "no such table". The FTS5 shadow tables are ordinary
  // tables and can be summed directly, which needs no build flag.
  //
  // `length(body)` on a TEXT value returns the CHARACTER count, not the
  // UTF-8 byte count (e.g. "日本語" has length 3 but is 9 bytes) — casting
  // to BLOB makes length() return the actual byte size, which is what this
  // counter exists to report (on-disk growth after the 16 KiB body cap).
  const bodyRow = db
    .query("SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS b FROM item")
    .get() as {
    b: number;
  } | null;
  const bodyBytes = Math.max(0, Math.floor(bodyRow?.b ?? 0));

  let ftsIndexBytes = 0;
  try {
    const ftsRow = db
      .query("SELECT COALESCE(SUM(length(block)), 0) AS b FROM item_fts_data")
      .get() as { b: number } | null;
    ftsIndexBytes = Math.max(0, Math.floor(ftsRow?.b ?? 0));
  } catch {
    /* item_fts absent on a partially-migrated database */
  }

  const prFileCoverage = collectPrFileCoverage(db);

  return {
    itemCountByService,
    totalItems,
    indexSizeBytes: bytes,
    bodyBytes,
    ftsIndexBytes,
    embeddingCoveragePercent,
    lastSuccessfulSyncByConnector,
    queryLatencyP50Ms: lat.p50Ms,
    queryLatencyP95Ms: lat.p95Ms,
    queryLatencyP99Ms: lat.p99Ms,
    prFileCoverage,
  };
}
