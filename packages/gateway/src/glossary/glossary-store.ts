import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { glossarySourceFilter } from "./glossary-source-types.ts";
import type {
  CandidateForm,
  DefinitionSource,
  GlossarySource,
  GlossaryStatus,
  GlossaryTerm,
  TermStats,
} from "./glossary-types.ts";

const TOP_SOURCE_LIMIT = 5;

type Row = {
  term_key: string;
  display_term: string;
  status: string;
  definition: string | null;
  definition_source: string | null;
  doc_freq: number;
  service_spread: number;
  score: number;
  form: string;
  first_seen_at: number;
  last_seen_at: number;
  top_sources: string;
  synonyms: string;
  near_misses: string;
  consolidated_at: number | null;
  stats_verified_at: number;
  updated_at: number;
};

function parseJsonArray<T>(raw: string): T[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function toTerm(r: Row): GlossaryTerm {
  return {
    termKey: r.term_key,
    displayTerm: r.display_term,
    status: r.status as GlossaryStatus,
    definition: r.definition,
    definitionSource: r.definition_source as DefinitionSource | null,
    docFreq: r.doc_freq,
    serviceSpread: r.service_spread,
    score: r.score,
    form: r.form as CandidateForm,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    topSources: parseJsonArray<GlossarySource>(r.top_sources),
    synonyms: parseJsonArray<string>(r.synonyms),
    nearMisses: parseJsonArray<string>(r.near_misses),
    consolidatedAt: r.consolidated_at,
    statsVerifiedAt: r.stats_verified_at,
    updatedAt: r.updated_at,
  };
}

/**
 * FTS MATCH needs the key quoted so a multi-word term is a phrase, not an AND.
 *
 * KNOWN LIMIT — the default unicode61 tokenizer treats `-` and `_` as
 * separators, so `"write-behind"` is really the PHRASE `write behind` and also
 * matches unhyphenated prose ("we write behind the scenes"). Measured, not
 * assumed: that query returns 2 rows against a 3-row corpus. Hyphenated and
 * underscored terms can therefore over-count slightly, and in the worst case a
 * non-term clears `min_doc_freq` on adjacent-word coincidences.
 *
 * Accepted rather than fixed: the alternative is re-scanning candidate bodies
 * for the exact surface form, which trades the whole point of using the FTS
 * index for a small accuracy gain on two of five families. The test suite
 * asserts the ACTUAL behaviour so nobody "fixes" it into a false ideal.
 */
function ftsQuery(termKey: string): string {
  return `"${termKey.replace(/"/g, '""')}"`;
}

/**
 * FTS5 raises on malformed query syntax, and term keys derive from arbitrary
 * indexed content. One bad key must not abort a whole extraction pass, so a
 * failed match degrades to "no evidence" — the term simply falls below the
 * frequency floor and is skipped.
 */
function safeFtsGet<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

/**
 * The spec-§5.1 recompute. Statistics are ALWAYS derived from the live FTS
 * index — never accumulated — so the result is idempotent under re-runs,
 * edits and deletions.
 */
export function computeTermStats(db: Database, termKey: string): TermStats {
  const { sql: sourceFilter, params: sourceKeys } = glossarySourceFilter();
  const agg = safeFtsGet(
    () =>
      db
        .query(
          `SELECT COUNT(*) AS doc_freq,
                  COUNT(DISTINCT i.service) AS service_spread,
                  MIN(i.modified_at) AS first_seen,
                  MAX(i.modified_at) AS last_seen
           FROM item_fts f
           JOIN item i ON i.rowid = f.rowid
           WHERE item_fts MATCH ? AND ${sourceFilter}`,
        )
        .get(ftsQuery(termKey), ...sourceKeys) as {
        doc_freq: number;
        service_spread: number;
        first_seen: number | null;
        last_seen: number | null;
      } | null,
    null,
  );

  if (agg === null || agg.doc_freq === 0) {
    return { docFreq: 0, serviceSpread: 0, firstSeenAt: 0, lastSeenAt: 0, topSources: [] };
  }

  const sources = db
    .query(
      `SELECT i.id, i.title, i.url, i.service, i.modified_at
       FROM item_fts f
       JOIN item i ON i.rowid = f.rowid
       WHERE item_fts MATCH ? AND ${sourceFilter}
       ORDER BY i.modified_at DESC
       LIMIT ?`,
    )
    .all(ftsQuery(termKey), ...sourceKeys, TOP_SOURCE_LIMIT) as Array<{
    id: string;
    title: string;
    url: string | null;
    service: string;
    modified_at: number;
  }>;

  return {
    docFreq: agg.doc_freq,
    serviceSpread: agg.service_spread,
    firstSeenAt: agg.first_seen ?? 0,
    lastSeenAt: agg.last_seen ?? 0,
    topSources: sources.map((s) => ({
      itemId: s.id,
      title: s.title,
      url: s.url,
      service: s.service,
      modifiedAt: s.modified_at,
    })),
  };
}

export function upsertCandidate(
  db: Database,
  c: {
    key: string;
    surface: string;
    form: CandidateForm;
    stats: TermStats;
    score: number;
    nowMs: number;
  },
): void {
  // ON CONFLICT deliberately leaves `status` untouched: a consolidated or
  // vetoed row must never be silently returned to the pending queue by a
  // later sighting of the same term.
  dbRun(
    db,
    `INSERT INTO glossary_term (
       term_key, display_term, status, doc_freq, service_spread, score, form,
       first_seen_at, last_seen_at, top_sources, updated_at
     ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term_key) DO UPDATE SET
       display_term = excluded.display_term, doc_freq = excluded.doc_freq,
       service_spread = excluded.service_spread, score = excluded.score,
       form = excluded.form, first_seen_at = excluded.first_seen_at,
       last_seen_at = excluded.last_seen_at, top_sources = excluded.top_sources,
       updated_at = excluded.updated_at`,
    [
      c.key,
      c.surface,
      c.stats.docFreq,
      c.stats.serviceSpread,
      c.score,
      c.form,
      c.stats.firstSeenAt,
      c.stats.lastSeenAt,
      JSON.stringify(c.stats.topSources),
      c.nowMs,
    ],
  );
}

export function getTerm(db: Database, termKey: string): GlossaryTerm | null {
  const r = db.query("SELECT * FROM glossary_term WHERE term_key = ?").get(termKey) as Row | null;
  return r === null ? null : toTerm(r);
}

export function findBySynonym(db: Database, normalizedQuery: string): GlossaryTerm | null {
  const rows = db
    .query("SELECT * FROM glossary_term WHERE status = 'consolidated' AND synonyms <> '[]'")
    .all() as Row[];
  const needle = normalizedQuery.toLowerCase();
  for (const r of rows) {
    if (parseJsonArray<string>(r.synonyms).some((s) => s.toLowerCase() === needle))
      return toTerm(r);
  }
  return null;
}

/** Exponential backoff, capped at 24 h, so a permanently-failing term steps aside. */
export function retryCooldownMs(attempts: number, baseMs: number): number {
  if (attempts <= 0) return 0;
  const DAY_MS = 24 * 60 * 60 * 1000;
  return Math.min(DAY_MS, baseMs * 2 ** (attempts - 1));
}

export function selectPendingBatch(
  db: Database,
  limit: number,
  opts: { nowMs: number; retryBaseCooldownMs: number; minDocFreq: number },
): GlossaryTerm[] {
  // Selects across the WHOLE table, not just this pass's discoveries: a
  // high-scoring candidate deferred by the cap three passes ago must still
  // reach consolidation.
  //
  // The backoff filter is what stops head-of-line blocking. Ordering is by
  // score, and a failed consolidation stays `pending`, so without this the
  // top-scoring failures would monopolise every batch forever. Some failures
  // never succeed (snippet mode with no full-sentence mention), so this is
  // starvation by construction rather than a rare race.
  //
  // `doc_freq >= min_doc_freq` keeps a below-floor demotion (`glossary-reconcile.ts`)
  // out of the batch: without it, a term the sweep just demoted at a
  // sub-floor doc_freq is re-selected on the very next pass and re-projected
  // from its single surviving source, contradicting §5.5's "sits pending
  // below the floor and never reaches the index again."
  const rows = db
    .query(
      `SELECT * FROM glossary_term
       WHERE status = 'pending'
         AND doc_freq >= ?
         AND (
           attempts = 0
           OR last_attempt_at + MIN(86400000, ? * (1 << (attempts - 1))) <= ?
         )
       ORDER BY score DESC
       LIMIT ?`,
    )
    .all(opts.minDocFreq, opts.retryBaseCooldownMs, opts.nowMs, limit) as Row[];
  return rows.map(toTerm);
}

/**
 * Consolidated terms whose definition is a verbatim snippet, due for an
 * LLM re-consolidation.
 *
 * This function returns matching rows unconditionally — it has no
 * LLM-availability check. Gating the call on LLM availability is the
 * caller's responsibility: with no LLM configured, an "upgrade" would just
 * re-derive the same snippet from the same sources, so a caller must not
 * invoke this batch (or must no-op on its results) when no LLM is available.
 *
 * `ORDER BY last_attempt_at ASC` rotates round-robin so a large snippet
 * population drains fairly, and the backoff clause — the same shape
 * `selectPendingBatch` uses, so `retryCooldownMs` stays the single definition
 * of the curve — keeps a repeatedly-failing term to one attempt per 24 h
 * instead of letting it hold a reserved slot every pass.
 *
 * The `limit <= 0` guard exists because SQLite treats `LIMIT -1` as UNLIMITED,
 * not as "no rows". The current caller always passes a positive budget, so this
 * is defence-in-depth — but the natural way to write a caller is by
 * subtraction, and the failure it prevents (consolidating the entire snippet
 * population in one pass) is silent and expensive.
 */
export function selectSnippetUpgradeBatch(
  db: Database,
  limit: number,
  opts: { nowMs: number; retryBaseCooldownMs: number },
): GlossaryTerm[] {
  if (limit <= 0) return [];
  const rows = db
    .query(
      `SELECT * FROM glossary_term
       WHERE status = 'consolidated' AND definition_source = 'snippet'
         AND (
           attempts = 0
           OR last_attempt_at + MIN(86400000, ? * (1 << (attempts - 1))) <= ?
         )
       ORDER BY last_attempt_at ASC, score DESC
       LIMIT ?`,
    )
    .all(opts.retryBaseCooldownMs, opts.nowMs, limit) as Row[];
  return rows.map(toTerm);
}

/** Records a failed consolidation so the backoff above takes effect. */
export function recordAttempt(db: Database, termKey: string, nowMs: number): void {
  dbRun(
    db,
    `UPDATE glossary_term
     SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
     WHERE term_key = ?`,
    [nowMs, nowMs, termKey],
  );
}

/**
 * Terms due for re-verification.
 *
 * `verifiedBefore` keeps the sweep from re-checking a term that was verified
 * minutes ago: the pass fires after every connector sync, and re-running ~100
 * FTS queries each time buys nothing when the last check is fresh. With a
 * 12 h cooldown the sweep is a no-op on most passes and still reaches full
 * coverage daily.
 */
export function selectStaleForRecheck(
  db: Database,
  limit: number,
  verifiedBefore: number,
): GlossaryTerm[] {
  const rows = db
    .query(
      `SELECT * FROM glossary_term
       WHERE status = 'consolidated' AND stats_verified_at < ?
       ORDER BY stats_verified_at ASC LIMIT ?`,
    )
    .all(verifiedBefore, limit) as Row[];
  return rows.map(toTerm);
}

export function listConsolidated(db: Database, limit: number): GlossaryTerm[] {
  const rows = db
    .query("SELECT * FROM glossary_term WHERE status = 'consolidated' ORDER BY score DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(toTerm);
}

export function listAllKeys(db: Database): string[] {
  const rows = db.query("SELECT term_key FROM glossary_term").all() as Array<{ term_key: string }>;
  return rows.map((r) => r.term_key);
}

export function markConsolidated(
  db: Database,
  p: {
    termKey: string;
    definition: string;
    definitionSource: DefinitionSource;
    synonyms: string[];
    nearMisses: string[];
    nowMs: number;
  },
): void {
  dbRun(
    db,
    `UPDATE glossary_term
     SET status = 'consolidated', definition = ?, definition_source = ?,
         synonyms = ?, near_misses = ?, consolidated_at = ?,
         stats_verified_at = ?, last_attempt_at = ?, updated_at = ?
     WHERE term_key = ?`,
    [
      p.definition,
      p.definitionSource,
      JSON.stringify(p.synonyms),
      JSON.stringify(p.nearMisses),
      p.nowMs,
      p.nowMs,
      p.nowMs,
      p.nowMs,
      p.termKey,
    ],
  );
}

export function markVetoed(db: Database, termKey: string, nowMs: number): void {
  dbRun(db, "UPDATE glossary_term SET status = 'vetoed', updated_at = ? WHERE term_key = ?", [
    nowMs,
    termKey,
  ]);
}

export function demoteTerm(db: Database, termKey: string, nowMs: number): void {
  dbRun(
    db,
    `UPDATE glossary_term
     SET status = 'pending', definition = NULL, definition_source = NULL,
         consolidated_at = NULL, updated_at = ?
     WHERE term_key = ?`,
    [nowMs, termKey],
  );
}

export function applyStats(
  db: Database,
  termKey: string,
  stats: TermStats,
  score: number,
  nowMs: number,
): void {
  dbRun(
    db,
    `UPDATE glossary_term
     SET doc_freq = ?, service_spread = ?, score = ?, first_seen_at = ?,
         last_seen_at = ?, top_sources = ?, stats_verified_at = ?, updated_at = ?
     WHERE term_key = ?`,
    [
      stats.docFreq,
      stats.serviceSpread,
      score,
      stats.firstSeenAt,
      stats.lastSeenAt,
      JSON.stringify(stats.topSources),
      nowMs,
      nowMs,
      termKey,
    ],
  );
}

export function countByStatus(db: Database): { total: number; pending: number; vetoed: number } {
  const r = db
    .query(
      `SELECT
         SUM(CASE WHEN status = 'consolidated' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN status = 'pending'      THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'vetoed'       THEN 1 ELSE 0 END) AS vetoed
       FROM glossary_term`,
    )
    .get() as { total: number | null; pending: number | null; vetoed: number | null } | null;
  return { total: r?.total ?? 0, pending: r?.pending ?? 0, vetoed: r?.vetoed ?? 0 };
}

export type GlossaryPassState = {
  watermarkMs: number;
  /** Tiebreaker within `watermarkMs` — the `item.id` of the last scanned row. */
  watermarkId: string;
  lastPassAt: number | null;
  lastPassNew: number;
  scannedItems: number;
};

export function readPassState(db: Database): GlossaryPassState {
  const r = db.query("SELECT * FROM glossary_pass_state WHERE id = 1").get() as {
    watermark_ms: number;
    watermark_id: string;
    last_pass_at: number | null;
    last_pass_new: number;
    scanned_items: number;
  } | null;
  if (r === null) {
    return { watermarkMs: 0, watermarkId: "", lastPassAt: null, lastPassNew: 0, scannedItems: 0 };
  }
  return {
    watermarkMs: r.watermark_ms,
    watermarkId: r.watermark_id,
    lastPassAt: r.last_pass_at,
    lastPassNew: r.last_pass_new,
    scannedItems: r.scanned_items,
  };
}

export function writePassState(db: Database, s: GlossaryPassState): void {
  dbRun(
    db,
    `INSERT INTO glossary_pass_state
       (id, watermark_ms, watermark_id, last_pass_at, last_pass_new, scanned_items)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       watermark_ms = excluded.watermark_ms, watermark_id = excluded.watermark_id,
       last_pass_at = excluded.last_pass_at,
       last_pass_new = excluded.last_pass_new, scanned_items = excluded.scanned_items`,
    [s.watermarkMs, s.watermarkId, s.lastPassAt, s.lastPassNew, s.scannedItems],
  );
}

export function clearGlossary(db: Database): void {
  dbRun(db, "DELETE FROM glossary_term", []);
  dbRun(db, "DELETE FROM glossary_pass_state", []);
}
