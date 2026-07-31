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
  selectSnippetUpgradeBatch,
  upsertCandidate,
  writePassState,
} from "./glossary-store.ts";
import type { GlossaryPassProgress, GlossaryTerm } from "./glossary-types.ts";
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
  /** Per-term progress, for on-demand passes driven by `nimbus glossary --refresh`. */
  onProgress?: (p: GlossaryPassProgress) => void;
};

export type GlossaryPassSummary = {
  scanned: number;
  discovered: number;
  consolidated: number;
  vetoed: number;
  retried: number;
  demoted: number;
  aborted: boolean;
  /** Snippet definitions re-consolidated by the model this pass. */
  upgraded: number;
  /** Previously-consolidated snippet terms the model rejected — they LEFT the glossary. */
  upgradesVetoed: number;
  /**
   * Upgrade vetoes only (never a first-time pending veto), capped at
   * `VETOED_TERMS_REPORTED`, so the CLI can name a bounded list of terms that
   * were visible yesterday and are gone today.
   */
  vetoedTerms: string[];
  /** An adapter was supplied (i.e. `[glossary].use_llm` is on and one was built). */
  llmConfigured: boolean;
  /** The model actually answered at least once — a definition or a veto. */
  llmProduced: boolean;
};

const SCAN_BATCH_LIMIT = 5000;

/** How many consolidated terms to consider as near-miss candidates — mirrors `agents/glossary.ts`. */
const NEAR_MISS_POOL = 500;

/**
 * Upgrade slots held back from `maxNewTermsPerPass`, clamped to at most half
 * the budget.
 *
 * Without a floor, a pending queue that stays above the budget starves snippet
 * upgrades indefinitely — a term consolidated without a model would never
 * improve for as long as first-time mining continues. At the default budget
 * of 25 this reserves 5, leaving new terminology the other 20 of 25 slots.
 *
 * The half-budget clamp exists because `maxNewTermsPerPass` is a real,
 * user-facing throttle (the way a laptop-class local LLM spares itself calls
 * per pass), so small values are not a corner case: an UNCLAMPED `min(5,
 * budget)` reserve at `budget = 4` computes `reserve = 4` — the entire pass —
 * and pending is starved OUTRIGHT, the opposite of what the floor exists to
 * prevent. `Math.floor(budget / 2)` guarantees pending always keeps at least
 * half the pass. A module constant rather than a config key, matching
 * `NEAR_MISS_POOL` / `MAX_SYNONYMS`.
 *
 * At `budget <= 1` the floor itself is 0 — `Math.floor(1 / 2) = 0` — so
 * nothing is GUARANTEED to upgrades. That is correct, not a gap: a floor of
 * 0 just means neither queue is entitled to the single slot, and the
 * allocation below still hands it to whichever queue actually has work
 * (pending first, since the two `slice` calls always favor `pendingAll`
 * before spilling into `upgradeAll`'s slack). The query that FEEDS the
 * reserve is a separate decision — see `hasLlm` below — so a 0 floor never
 * means the upgrade queue goes unqueried.
 */
const UPGRADE_RESERVE = 5;

/** Cap on `vetoedTerms` — this is a user notification, not an audit trail. */
const VETOED_TERMS_REPORTED = 10;

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
): Promise<{
  consolidated: number;
  upgraded: number;
  vetoed: number;
  upgradesVetoed: number;
  vetoedTerms: string[];
  retried: number;
  llmProduced: boolean;
  aborted: boolean;
}> {
  // Budget allocation. `UPGRADE_RESERVE` is a FLOOR on upgrade slots, never a
  // ceiling, and each queue absorbs the other's slack — both one-sided
  // formulations waste budget in a corner:
  //   * upgrades capped at the reserve  -> 20 slots idle when pending is empty
  //   * pending capped at budget-reserve -> 5 slots idle whenever NO snippet
  //     rows exist, which is the common case on a machine that always had a
  //     model, so it would be a permanent 20% throughput loss on mining.
  // Over-fetching both queues to the full budget and allocating afterwards is
  // correct in every corner and costs at most `budget` extra indexed rows.
  const budget = opts.maxNewTermsPerPass;
  // Two DIFFERENT questions, deliberately NOT the same sentinel:
  //   * hasLlm gates whether the upgrade QUERY runs at all — with no model,
  //     an "upgrade" would just re-derive the same snippet from the same
  //     sources, so the query must not run.
  //   * reserve gates the FLOOR only, and can legitimately be 0 even with a
  //     model configured — `Math.floor(budget / 2)` is 0 at budget <= 1.
  // Collapsing them (as `reserve === 0 ? [] : selectSnippetUpgradeBatch(...)`)
  // meant that at budget 1 the upgrade query never ran even with a model
  // configured and real snippet work outstanding: reserve=0, so upgradeAll
  // was forced to `[]`, pendingAll was also empty, and the pass did nothing
  // with a full slot of budget sitting idle — the exact defect this
  // allocation exists to prevent, reintroduced at the boundary the clamp
  // itself created.
  const hasLlm = opts.llm !== undefined;
  const reserve = hasLlm ? Math.min(UPGRADE_RESERVE, Math.floor(budget / 2)) : 0;
  const pendingAll = selectPendingBatch(db, budget, {
    nowMs: opts.nowMs,
    retryBaseCooldownMs: opts.retryBaseCooldownMs,
    minDocFreq: opts.minDocFreq,
  });
  const upgradeAll = hasLlm
    ? selectSnippetUpgradeBatch(db, budget, {
        nowMs: opts.nowMs,
        retryBaseCooldownMs: opts.retryBaseCooldownMs,
      })
    : [];
  const upgradeTake = Math.min(upgradeAll.length, Math.max(reserve, budget - pendingAll.length));
  const batch = pendingAll.slice(0, Math.min(pendingAll.length, budget - upgradeTake));
  const upgradeBatch = upgradeAll.slice(0, upgradeTake);
  // Consolidated keys only — mirrors the agent's near-miss lane. Drawing from
  // every status (via `listAllKeys`) let a `pending` or `vetoed` key surface
  // as a stored "Easily confused with:" suggestion, which either points at a
  // term with no definition yet or one deliberately rejected.
  const knownKeys = listConsolidated(db, NEAR_MISS_POOL).map((t) => t.termKey);

  const work: Array<{ term: GlossaryTerm; isUpgrade: boolean }> = [
    ...batch.map((term) => ({ term, isUpgrade: false })),
    ...upgradeBatch.map((term) => ({ term, isUpgrade: true })),
  ];

  let consolidated = 0;
  let upgraded = 0;
  let vetoed = 0;
  let upgradesVetoed = 0;
  let retried = 0;
  let llmProduced = false;
  const vetoedTerms: string[] = [];
  let done = 0;

  for (const { term, isUpgrade } of work) {
    if (opts.signal?.aborted === true) {
      return {
        consolidated,
        upgraded,
        vetoed,
        upgradesVetoed,
        vetoedTerms,
        retried,
        llmProduced,
        aborted: true,
      };
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
      // Only a model can veto, so this proves the model answered.
      llmProduced = true;
      unprojectTerm(db, term.termKey);
      markVetoed(db, term.termKey, opts.nowMs);
      vetoed += 1;
      if (isUpgrade) {
        upgradesVetoed += 1;
        // A term the user could see yesterday and cannot see today. Named so
        // `--refresh` can report it rather than letting it vanish silently.
        // `displayTerm`, not `termKey`: the rebuild preview (via
        // `agents.glossary`) shows the display form (e.g. "CDR"), and this
        // list must read the same way, not as the lowercased normalized key.
        if (vetoedTerms.length < VETOED_TERMS_REPORTED) vetoedTerms.push(term.displayTerm);
      }
    } else if (outcome.kind === "retry") {
      // Stamps the attempt for BOTH queues' backoff — a failing upgrade steps
      // aside from its reserved slot exactly like a failing pending term.
      recordAttempt(db, term.termKey, opts.nowMs);
      retried += 1;
    } else {
      if (outcome.source === "llm") llmProduced = true;
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
      if (isUpgrade) upgraded += 1;
      else consolidated += 1;
    }

    done += 1;
    opts.onProgress?.({
      done,
      total: work.length,
      consolidated,
      upgraded,
      vetoed,
      retried,
    });
  }

  return {
    consolidated,
    upgraded,
    vetoed,
    upgradesVetoed,
    vetoedTerms,
    retried,
    llmProduced,
    aborted: opts.signal?.aborted === true,
  };
}

export async function runGlossaryPass(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  const llmConfigured = opts.llm !== undefined;
  const a = discoverPhase(db, opts);
  if (opts.signal?.aborted === true) {
    return {
      ...a,
      consolidated: 0,
      upgraded: 0,
      vetoed: 0,
      upgradesVetoed: 0,
      vetoedTerms: [],
      retried: 0,
      llmConfigured,
      llmProduced: false,
      aborted: true,
    };
  }
  const b = await consolidatePhase(db, opts);
  return { ...a, ...b, llmConfigured };
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
