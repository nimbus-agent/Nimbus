import type { Database } from "bun:sqlite";
import { notEmbeddingExcludedSql } from "../embedding/embedding-exclusions.ts";

/**
 * Index quality report behind `nimbus index health` — why query results are weak, before the user
 * concludes the product is.
 *
 * Deliberately separate from `collectIndexMetrics` in `metrics.ts`, which answers "how big is the
 * index" for `diag.snapshot` and the Prometheus surface. This answers "how good is it", and the two
 * have different denominators: `metrics.ts` reports ONE global embedding-coverage number, which is
 * correct for a gauge and useless for triage, since it cannot say WHICH connector is uncovered.
 *
 * **What the v0.1.1 spec got wrong, corrected here rather than reproduced.** The roadmap row named
 * `url`, `modified_at` and `raw_meta` as the sparse-metadata fields. `raw_meta` is a column of the
 * LEGACY `items` table (`index/schema-sql.ts`); the live table is `item` (`index/unified-item-v3-sql.ts`)
 * and its equivalent is `metadata` — `raw_meta` survives only as a `legacy_raw_meta` key inside that
 * JSON, written once by the V3 backfill. And `item.modified_at` is `NOT NULL`, so it can never be
 * missing in the NULL sense; `index/item-store.ts` writes `modifiedAt ?? createdAt ?? 0`, so the
 * detectable signal is the sentinel `0`. Both corrections are asserted in `index-health.test.ts`.
 */

/** Weights for the two halves of the confidence score. They MUST sum to 1 — pinned by a test. */
export const COVERAGE_WEIGHT = 0.6;
export const FRESHNESS_WEIGHT = 0.4;

/**
 * Coverage is weighted higher than freshness because they fail differently. An unembedded item is
 * invisible to semantic search — it cannot be retrieved at all. A stale item is still retrievable,
 * just potentially out of date. Being absent is worse than being old.
 */
export const DEFAULT_STALE_THRESHOLD_DAYS = 7;

/** Below this, `nimbus doctor` prints a warning. */
export const LOW_CONFIDENCE_THRESHOLD = 60;

const DAY_MS = 86_400_000;

export type StaleReason = "never_synced" | "no_sync_record" | "threshold_exceeded";

export interface ConnectorIndexHealth {
  readonly service: string;
  readonly items: number;
  readonly embeddedItems: number;
  readonly embeddingCoveragePercent: number;
  readonly lastSyncMs: number | null;
  readonly staleDays: number | null;
  readonly stale: boolean;
  /** Why it is stale. `null` when it is not. */
  readonly staleReason: StaleReason | null;
}

export interface SparseTypeHealth {
  readonly type: string;
  readonly items: number;
  /** Items missing AT LEAST ONE field — never the sum of the three columns below. */
  readonly sparseItems: number;
  readonly missingUrl: number;
  readonly missingModifiedAt: number;
  readonly missingMetadata: number;
  readonly sparsePercent: number;
}

export interface IndexHealth {
  readonly totalItems: number;
  readonly embeddingCoveragePercent: number;
  readonly connectors: readonly ConnectorIndexHealth[];
  readonly sparseTypes: readonly SparseTypeHealth[];
  /** `null` when there is nothing to judge — see `confidenceUnavailableReason`. */
  readonly confidence: number | null;
  readonly confidenceUnavailableReason: "empty_index" | null;
  readonly confidenceInputs: {
    readonly embeddingCoveragePercent: number;
    readonly freshItemPercent: number;
    readonly coverageWeight: number;
    readonly freshnessWeight: number;
  };
  readonly staleThresholdDays: number;
  readonly generatedAtMs: number;
}

export interface IndexHealthOptions {
  readonly nowMs?: number;
  readonly staleThresholdDays?: number;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

interface ItemRow {
  service: string;
  items: number;
  embedded: number;
}

function readPerService(db: Database): ItemRow[] {
  // LEFT JOIN over a DISTINCT item_id subquery rather than a JOIN over `embedding_chunk` directly:
  // an item with N chunks must count ONCE, and a plain join would multiply its row.
  const rows = db
    .query(
      `SELECT i.service AS service,
              COUNT(*) AS items,
              SUM(CASE WHEN e.item_id IS NULL THEN 0 ELSE 1 END) AS embedded
       FROM item i
       LEFT JOIN (SELECT DISTINCT item_id FROM embedding_chunk) e ON e.item_id = i.id
       WHERE ${notEmbeddingExcludedSql("i")}
       GROUP BY i.service`,
    )
    .all() as Array<{ service: string; items: number; embedded: number }> | undefined;
  return (rows ?? []).map((r) => ({
    service: r.service,
    items: Math.max(0, Math.floor(r.items)),
    embedded: Math.max(0, Math.floor(r.embedded ?? 0)),
  }));
}

function readSyncTimes(db: Database): Map<string, number | null> {
  const rows = db.query("SELECT connector_id, last_sync_at FROM sync_state").all() as
    | Array<{ connector_id: string; last_sync_at: number | null }>
    | undefined;
  const out = new Map<string, number | null>();
  for (const r of rows ?? []) {
    const t = r.last_sync_at;
    out.set(r.connector_id, typeof t === "number" && Number.isFinite(t) ? t : null);
  }
  return out;
}

function classifyStaleness(
  lastSyncMs: number | null,
  hasSyncRow: boolean,
  nowMs: number,
  thresholdDays: number,
): { staleDays: number | null; stale: boolean; staleReason: StaleReason | null } {
  // Fail-closed on both unknowns. An absent sync record is not evidence of freshness, and treating
  // it as fresh would inflate the single number the user acts on.
  if (!hasSyncRow) return { staleDays: null, stale: true, staleReason: "no_sync_record" };
  if (lastSyncMs === null) return { staleDays: null, stale: true, staleReason: "never_synced" };
  // Compare the RAW age; round only what is displayed. Rounding first meant an age of 7.04 days
  // became 7.0, and `7.0 > 7` is false — a connector genuinely past a 7-day threshold reported
  // fresh. `>` not `>=` is deliberate: "stale after 7 days" must not fire at exactly 7.
  const rawDays = Math.max(0, (nowMs - lastSyncMs) / DAY_MS);
  const stale = rawDays > thresholdDays;
  const staleDays = Math.round(rawDays * 10) / 10;
  return { staleDays, stale, staleReason: stale ? "threshold_exceeded" : null };
}

function readSparseTypes(db: Database): SparseTypeHealth[] {
  // FinOps cost rows (finops/cost-item-contract.ts) carry no URL by design; they are not a sparse type.
  // `metadata = ''` counts alongside NULL: a connector that wrote an empty string supplied no
  // metadata either, and the user cannot act on the difference.
  const rows = db
    .query(
      `SELECT type,
              COUNT(*)                                              AS items,
              SUM(CASE WHEN url IS NULL OR url = '' THEN 1 ELSE 0 END)            AS missing_url,
              SUM(CASE WHEN modified_at = 0 THEN 1 ELSE 0 END)                    AS missing_modified,
              SUM(CASE WHEN metadata IS NULL OR metadata = '' THEN 1 ELSE 0 END)  AS missing_meta,
              SUM(CASE WHEN url IS NULL OR url = ''
                         OR modified_at = 0
                         OR metadata IS NULL OR metadata = '' THEN 1 ELSE 0 END)  AS sparse_items
       FROM item
       WHERE type NOT IN ('cost_allocation', 'cost_recommendation')
       GROUP BY type`,
    )
    .all() as
    | Array<{
        type: string;
        items: number;
        missing_url: number;
        missing_modified: number;
        missing_meta: number;
        sparse_items: number;
      }>
    | undefined;

  const out: SparseTypeHealth[] = [];
  for (const r of rows ?? []) {
    const sparseItems = Math.max(0, Math.floor(r.sparse_items ?? 0));
    if (sparseItems === 0) continue;
    const items = Math.max(0, Math.floor(r.items));
    out.push({
      type: r.type,
      items,
      sparseItems,
      missingUrl: Math.max(0, Math.floor(r.missing_url ?? 0)),
      missingModifiedAt: Math.max(0, Math.floor(r.missing_modified ?? 0)),
      missingMetadata: Math.max(0, Math.floor(r.missing_meta ?? 0)),
      sparsePercent: pct(sparseItems, items),
    });
  }
  out.sort((a, b) => b.sparseItems - a.sparseItems || a.type.localeCompare(b.type));
  return out;
}

export function collectIndexHealth(db: Database, opts: IndexHealthOptions = {}): IndexHealth {
  const nowMs = opts.nowMs ?? Date.now();
  const staleThresholdDays = opts.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;

  const perService = readPerService(db);
  const syncTimes = readSyncTimes(db);

  // Every service that has items OR a sync row — a connector authenticated but not yet synced is
  // worth showing, and one holding items with no sync row is the case that must not be hidden.
  const services = new Set<string>([...perService.map((r) => r.service), ...syncTimes.keys()]);
  const byService = new Map(perService.map((r) => [r.service, r]));

  let totalItems = 0;
  let embeddedItems = 0;
  let freshItems = 0;
  const connectors: ConnectorIndexHealth[] = [];

  for (const service of services) {
    const row = byService.get(service);
    const items = row?.items ?? 0;
    const embedded = row?.embedded ?? 0;
    const hasSyncRow = syncTimes.has(service);
    const lastSyncMs = syncTimes.get(service) ?? null;
    const { staleDays, stale, staleReason } = classifyStaleness(
      lastSyncMs,
      hasSyncRow,
      nowMs,
      staleThresholdDays,
    );

    totalItems += items;
    embeddedItems += embedded;
    if (!stale) freshItems += items;

    connectors.push({
      service,
      items,
      embeddedItems: embedded,
      embeddingCoveragePercent: pct(embedded, items),
      lastSyncMs,
      staleDays,
      stale,
      staleReason,
    });
  }

  connectors.sort((a, b) => b.items - a.items || a.service.localeCompare(b.service));

  const embeddingCoveragePercent = pct(embeddedItems, totalItems);
  const freshItemPercent = pct(freshItems, totalItems);

  // An empty index gets `null`, not 0. Zero would read as a verdict on quality when the honest
  // answer is that there is nothing to have a verdict about — and `nimbus doctor` keys its message
  // off this null rather than off a low score.
  const confidence =
    totalItems === 0
      ? null
      : Math.round(
          COVERAGE_WEIGHT * embeddingCoveragePercent + FRESHNESS_WEIGHT * freshItemPercent,
        );

  return {
    totalItems,
    embeddingCoveragePercent,
    connectors,
    sparseTypes: readSparseTypes(db),
    confidence,
    confidenceUnavailableReason: totalItems === 0 ? "empty_index" : null,
    confidenceInputs: {
      embeddingCoveragePercent,
      freshItemPercent,
      coverageWeight: COVERAGE_WEIGHT,
      freshnessWeight: FRESHNESS_WEIGHT,
    },
    staleThresholdDays,
    generatedAtMs: nowMs,
  };
}
