import type { Database } from "bun:sqlite";
import { decisionRowId, mineCues } from "./cue-mining.ts";
import { computeConfidence, computePriority } from "./decision-confidence.ts";
import { corroborate, hasAdrEvidence } from "./decision-corroborate.ts";
import { type DecisionLlm, extractDecision } from "./decision-llm-adapter.ts";
import { decisionSourceFilter } from "./decision-source-types.ts";
import {
  clearDecisions,
  countByStatus,
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

const SCAN_BATCH_LIMIT = 5000;

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
  readonly minConfidence: number;
  readonly retryCooldownMs: number;
  readonly llm?: DecisionLlm;
}

export interface DecisionPassSummary {
  readonly scanned: number;
  readonly discovered: number;
  readonly extracted: number;
  readonly vetoed: number;
  readonly upgraded: number;
  readonly failed: number;
}

type ScanRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  modified_at: number;
};

function scanDelta(db: Database, cursor: { watermarkMs: number; watermarkId: string }): ScanRow[] {
  const { sql, params } = decisionSourceFilter();
  return db
    .query(
      `SELECT i.id, i.service, i.type, i.title, i.body_preview, i.modified_at
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
      SCAN_BATCH_LIMIT,
    ) as ScanRow[];
}

function scanText(r: ScanRow): string {
  return `${r.title}. ${r.body_preview ?? ""}`.trim();
}

/**
 * Phase A — discover. Pure SQL + regex, committed before any model call, and
 * the watermark advances HERE. Candidates are durable `pending` rows the moment
 * this returns, so an interrupted Phase B costs one in-flight call rather than
 * a full re-scan.
 */
function discoverPhase(
  db: Database,
  opts: DecisionPassOptions,
): { scanned: number; discovered: number } {
  const state = readPassState(db);
  const rows = scanDelta(db, state);
  if (rows.length === 0) return { scanned: 0, discovered: 0 };

  let discovered = 0;
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
        discovered++;
      }
    }
    const last = rows[rows.length - 1];
    if (last !== undefined) {
      writePassState(db, {
        watermarkMs: last.modified_at,
        watermarkId: last.id,
        lastPassAt: opts.nowMs,
        lastPassNew: discovered,
        scannedItems: state.scannedItems + rows.length,
      });
    }
  })();

  return { scanned: rows.length, discovered };
}

function serviceTypeOf(db: Database, itemId: string): string {
  const r = db.query("SELECT service, type FROM item WHERE id = ?").get(itemId) as {
    service: string;
    type: string;
  } | null;
  return r === null ? "unknown:unknown" : `${r.service}:${r.type}`;
}

function sentenceContext(db: Database, itemId: string): string {
  const r = db.query("SELECT title, body_preview FROM item WHERE id = ?").get(itemId) as {
    title: string;
    body_preview: string | null;
  } | null;
  return r === null ? "" : `${r.title}. ${r.body_preview ?? ""}`.trim();
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
): Promise<"extracted" | "vetoed" | "failed"> {
  const sentence = sentenceFor(db, row);
  try {
    const outcome = await extractDecision(llm, sentence, sentenceContext(db, row.sourceItemId));
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

export async function runDecisionPass(
  db: Database,
  opts: DecisionPassOptions,
): Promise<DecisionPassSummary> {
  const { scanned, discovered } = discoverPhase(db, opts);

  let extracted = 0;
  let vetoed = 0;
  let upgraded = 0;
  let failed = 0;

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
    const budget = Number.isFinite(opts.maxLlmCalls)
      ? Math.max(0, Math.trunc(opts.maxLlmCalls))
      : 0;
    const pendingAll = selectPendingByPriority(db, budget, cooldownBefore);
    const upgradeAll = selectSnippetUpgrades(db, budget);

    // Reserve only as many upgrade slots as there are real upgrade
    // candidates, so a reserve with no work to do falls back to pending
    // instead of idling.
    const reserve = Math.min(UPGRADE_RESERVE, upgradeAll.length);
    const pendingTake = Math.min(pendingAll.length, Math.max(0, budget - reserve));
    const upgradeTake = Math.min(upgradeAll.length, budget - pendingTake);

    for (const row of pendingAll.slice(0, pendingTake)) {
      const r = await extractOne(db, row, llm, opts);
      if (r === "extracted") extracted++;
      else if (r === "vetoed") vetoed++;
      else failed++;
    }
    for (const row of upgradeAll.slice(0, upgradeTake)) {
      const r = await extractOne(db, row, llm, opts);
      if (r === "extracted") upgraded++;
      else if (r === "vetoed") vetoed++;
      else failed++;
    }
  } else {
    for (const row of selectPendingByPriority(db, opts.maxLlmCalls, cooldownBefore)) {
      extractAsSnippet(db, row, opts);
      extracted++;
    }
  }

  return { scanned, discovered, extracted, vetoed, upgraded, failed };
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

export { countByStatus };
