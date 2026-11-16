import type { Database } from "bun:sqlite";
import { affectedServicesForEpics, groupIdsByTracker } from "./epic-services.ts";
import type { EpicTracker } from "./epic-tracker.ts";

export type CohortCandidate = {
  itemId: string;
  key: string;
  title: string;
  services: string[];
  /** Null when the sync never recorded one — cycle time skips these; see Task 1 Step 3. */
  createdAtMs: number | null;
  resolvedAtMs: number;
  statusCategory: "done" | "canceled";
  childCount: number;
  score: number;
};

export type CohortResult = {
  members: CohortCandidate[];
  scannedCount: number;
  oldestResolvedAtMs: number | null;
};

type CandidateRow = {
  id: string;
  display_key: string;
  title: string;
  created_at_ms: number | null;
  resolved_at_ms: number;
  status_category: "done" | "canceled";
};

type ChildCountRow = {
  epicItemId: string;
  childCount: number;
};

/**
 * Total child count per epic: every item the epic's own tracker says is its child
 * (`tracker.childOfSql`, which reads `epic.external_id` from the epic ROW, never a caller-supplied
 * key) and whose `service` matches the epic's own, regardless of whether that child ever resolved to
 * a service. This is a scope-size signal for later risk scoring, not a re-derivation of `services`:
 * an epic can have children that never shipped a PR, and those still count here.
 *
 * Serves both the cohort members and the single TARGET (`agents/premortem.ts` calls it with
 * `[epic.itemId]`). Ids are grouped by `item.service` first, so each tracker's join fragment runs
 * against its own rows only; an id whose service has no descriptor is absent from the map.
 */
export function childCountsFor(db: Database, epicItemIds: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (epicItemIds.length === 0) {
    return result;
  }
  const idsByTracker = groupIdsByTracker(db, epicItemIds);
  for (const [tracker, ids] of idsByTracker) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT epic.id AS epicItemId, COUNT(*) AS childCount
           FROM item epic
           JOIN item child ON json_valid(child.metadata)
                            AND ${tracker.childOfSql("child", "epic")}
                            AND child.service = epic.service
                            AND child.id <> epic.id
          WHERE epic.id IN (${placeholders})
          GROUP BY epic.id`,
      )
      .all(...ids) as ChildCountRow[];
    for (const r of rows) {
      result.set(r.epicItemId, r.childCount);
    }
  }
  return result;
}

/** Refuses an `excludeItemId` that belongs to a different tracker: the caller must not blend them. */
function assertExcludedItemBelongsTo(db: Database, itemId: string, tracker: EpicTracker): void {
  const row = db.query("SELECT service FROM item WHERE id = ?").get(itemId) as {
    service: string;
  } | null;
  if (row !== null && row.service !== tracker.service) {
    throw new Error(
      `selectCohort: the excluded item belongs to "${row.service}", not to the "${tracker.service}" cohort`,
    );
  }
}

/**
 * Selects and ranks the cohort of closed epics (of ONE tracker) comparable to a target epic, by
 * service overlap.
 *
 * `tracker` is REQUIRED, never defaulted: a default would let a Linear target silently use the Jira
 * cohort, the exact blend this file forbids. `tracker.isEpicSql` carries its own `service = '<id>'`
 * clause, and THAT is the structural guarantee behind `cohortIsMixedTracker: false` in
 * `agents/premortem.ts` (Jira and Linear do not agree on what a canceled status means, so a blended
 * abandonment rate would not be comparable): the candidate statement can only ever return rows of one
 * tracker, tested for both. `excludeItemId` is derived, not trusted: when it names an existing row of
 * another tracker the call throws.
 *
 * Candidates are scanned `resolved_at_ms DESC` so `maxCandidateScan` truncates
 * the OLDEST history, never an arbitrary slice. `resolved_at_ms` is read out
 * of `metadata` via `json_extract` — it is not a real `item` column, only
 * the tracker's writers set it, and a candidate whose sync never
 * recorded one is excluded rather than guessed at (see the `IS NOT NULL`
 * filter below): it is the ordering key, and the scan cap's whole meaning is
 * undefined without it.
 *
 * Each scanned candidate's services come from `affectedServicesForEpics`
 * (the single definition of "service" for pre-mortem). A candidate survives
 * only if it shares AT LEAST ONE service with `targetServices` — the overlap
 * gate, applied BEFORE scoring. Without it, a candidate sharing only a
 * service that touches every scanned candidate (IDF weight ~0) is
 * indistinguishable from a candidate sharing nothing, and a wholly unrelated
 * but recent epic could enter the cohort on recency alone.
 *
 * Each surviving candidate scores the sum, over services it shares with the
 * target, of `log(N / epicsTouchingService)` — computed across the whole
 * SCANNED set (not just the gated survivors), so a ubiquitous service's
 * near-zero weight reflects the true candidate pool. No smoothing constant:
 * a zero score after the gate is an honest tie, not a bug to hide.
 */
// lane-census: scope=issue service=jira
export function selectCohort(
  db: Database,
  targetServices: readonly string[],
  opts: {
    tracker: EpicTracker;
    maxCandidateScan: number;
    maxCohortSize: number;
    excludeItemId: string;
  },
): CohortResult {
  assertExcludedItemBelongsTo(db, opts.excludeItemId, opts.tracker);
  const { tracker } = opts;
  const rows = db
    .query(
      `SELECT id,
              ${tracker.displayKeySql("item")} AS display_key,
              title,
              json_extract(metadata, '$.created_at_ms')   AS created_at_ms,
              json_extract(metadata, '$.resolved_at_ms')  AS resolved_at_ms,
              json_extract(metadata, '$.status_category') AS status_category
         FROM item
        WHERE ${tracker.isEpicSql("item")}
          AND json_valid(metadata)
          AND json_extract(metadata, '$.status_category') IN ('done', 'canceled')
          AND json_extract(metadata, '$.resolved_at_ms') IS NOT NULL
          AND id <> ?
        ORDER BY json_extract(metadata, '$.resolved_at_ms') DESC
        LIMIT ?`,
    )
    .all(opts.excludeItemId, opts.maxCandidateScan) as CandidateRow[];

  const scannedCount = rows.length;

  if (scannedCount === 0) {
    return { members: [], scannedCount: 0, oldestResolvedAtMs: null };
  }

  const servicesByEpic = affectedServicesForEpics(
    db,
    rows.map((r) => r.id),
  );

  // Document frequency, over the FULL scanned set — a service that touches
  // every candidate must earn a near-zero weight, which requires N and df
  // to both come from the same (scanned, not gated) population.
  const N = scannedCount;
  const documentFrequency = new Map<string, number>();
  for (const row of rows) {
    const services = servicesByEpic.get(row.id) ?? [];
    for (const service of services) {
      documentFrequency.set(service, (documentFrequency.get(service) ?? 0) + 1);
    }
  }
  const idfWeight = (service: string): number => {
    const df = documentFrequency.get(service);
    return df === undefined || df === 0 ? 0 : Math.log(N / df);
  };

  const targetSet = new Set(targetServices);

  const scored: Array<{ row: CandidateRow; services: string[]; score: number }> = [];
  for (const row of rows) {
    const services = servicesByEpic.get(row.id) ?? [];
    const shared = services.filter((service) => targetSet.has(service));
    if (shared.length === 0) {
      // The overlap gate — load-bearing. Applied before scoring.
      continue;
    }
    const score = shared.reduce((sum, service) => sum + idfWeight(service), 0);
    scored.push({ row, services, score });
  }

  // The honesty note's history span: the oldest resolution date among
  // candidates that actually survived the overlap gate (the real
  // comparable-candidate pool), computed BEFORE the `maxCohortSize` slice —
  // never from the raw SQL scan, which can include candidates sharing zero
  // services with the target and never entering the cohort at all.
  const oldestResolvedAtMs =
    scored.length === 0 ? null : Math.min(...scored.map((s) => s.row.resolved_at_ms));

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.row.resolved_at_ms - a.row.resolved_at_ms;
  });

  const sliced = scored.slice(0, opts.maxCohortSize);
  const childCounts = childCountsFor(
    db,
    sliced.map((s) => s.row.id),
  );

  const members: CohortCandidate[] = sliced.map(({ row, services, score }) => ({
    itemId: row.id,
    key: row.display_key,
    title: row.title,
    services,
    createdAtMs: row.created_at_ms,
    resolvedAtMs: row.resolved_at_ms,
    statusCategory: row.status_category,
    childCount: childCounts.get(row.id) ?? 0,
    score,
  }));

  return { members, scannedCount, oldestResolvedAtMs };
}
