import type { Database } from "bun:sqlite";
import { decisionRowId, mineCues } from "./cue-mining.ts";
import { computeConfidence, computePriority } from "./decision-confidence.ts";
import { corroborate, hasAdrEvidence } from "./decision-corroborate.ts";
import { type DecisionLlm, extractDecision } from "./decision-llm-adapter.ts";
import { decisionSourceFilter } from "./decision-source-types.ts";
import {
  clearDecisions,
  markExtracted,
  markVetoed,
  readPassState,
  recordAttempt,
  replaceEvidence,
  selectPendingByPriority,
  selectSnippetUpgrades,
  setConfidence,
  upsertCandidate,
  writePassState,
} from "./decision-store.ts";
import type { DecisionRecord } from "./decision-types.ts";

export const SCAN_BATCH_LIMIT = 5000;

/**
 * Safety bound on the discovery drain. A pass keeps scanning until a batch
 * comes back short, so on a healthy index this is never reached — it exists
 * only so a pathological case (a `modified_at`/`id` cursor that somehow fails
 * to advance, a table growing faster than it is scanned) terminates instead of
 * spinning. Hitting it is NOT silently treated as completion: the pass reports
 * `discoveryComplete: false` and the CLI says so, because "the rebuild covered
 * a prefix of your index" and "the rebuild finished" are different facts.
 */
export const MAX_DISCOVERY_BATCHES = 1000;

/**
 * Per-pass work budget. `maxLlmCalls` reaches here from config/IPC, so a
 * non-finite or fractional value must be normalised BEFORE it becomes a SQL
 * `LIMIT` — both branches of `runDecisionPass` use this, not just the LLM one.
 */
function passBudget(maxLlmCalls: number): number {
  return Number.isFinite(maxLlmCalls) ? Math.max(0, Math.trunc(maxLlmCalls)) : 0;
}

/**
 * A CAP on upgrade slots per pass, mirroring `glossary`'s UPGRADE_RESERVE —
 * not a fixed carve-out of the budget. `runDecisionPass` over-fetches both the
 * pending and snippet-upgrade queues to the full per-pass budget, then hands
 * upgrades `min(UPGRADE_RESERVE, upgradeCandidates)` slots: it yields the rest
 * to pending when there are fewer real upgrade candidates than the cap (so a
 * reserve with no work to do never idles), and it absorbs the whole budget
 * when there are no pending candidates at all (so a pass with only upgrade
 * work outstanding still does something, even at `maxLlmCalls: 1`).
 */
export const UPGRADE_RESERVE = 5;

export interface DecisionPassOptions {
  readonly nowMs: number;
  readonly useLlm: boolean;
  readonly maxLlmCalls: number;
  // No `minConfidence` here on purpose. Extraction stores every candidate with
  // its computed score and filters nothing; `[decisions].min_confidence` is a
  // READ-path floor applied in `agents/decisions.ts`, so changing it re-filters
  // an existing store instead of requiring a `--rebuild`.
  readonly retryCooldownMs: number;
  readonly llm?: DecisionLlm;
  /**
   * Rows per discovery batch. Production never sets this — it exists so a test
   * can prove the drain loop over 3 batches instead of seeding 15,001 rows.
   * Normalised like `maxLlmCalls`: a non-finite or <1 value falls back to
   * `SCAN_BATCH_LIMIT` rather than reaching SQL as a `LIMIT`.
   */
  readonly scanBatchLimit?: number;
  /** Test seam for `MAX_DISCOVERY_BATCHES`; same normalisation. */
  readonly maxDiscoveryBatches?: number;
}

export interface DecisionPassSummary {
  readonly scanned: number;
  readonly discovered: number;
  readonly extracted: number;
  readonly vetoed: number;
  readonly upgraded: number;
  readonly failed: number;
  /**
   * Rows extracted via the snippet fallback because no local model was
   * available at call time (`extractDecision` returned `null`) — distinct
   * from `failed`, which means the model replied with unparseable output.
   */
  readonly noModel: number;
  /**
   * `false` when discovery stopped on the `MAX_DISCOVERY_BATCHES` safety bound
   * with items still behind the watermark. A capped scan that reports success
   * is the silent-truncation shape this feature already had to fix once in the
   * ADR query, so the truth is carried in the summary rather than inferred.
   * The next pass resumes from the persisted watermark, so the work is
   * deferred, never lost.
   */
  readonly discoveryComplete: boolean;
}

type ScanRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  body: string | null;
  body_complete: number;
  modified_at: number;
};

function scanDelta(
  db: Database,
  cursor: { watermarkMs: number; watermarkId: string },
  batchLimit: number,
): ScanRow[] {
  const { sql, params } = decisionSourceFilter();
  return db
    .query(
      `SELECT i.id, i.service, i.type, i.title, i.body, i.body_complete, i.modified_at
         FROM item i
        WHERE ${sql}
          AND (i.modified_at > ? OR (i.modified_at = ? AND i.id > ?))
        ORDER BY i.modified_at ASC, i.id ASC
        LIMIT ?`,
    )
    .all(
      ...params,
      cursor.watermarkMs,
      cursor.watermarkMs,
      cursor.watermarkId,
      batchLimit,
    ) as ScanRow[];
}

/**
 * A read-only candidate COUNT over the FULL decision-source domain within a
 * window — not the incremental delta `scanDelta` drains for mining. This
 * backs the brief's honesty count: "N source(s) considered, M truncated"
 * (see `agents/decisions.ts`), where "truncated" means `body_complete = 0` —
 * either a connector that has not declared a full body yet, or one that did
 * but the source exceeded its type's cap.
 *
 * Projects a SQL aggregate rather than materialising rows: the caller only
 * ever needs the two counts, and a row-returning query would pull every
 * matching item's full `body` (up to 16 KiB each, unbounded — unlike
 * `scanDelta`, there is no `LIMIT` here) across the `AgentCoordinator`
 * JSON-stringify boundary just to discard it. Uses the SAME
 * `decisionSourceFilter()` predicate as `scanDelta` so the counted
 * population always matches the mined population — that equivalence is
 * what makes the reported number honest, so do not inline or re-derive it.
 */
export function loadDecisionCandidates(
  db: Database,
  opts: { sinceMs: number },
): { total: number; truncatedSources: number } {
  const { sql, params } = decisionSourceFilter();
  const row = db
    .query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN i.body_complete = 0 THEN 1 ELSE 0 END), 0) AS truncated
         FROM item i
        WHERE ${sql} AND i.modified_at >= ?`,
    )
    .get(...params, opts.sinceMs) as { total: number; truncated: number } | null;
  return { total: row?.total ?? 0, truncatedSources: row?.truncated ?? 0 };
}

/** Normalises a caller-supplied positive-integer bound; see `passBudget`. */
function boundOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return n >= 1 ? n : fallback;
}

function scanText(r: ScanRow): string {
  return `${r.title}. ${r.body ?? ""}`.trim();
}

/** Mines one already-fetched batch and commits it with the advanced watermark. */
function commitBatch(
  db: Database,
  rows: readonly ScanRow[],
  last: ScanRow,
  opts: DecisionPassOptions,
  running: { scanned: number; discovered: number; scannedItemsBefore: number },
): number {
  let batchDiscovered = 0;
  db.transaction(() => {
    for (const r of rows) {
      const serviceType = `${r.service}:${r.type}`;
      for (const hit of mineCues(scanText(r))) {
        upsertCandidate(db, {
          id: decisionRowId(r.id, hit.normalized),
          sourceItemId: r.id,
          cueTier: hit.tier,
          cueText: hit.cueText,
          priority: computePriority({ tier: hit.tier, serviceType }),
          decidedAt: r.modified_at,
          nowMs: opts.nowMs,
        });
        batchDiscovered++;
      }
    }
    writePassState(db, {
      watermarkMs: last.modified_at,
      watermarkId: last.id,
      lastPassAt: opts.nowMs,
      lastPassNew: running.discovered + batchDiscovered,
      scannedItems: running.scannedItemsBefore + running.scanned + rows.length,
    });
  })();
  return batchDiscovered;
}

/**
 * Phase A — discover. Pure SQL + regex, committed before any model call, and
 * the watermark advances HERE. Candidates are durable `pending` rows the moment
 * this returns, so an interrupted Phase B costs one in-flight call rather than
 * a full re-scan.
 *
 * Discovery DRAINS. A single `scanDelta` call caps at `SCAN_BATCH_LIMIT`, so a
 * one-shot phase meant `--rebuild` — which clears the watermark and runs one
 * pass — covered only the oldest 5000 source items on a larger index and
 * reported success anyway. Each batch commits before the next is fetched, so an
 * interrupted drain resumes from the persisted watermark rather than restarting.
 * The loop ends when a batch comes back short of the limit (the common case, and
 * one query on a small index, exactly as before) or on the `MAX_DISCOVERY_BATCHES`
 * bound, which is reported as `discoveryComplete: false`.
 */
function discoverPhase(
  db: Database,
  opts: DecisionPassOptions,
): { scanned: number; discovered: number; discoveryComplete: boolean } {
  const initial = readPassState(db);
  const batchLimit = boundOr(opts.scanBatchLimit, SCAN_BATCH_LIMIT);
  const maxBatches = boundOr(opts.maxDiscoveryBatches, MAX_DISCOVERY_BATCHES);

  let cursor = { watermarkMs: initial.watermarkMs, watermarkId: initial.watermarkId };
  const running = { scanned: 0, discovered: 0, scannedItemsBefore: initial.scannedItems };
  let discoveryComplete = false;

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = scanDelta(db, cursor, batchLimit);
    const last = rows.at(-1);
    if (last === undefined) {
      discoveryComplete = true;
      break;
    }
    running.discovered += commitBatch(db, rows, last, opts, running);
    running.scanned += rows.length;
    cursor = { watermarkMs: last.modified_at, watermarkId: last.id };
    if (rows.length < batchLimit) {
      discoveryComplete = true;
      break;
    }
  }

  if (running.scanned === 0) {
    // The delta was empty, but the PASS still ran. Recording only inside the
    // non-empty branch left `last_pass_at` null forever on an unchanged index,
    // so `agents/decisions.ts` kept telling a user who had just run
    // `nimbus decisions --refresh` to run `nimbus decisions --refresh`.
    // The watermark and `scanned_items` are carried through UNCHANGED — a pass
    // that scanned nothing must not move a cursor it never read past.
    writePassState(db, { ...initial, lastPassAt: opts.nowMs, lastPassNew: 0 });
  }

  return { scanned: running.scanned, discovered: running.discovered, discoveryComplete };
}

function serviceTypeOf(db: Database, itemId: string): string {
  const r = db.query("SELECT service, type FROM item WHERE id = ?").get(itemId) as {
    service: string;
    type: string;
  } | null;
  return r === null ? "unknown:unknown" : `${r.service}:${r.type}`;
}

function sentenceContext(db: Database, itemId: string): string {
  const r = db.query("SELECT title, body FROM item WHERE id = ?").get(itemId) as {
    title: string;
    body: string | null;
  } | null;
  return r === null ? "" : `${r.title}. ${r.body ?? ""}`.trim();
}

/** Recompute evidence + confidence for one extracted row. */
function corroboratePhase(
  db: Database,
  id: string,
  statement: string,
  opts: DecisionPassOptions,
): void {
  const row = db
    .query(
      "SELECT source_item_id, decided_at, cue_tier, rationale, alternatives FROM decision_record WHERE id = ?",
    )
    .get(id) as {
    source_item_id: string;
    decided_at: number;
    cue_tier: string;
    rationale: string | null;
    alternatives: string;
  } | null;
  if (row === null) return;

  const evidence = corroborate(db, {
    decisionId: id,
    sourceItemId: row.source_item_id,
    decidedAt: row.decided_at,
    statement,
  });
  replaceEvidence(db, id, evidence);

  let alternativesCount = 0;
  try {
    const parsed: unknown = JSON.parse(row.alternatives);
    alternativesCount = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    alternativesCount = 0;
  }

  const confidence = computeConfidence({
    tier: row.cue_tier as "heading" | "explicit" | "weak",
    serviceType: serviceTypeOf(db, row.source_item_id),
    evidenceKinds: evidence.map((e) => e.kind),
    hasRationale: row.rationale !== null,
    hasAlternatives: alternativesCount > 0,
  });
  setConfidence(db, id, confidence, hasAdrEvidence(evidence), opts.nowMs);
}

/** Snippet mode: the mined sentence IS the statement. No model, no alternatives. */
function extractAsSnippet(db: Database, row: DecisionRecord, opts: DecisionPassOptions): void {
  const statement = row.cueText.length > 0 ? sentenceFor(db, row) : row.cueText;
  markExtracted(
    db,
    row.id,
    { statement, rationale: null, alternatives: [], extractionSource: "snippet" },
    opts.nowMs,
  );
  corroboratePhase(db, row.id, statement, opts);
}

/** Re-derives the mined sentence from the source item by matching the stored cue. */
function sentenceFor(db: Database, row: DecisionRecord): string {
  const text = sentenceContext(db, row.sourceItemId);
  for (const hit of mineCues(text)) {
    if (decisionRowId(row.sourceItemId, hit.normalized) === row.id) return hit.sentence;
  }
  return row.cueText;
}

async function extractOne(
  db: Database,
  row: DecisionRecord,
  llm: DecisionLlm,
  opts: DecisionPassOptions,
): Promise<"extracted" | "vetoed" | "failed" | "no-model"> {
  const sentence = sentenceFor(db, row);
  try {
    const outcome = await extractDecision(llm, sentence, sentenceContext(db, row.sourceItemId));
    if (outcome === null) {
      // No local model was available for this call — NOT a failure. The row
      // is left untouched here and falls back to the snippet path, so it
      // stays (or becomes) pending/snippet-sourced and is picked up again by
      // the upgrade reserve once a model is available. No `recordAttempt`:
      // that would apply backoff to a row that never actually got a model
      // opinion.
      extractAsSnippet(db, row, opts);
      return "no-model";
    }
    if (outcome.kind === "veto") {
      markVetoed(db, row.id, opts.nowMs);
      return "vetoed";
    }
    markExtracted(
      db,
      row.id,
      {
        statement: outcome.statement,
        rationale: outcome.rationale,
        alternatives: outcome.alternatives,
        extractionSource: "llm",
      },
      opts.nowMs,
    );
    corroboratePhase(db, row.id, outcome.statement, opts);
    return "extracted";
  } catch {
    // Unparseable output is NOT a veto — the row stays pending and retries with
    // backoff. Treating garbage as rejection would silently discard real
    // decisions whenever a local model has a bad day.
    recordAttempt(db, row.id, opts.nowMs);
    return "failed";
  }
}

/** The five per-pass counters, folded across both model-backed queues. */
type PassTally = {
  extracted: number;
  vetoed: number;
  upgraded: number;
  failed: number;
  noModel: number;
};

/**
 * Drain ONE model-backed queue into `tally`.
 *
 * `successCounter` is the whole difference between the two queues: a pending
 * row the model extracts is an `extracted`; a snippet-sourced row the model
 * re-extracts is an `upgraded`. The no-model fallback follows from the same
 * distinction — `extractOne` has already written the snippet, so a PENDING row
 * genuinely became extracted this pass (counted in both `extracted` and
 * `noModel`, so `extracted` stays a true "rows extracted this pass" total
 * while `noModel` breaks out how many took the fallback), whereas an UPGRADE
 * row is still snippet-sourced and is therefore NOT an upgrade — only the
 * breakdown counter moves.
 */
async function runModelQueue(
  db: Database,
  rows: readonly DecisionRecord[],
  llm: DecisionLlm,
  opts: DecisionPassOptions,
  tally: PassTally,
  successCounter: "extracted" | "upgraded",
): Promise<void> {
  for (const row of rows) {
    const r = await extractOne(db, row, llm, opts);
    if (r === "extracted") tally[successCounter]++;
    else if (r === "no-model") {
      tally.noModel++;
      if (successCounter === "extracted") tally.extracted++;
    } else if (r === "vetoed") tally.vetoed++;
    else tally.failed++;
  }
}

export async function runDecisionPass(
  db: Database,
  opts: DecisionPassOptions,
): Promise<DecisionPassSummary> {
  const { scanned, discovered, discoveryComplete } = discoverPhase(db, opts);

  const tally: PassTally = { extracted: 0, vetoed: 0, upgraded: 0, failed: 0, noModel: 0 };

  const cooldownBefore = opts.nowMs - opts.retryCooldownMs;

  if (opts.useLlm && opts.llm !== undefined) {
    const llm = opts.llm;
    // Adaptive allocation, not a static split: over-fetch BOTH queues at the
    // full budget, then let either absorb the other's slack. A static split
    // (e.g. `min(RESERVE, budget-1)` upgrade / remainder pending) wastes
    // slots in either corner — a reserve bigger than the real upgrade
    // backlog leaves slots idle instead of falling back to pending, and a
    // reserve computed before the pending backlog is known can starve
    // pending even when upgrades have nothing to do. Mirrors
    // `glossary-extract.ts`'s `selectConsolidationWork`.
    const budget = passBudget(opts.maxLlmCalls);
    const pendingAll = selectPendingByPriority(db, budget, cooldownBefore);
    const upgradeAll = selectSnippetUpgrades(db, budget);

    // Reserve only as many upgrade slots as there are real upgrade
    // candidates, so a reserve with no work to do falls back to pending
    // instead of idling.
    const reserve = Math.min(UPGRADE_RESERVE, upgradeAll.length);
    const pendingTake = Math.min(pendingAll.length, Math.max(0, budget - reserve));
    const upgradeTake = Math.min(upgradeAll.length, budget - pendingTake);

    await runModelQueue(db, pendingAll.slice(0, pendingTake), llm, opts, tally, "extracted");
    await runModelQueue(db, upgradeAll.slice(0, upgradeTake), llm, opts, tally, "upgraded");
  } else {
    // `use_llm = false` (or no model wired). Every row here takes the snippet
    // fallback, so each one is BOTH an extraction and a no-model extraction —
    // the same both-counters convention the pending queue uses above. Counting
    // only `extracted` produced the exact outcome `noModel` exists to prevent:
    // `12 extracted, 0 upgraded, 0 no model`, from which a user concludes the
    // LLM ran and never learns every statement is a verbatim snippet.
    for (const row of selectPendingByPriority(db, passBudget(opts.maxLlmCalls), cooldownBefore)) {
      extractAsSnippet(db, row, opts);
      tally.extracted++;
      tally.noModel++;
    }
  }

  return { scanned, discovered, ...tally, discoveryComplete };
}

/**
 * Clears the store — vetoes included — and re-mines from scratch. The escape
 * hatch for the case veto durability otherwise creates: a veto is a judgement
 * by whatever local model was running, and without a reset an early or
 * misconfigured model would poison the store permanently.
 */
export async function rebuildDecisions(
  db: Database,
  opts: DecisionPassOptions,
): Promise<DecisionPassSummary> {
  clearDecisions(db);
  return await runDecisionPass(db, opts);
}

export { countByStatus } from "./decision-store.ts";
