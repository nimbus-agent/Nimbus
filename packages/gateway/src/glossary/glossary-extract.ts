import type { Database } from "bun:sqlite";

import { type ConsolidatorLlm, consolidateTerm } from "./glossary-consolidate.ts";
import { projectTerm, unprojectTerm } from "./glossary-project.ts";
import { reconcilePass } from "./glossary-reconcile.ts";
import { glossarySourceFilter } from "./glossary-source-types.ts";
import {
  clearGlossary,
  computeTermStats,
  getTerm,
  listAllKeys,
  listConsolidated,
  markConsolidated,
  markVetoed,
  readPassState,
  recordAttempt,
  selectPendingBatch,
  upsertCandidate,
  writePassState,
} from "./glossary-store.ts";
import { findNearMisses } from "./near-miss.ts";
import { mineTerms } from "./term-mining.ts";
import { scoreTerm } from "./term-scoring.ts";

export type GlossaryPassOptions = {
  maxNewTermsPerPass: number;
  statsRecheckPerPass: number;
  /** Skip re-verifying terms checked more recently than this. */
  statsRecheckCooldownMs: number;
  minDocFreq: number;
  consolidateTimeoutMs: number;
  /** Base for the exponential retry backoff that prevents queue starvation. */
  retryBaseCooldownMs: number;
  llm?: ConsolidatorLlm;
  nowMs: number;
  signal?: AbortSignal;
};

export type GlossaryPassSummary = {
  scanned: number;
  discovered: number;
  consolidated: number;
  vetoed: number;
  retried: number;
  demoted: number;
  aborted: boolean;
};

const SCAN_BATCH_LIMIT = 5000;

/** How many consolidated terms to consider as near-miss candidates — mirrors `agents/glossary.ts`. */
const NEAR_MISS_POOL = 500;

type ScanRow = { id: string; title: string; body_preview: string | null; modified_at: number };

/**
 * The delta scan, resumed from a COMPOSITE `(modified_at, id)` cursor.
 *
 * A plain `modified_at > watermark` cursor loses rows whenever a tie group is
 * larger than what `LIMIT` returns: `ORDER BY modified_at` picks an arbitrary
 * subset of the rows sharing the boundary timestamp, the watermark advances to
 * that timestamp, and the rest are no longer `>` it — permanently invisible to
 * the glossary. Bulk imports stamping one job-level timestamp across thousands
 * of items make that ordinary rather than exotic. Ordering and comparing by
 * `(modified_at, id)` makes the cursor total, so a truncated batch resumes
 * exactly where it stopped.
 */
function scanDelta(db: Database, cursor: { watermarkMs: number; watermarkId: string }): ScanRow[] {
  const { sql: sourceFilter, params: sourceKeys } = glossarySourceFilter();
  return db
    .query(
      `SELECT i.id, i.title, i.body_preview, i.modified_at
       FROM item i
       WHERE ${sourceFilter}
         AND (i.modified_at > ? OR (i.modified_at = ? AND i.id > ?))
       ORDER BY i.modified_at ASC, i.id ASC
       LIMIT ?`,
    )
    .all(
      ...sourceKeys,
      cursor.watermarkMs,
      cursor.watermarkMs,
      cursor.watermarkId,
      SCAN_BATCH_LIMIT,
    ) as ScanRow[];
}

/** Snippets handed to consolidation — the indexed text of a term's top sources. */
function snippetsFor(db: Database, itemIds: readonly string[]): Array<{ text: string }> {
  if (itemIds.length === 0) return [];
  const ph = itemIds.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT title, body_preview FROM item WHERE id IN (${ph})`)
    .all(...itemIds) as Array<{ title: string; body_preview: string | null }>;
  return rows.map((r) => ({ text: `${r.title}. ${r.body_preview ?? ""}`.trim() }));
}

/**
 * Phase A — discover. Pure SQL, committed before any LLM call.
 *
 * The watermark advances HERE, not after consolidation: candidates are durable
 * `pending` rows the moment this returns, so an interrupted phase B costs at
 * most one in-flight call rather than a full re-scan.
 */
function discoverPhase(
  db: Database,
  opts: GlossaryPassOptions,
): { scanned: number; discovered: number; demoted: number } {
  const state = readPassState(db);
  const rows = scanDelta(db, state);

  let discovered = 0;

  const seen = new Map<
    string,
    { surface: string; form: ReturnType<typeof mineTerms>[number]["form"] }
  >();
  for (const row of rows) {
    const text = `${row.title}\n${row.body_preview ?? ""}`;
    for (const c of mineTerms(text)) {
      if (!seen.has(c.key)) seen.set(c.key, { surface: c.surface, form: c.form });
    }
  }

  for (const [key, c] of seen) {
    const stats = computeTermStats(db, key);
    if (stats.docFreq < opts.minDocFreq) continue;
    upsertCandidate(db, {
      key,
      surface: c.surface,
      form: c.form,
      stats,
      score: scoreTerm({
        docFreq: stats.docFreq,
        serviceSpread: stats.serviceSpread,
        form: c.form,
      }),
      nowMs: opts.nowMs,
    });
    discovered += 1;
  }

  const reconciled = reconcilePass(db, {
    limit: opts.statsRecheckPerPass,
    minDocFreq: opts.minDocFreq,
    nowMs: opts.nowMs,
    cooldownMs: opts.statsRecheckCooldownMs,
  });

  // The cursor advances to the LAST row of the batch, which under
  // `ORDER BY modified_at, id` is the largest `(modified_at, id)` pair scanned.
  // An empty batch leaves the cursor where it was.
  const last = rows.at(-1);
  writePassState(db, {
    watermarkMs: last?.modified_at ?? state.watermarkMs,
    watermarkId: last?.id ?? state.watermarkId,
    lastPassAt: opts.nowMs,
    lastPassNew: discovered,
    scannedItems: rows.length,
  });

  return { scanned: rows.length, discovered, demoted: reconciled.demoted.length };
}

/**
 * Phase B — consolidate. One transaction per term, sequential.
 *
 * Sequential is deliberate: parallel requests multiply resident model memory on
 * a local Ollama, and nothing user-facing waits on this pass (reads hit the
 * materialized table).
 */
async function consolidatePhase(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<{ consolidated: number; vetoed: number; retried: number; aborted: boolean }> {
  const batch = selectPendingBatch(db, opts.maxNewTermsPerPass, {
    nowMs: opts.nowMs,
    retryBaseCooldownMs: opts.retryBaseCooldownMs,
    minDocFreq: opts.minDocFreq,
  });
  // Consolidated keys only — mirrors the agent's near-miss lane. Drawing from
  // every status (via `listAllKeys`) let a `pending` or `vetoed` key surface
  // as a stored "Easily confused with:" suggestion, which either points at a
  // term with no definition yet or one deliberately rejected.
  const knownKeys = listConsolidated(db, NEAR_MISS_POOL).map((t) => t.termKey);

  let consolidated = 0;
  let vetoed = 0;
  let retried = 0;

  for (const term of batch) {
    if (opts.signal?.aborted === true) {
      return { consolidated, vetoed, retried, aborted: true };
    }

    const snippets = snippetsFor(
      db,
      term.topSources.map((s) => s.itemId),
    );
    const outcome = await consolidateTerm(term, snippets, {
      ...(opts.llm === undefined ? {} : { llm: opts.llm }),
      timeoutMs: opts.consolidateTimeoutMs,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });

    if (outcome.kind === "vetoed") {
      unprojectTerm(db, term.termKey);
      markVetoed(db, term.termKey, opts.nowMs);
      vetoed += 1;
      continue;
    }
    if (outcome.kind === "retry") {
      // Stamp the attempt so the backoff in `selectPendingBatch` lets
      // lower-scoring terms through on the next pass. Without this the
      // top-scoring failures would monopolise every batch forever.
      recordAttempt(db, term.termKey, opts.nowMs);
      retried += 1;
      continue;
    }

    // One transaction: a crash between markConsolidated and projectTerm would
    // otherwise strand the term `consolidated` with no projected item row —
    // invisible in search, and (per the reconciliation sweep's own contract)
    // never self-healed, since the sweep only re-verifies rows already
    // `consolidated` and this row genuinely is. `db.transaction` nests safely
    // via savepoints, so this composes with any outer transaction.
    db.transaction(() => {
      markConsolidated(db, {
        termKey: term.termKey,
        definition: outcome.definition,
        definitionSource: outcome.source,
        synonyms: outcome.synonyms,
        nearMisses: findNearMisses(term.termKey, knownKeys),
        nowMs: opts.nowMs,
      });
      const stored = getTerm(db, term.termKey);
      if (stored !== null) projectTerm(db, stored, opts.nowMs);
    })();
    consolidated += 1;
  }

  return { consolidated, vetoed, retried, aborted: opts.signal?.aborted === true };
}

export async function runGlossaryPass(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  const a = discoverPhase(db, opts);
  if (opts.signal?.aborted === true) {
    return { ...a, consolidated: 0, vetoed: 0, retried: 0, aborted: true };
  }
  const b = await consolidatePhase(db, opts);
  return { ...a, ...b };
}

/** Wipes every glossary row and projection, then re-mines from watermark zero. */
export async function rebuildGlossary(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  for (const key of listAllKeys(db)) unprojectTerm(db, key);
  clearGlossary(db);
  return runGlossaryPass(db, opts);
}
