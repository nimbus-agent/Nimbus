import type { Database } from "bun:sqlite";

import {
  type GlossaryManualConfig,
  loadGlossaryManualFromConfigDir,
  type ManualSkip,
} from "../config/nimbus-toml-glossary-terms.ts";
import {
  type ConsolidationOutcome,
  type ConsolidatorLlm,
  consolidateTerm,
} from "./glossary-consolidate.ts";
import { applyManualTerms } from "./glossary-manual.ts";
import { projectTerm, unprojectTerm } from "./glossary-project.ts";
import { reconcilePass } from "./glossary-reconcile.ts";
import { glossarySourceFilter } from "./glossary-source-types.ts";
import {
  clearGlossary,
  computeTermStats,
  getTerm,
  listAllKeys,
  listConsolidated,
  listManualKeys,
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
  /**
   * Config directory holding `nimbus.toml`, re-read EVERY pass so
   * `nimbus glossary --refresh` applies an edit without a gateway restart.
   * `assemble.ts` loads the numeric `[glossary]` knobs once at startup, but
   * authored content is what a user actively edits.
   *
   * Optional: a pass without it (tests, a degraded boot) reads no config, and
   * `applyManualTerms` treats that as `loaded: false` — inert, never a
   * desired-state wipe.
   */
  configDir?: string;
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
  /** Authored terms upserted from `[glossary.terms]` this pass. */
  manualAdded: number;
  /** Authored rows demoted because their config entry was removed. */
  manualRemoved: number;
  /** Config entries rejected by validation, for `--refresh` to report. */
  manualSkipped: ManualSkip[];
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

type ScanRow = {
  id: string;
  title: string;
  body: string | null;
  body_complete: number;
  modified_at: number;
};

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
      `SELECT i.id, i.title, i.body, i.body_complete, i.modified_at
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
    .query(`SELECT title, body FROM item WHERE id IN (${ph})`)
    .all(...itemIds) as Array<{ title: string; body: string | null }>;
  return rows.map((r) => ({ text: `${r.title}. ${r.body ?? ""}`.trim() }));
}

/**
 * A read-only candidate load over the FULL glossary-source domain since
 * `sinceMs` — not the incremental delta `scanDelta` drains for mining. This
 * backs the brief's honesty count: "N source(s) considered, M truncated" (see
 * `agents/glossary.ts`), where "truncated" means `body_complete = 0` — either
 * a connector that has not declared a full body yet, or one that did but the
 * source exceeded its type's cap.
 */
export type GlossaryCandidateRow = {
  id: string;
  title: string;
  body: string | null;
  body_complete: number;
  modified_at: number;
};

export function loadGlossaryCandidates(
  db: Database,
  opts: { sinceMs: number },
): { rows: GlossaryCandidateRow[]; truncatedSources: number } {
  const { sql: sourceFilter, params: sourceKeys } = glossarySourceFilter();
  const rows = db
    .query(
      `SELECT i.id, i.title, i.body, i.body_complete, i.modified_at
         FROM item i
        WHERE ${sourceFilter} AND i.modified_at >= ?
        ORDER BY i.modified_at DESC, i.id ASC`,
    )
    .all(...sourceKeys, opts.sinceMs) as GlossaryCandidateRow[];
  const truncatedSources = rows.reduce((n, r) => n + (r.body_complete === 0 ? 1 : 0), 0);
  return { rows, truncatedSources };
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
    const text = `${row.title}\n${row.body ?? ""}`;
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

/** One unit of Phase B work: a term, plus whether it came from the upgrade queue. */
type ConsolidationUnit = { term: GlossaryTerm; isUpgrade: boolean };

/** Running counters for one consolidate phase; mutated by the per-outcome helpers. */
type ConsolidationTally = {
  consolidated: number;
  upgraded: number;
  vetoed: number;
  upgradesVetoed: number;
  vetoedTerms: string[];
  retried: number;
  llmProduced: boolean;
};

/**
 * Splits the per-pass budget between the pending queue and the snippet-upgrade
 * queue, and returns the flattened work list in execution order.
 */
function selectConsolidationWork(db: Database, opts: GlossaryPassOptions): ConsolidationUnit[] {
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

  return [
    ...batch.map((term) => ({ term, isUpgrade: false })),
    ...upgradeBatch.map((term) => ({ term, isUpgrade: true })),
  ];
}

/** Only a model can veto, so reaching here proves the model answered. */
function applyVetoedOutcome(
  db: Database,
  unit: ConsolidationUnit,
  nowMs: number,
  tally: ConsolidationTally,
): void {
  tally.llmProduced = true;
  unprojectTerm(db, unit.term.termKey);
  markVetoed(db, unit.term.termKey, nowMs);
  tally.vetoed += 1;
  if (!unit.isUpgrade) return;
  tally.upgradesVetoed += 1;
  // A term the user could see yesterday and cannot see today. Named so
  // `--refresh` can report it rather than letting it vanish silently.
  // `displayTerm`, not `termKey`: the rebuild preview (via
  // `agents.glossary`) shows the display form (e.g. "CDR"), and this
  // list must read the same way, not as the lowercased normalized key.
  if (tally.vetoedTerms.length < VETOED_TERMS_REPORTED) {
    tally.vetoedTerms.push(unit.term.displayTerm);
  }
}

function applyDefinedOutcome(
  db: Database,
  unit: ConsolidationUnit,
  outcome: Extract<ConsolidationOutcome, { kind: "defined" }>,
  ctx: { knownKeys: string[]; nowMs: number },
  tally: ConsolidationTally,
): void {
  if (outcome.source === "llm") tally.llmProduced = true;
  // One transaction: a crash between markConsolidated and projectTerm would
  // otherwise strand the term `consolidated` with no projected item row —
  // invisible in search, and (per the reconciliation sweep's own contract)
  // never self-healed, since the sweep only re-verifies rows already
  // `consolidated` and this row genuinely is. `db.transaction` nests safely
  // via savepoints, so this composes with any outer transaction.
  db.transaction(() => {
    markConsolidated(db, {
      termKey: unit.term.termKey,
      definition: outcome.definition,
      definitionSource: outcome.source,
      synonyms: outcome.synonyms,
      nearMisses: findNearMisses(unit.term.termKey, ctx.knownKeys),
      nowMs: ctx.nowMs,
    });
    const stored = getTerm(db, unit.term.termKey);
    if (stored !== null) projectTerm(db, stored, ctx.nowMs);
  })();
  if (unit.isUpgrade) tally.upgraded += 1;
  else tally.consolidated += 1;
}

function applyConsolidationOutcome(
  db: Database,
  unit: ConsolidationUnit,
  outcome: ConsolidationOutcome,
  ctx: { knownKeys: string[]; nowMs: number },
  tally: ConsolidationTally,
): void {
  if (outcome.kind === "vetoed") {
    applyVetoedOutcome(db, unit, ctx.nowMs, tally);
    return;
  }
  if (outcome.kind === "retry") {
    // Stamps the attempt for BOTH queues' backoff — a failing upgrade steps
    // aside from its reserved slot exactly like a failing pending term.
    recordAttempt(db, unit.term.termKey, ctx.nowMs);
    tally.retried += 1;
    return;
  }
  applyDefinedOutcome(db, unit, outcome, ctx, tally);
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
): Promise<ConsolidationTally & { aborted: boolean }> {
  const work = selectConsolidationWork(db, opts);
  // Consolidated keys only — mirrors the agent's near-miss lane. Drawing from
  // every status (via `listAllKeys`) let a `pending` or `vetoed` key surface
  // as a stored "Easily confused with:" suggestion, which either points at a
  // term with no definition yet or one deliberately rejected.
  const knownKeys = listConsolidated(db, NEAR_MISS_POOL).map((t) => t.termKey);

  const tally: ConsolidationTally = {
    consolidated: 0,
    upgraded: 0,
    vetoed: 0,
    upgradesVetoed: 0,
    vetoedTerms: [],
    retried: 0,
    llmProduced: false,
  };
  let done = 0;

  for (const unit of work) {
    if (opts.signal?.aborted === true) return { ...tally, aborted: true };

    const snippets = snippetsFor(
      db,
      unit.term.topSources.map((s) => s.itemId),
    );
    const outcome = await consolidateTerm(unit.term, snippets, {
      ...(opts.llm === undefined ? {} : { llm: opts.llm }),
      timeoutMs: opts.consolidateTimeoutMs,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });

    applyConsolidationOutcome(db, unit, outcome, { knownKeys, nowMs: opts.nowMs }, tally);

    done += 1;
    opts.onProgress?.({
      done,
      total: work.length,
      consolidated: tally.consolidated,
      upgraded: tally.upgraded,
      vetoed: tally.vetoed,
      retried: tally.retried,
    });
  }

  return { ...tally, aborted: opts.signal?.aborted === true };
}

function readManualConfig(opts: GlossaryPassOptions): GlossaryManualConfig {
  return opts.configDir === undefined
    ? { loaded: false }
    : loadGlossaryManualFromConfigDir(opts.configDir);
}

export async function runGlossaryPass(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  const llmConfigured = opts.llm !== undefined;
  // The authoring pre-pass runs FIRST, so `discoverPhase`'s `upsertCandidate`
  // refreshes an authored row's statistics in the same pass (its display_term
  // guard keeps the authored surface form).
  const m = applyManualTerms(db, readManualConfig(opts), { nowMs: opts.nowMs });
  const manual = {
    manualAdded: m.added,
    manualRemoved: m.removed,
    manualSkipped: m.skipped,
  };
  const a = discoverPhase(db, opts);
  if (opts.signal?.aborted === true) {
    return {
      ...a,
      ...manual,
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
  return { ...a, ...manual, ...b, llmConfigured };
}

/**
 * Wipes every glossary row and projection, then re-mines from watermark zero.
 *
 * When the config IS readable, the unproject + truncate + authoring pre-pass
 * run in ONE transaction, so the state in which an authored term is absent is
 * never committed and therefore unobservable to any reader. Correctness comes
 * from the pre-pass being unconditional and model-free — authored rows need
 * no consolidation, so they never wait on the bounded per-pass budget.
 *
 * When the config is NOT readable and authored rows exist, that guarantee is
 * unavailable — there is nothing to re-read from — so this throws instead of
 * truncating. `applyManualTerms`'s `loaded:false` fail-safe only protects
 * `runGlossaryPass`, which never truncates; it cannot restore a row this
 * function already deleted.
 */
export async function rebuildGlossary(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  const cfg = readManualConfig(opts);
  if (!cfg.loaded && listManualKeys(db).length > 0) {
    throw new Error("cannot rebuild: nimbus.toml is unreadable and authored terms would be lost");
  }
  let restored: ReturnType<typeof applyManualTerms> = { added: 0, removed: 0, skipped: [] };
  db.transaction(() => {
    for (const key of listAllKeys(db)) unprojectTerm(db, key);
    clearGlossary(db);
    restored = applyManualTerms(db, cfg, { nowMs: opts.nowMs });
  })();

  // The pass below re-runs the pre-pass, which is idempotent: every authored
  // key is already present, so it upserts the same values and removes nothing.
  const summary = await runGlossaryPass(db, opts);
  return { ...summary, manualAdded: restored.added, manualRemoved: restored.removed };
}
