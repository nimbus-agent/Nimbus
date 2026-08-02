import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import type {
  CueTier,
  DecisionEvidence,
  DecisionRecord,
  EvidenceKind,
  ExtractionSource,
} from "./decision-types.ts";

export interface CandidateInsert {
  readonly id: string;
  readonly sourceItemId: string;
  readonly cueTier: CueTier;
  readonly cueText: string;
  readonly priority: number;
  readonly decidedAt: number;
  readonly nowMs: number;
}

export interface PassState {
  readonly watermarkMs: number;
  readonly watermarkId: string;
  readonly lastPassAt: number | null;
  readonly lastPassNew: number;
  readonly scannedItems: number;
}

type DecisionRow = {
  id: string;
  source_item_id: string;
  status: string;
  statement: string | null;
  rationale: string | null;
  alternatives: string;
  extraction_source: string | null;
  cue_tier: string;
  cue_text: string;
  priority: number;
  confidence: number;
  decided_at: number;
  has_adr: number;
  attempts: number;
  last_attempt_at: number;
};

type EvidenceRow = {
  decision_id: string;
  kind: string;
  entity_id: string | null;
  item_id: string | null;
  evidence_key: string;
  label: string;
  url: string | null;
  occurred_at: number | null;
};

/**
 * The TOTAL row identity for `decision_evidence` (V47 `evidence_key`).
 *
 * Keying the table on `label` was data loss: labels are item titles, two
 * distinct PRs can share one, and the `INSERT OR REPLACE` below would keep
 * only the last. `entityId` and `itemId` are the natural identities but both
 * are nullable (`source`/`adr` evidence carries no entity id; a future
 * evidence kind may carry neither), so neither alone can be a NOT NULL key.
 *
 * The prefixes are load-bearing: without them a graph entity id that happened
 * to equal an item id would alias, and a label that happened to equal an id
 * would alias too. `label:` last is a deterministic fallback, not a
 * preference — it restores exactly the old collision behaviour for the one
 * case where nothing better exists.
 */
export function evidenceKey(e: DecisionEvidence): string {
  if (e.entityId !== null) return `entity:${e.entityId}`;
  if (e.itemId !== null) return `item:${e.itemId}`;
  return `label:${e.label}`;
}

function parseStringArray(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toRecord(r: DecisionRow, evidence: readonly DecisionEvidence[]): DecisionRecord {
  return {
    id: r.id,
    sourceItemId: r.source_item_id,
    status: r.status as DecisionRecord["status"],
    statement: r.statement,
    rationale: r.rationale,
    alternatives: parseStringArray(r.alternatives),
    extractionSource: r.extraction_source as ExtractionSource | null,
    cueTier: r.cue_tier as CueTier,
    cueText: r.cue_text,
    priority: r.priority,
    confidence: r.confidence,
    decidedAt: r.decided_at,
    hasAdr: r.has_adr === 1,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    evidence,
  };
}

function evidenceFor(db: Database, ids: readonly string[]): Map<string, DecisionEvidence[]> {
  const out = new Map<string, DecisionEvidence[]>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT * FROM decision_evidence WHERE decision_id IN (${ph})`)
    .all(...ids) as EvidenceRow[];
  for (const r of rows) {
    const list = out.get(r.decision_id) ?? [];
    list.push({
      kind: r.kind as EvidenceKind,
      entityId: r.entity_id,
      itemId: r.item_id,
      label: r.label,
      url: r.url,
      occurredAt: r.occurred_at,
    });
    out.set(r.decision_id, list);
  }
  return out;
}

function hydrate(db: Database, rows: DecisionRow[]): DecisionRecord[] {
  const ev = evidenceFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toRecord(r, ev.get(r.id) ?? []));
}

/**
 * Upsert, not insert. Re-scanning an unchanged item re-derives the same
 * content-based id, and this must not resurrect a `vetoed` row or reset an
 * `extracted` one — so the conflict clause touches only the mined fields.
 */
export function upsertCandidate(db: Database, c: CandidateInsert): void {
  dbRun(
    db,
    `INSERT INTO decision_record
       (id, source_item_id, status, cue_tier, cue_text, priority, decided_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cue_tier   = excluded.cue_tier,
       cue_text   = excluded.cue_text,
       priority   = excluded.priority,
       decided_at = excluded.decided_at,
       updated_at = excluded.updated_at`,
    [c.id, c.sourceItemId, c.cueTier, c.cueText, c.priority, c.decidedAt, c.nowMs],
  );
}

export function selectPendingByPriority(
  db: Database,
  limit: number,
  cooldownBeforeMs: number,
): DecisionRecord[] {
  const rows = db
    .query(
      `SELECT * FROM decision_record
        WHERE status = 'pending' AND last_attempt_at <= ?
        ORDER BY priority DESC, decided_at DESC, id ASC
        LIMIT ?`,
    )
    .all(cooldownBeforeMs, limit) as DecisionRow[];
  return hydrate(db, rows);
}

export function selectSnippetUpgrades(db: Database, limit: number): DecisionRecord[] {
  const rows = db
    .query(
      `SELECT * FROM decision_record
        WHERE status = 'extracted' AND extraction_source = 'snippet'
        ORDER BY last_attempt_at ASC, id ASC
        LIMIT ?`,
    )
    .all(limit) as DecisionRow[];
  return hydrate(db, rows);
}

export function markVetoed(db: Database, id: string, nowMs: number): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET status = 'vetoed', attempts = attempts + 1,
            last_attempt_at = ?, updated_at = ?
      WHERE id = ?`,
    [nowMs, nowMs, id],
  );
}

export function markExtracted(
  db: Database,
  id: string,
  fields: {
    statement: string;
    rationale: string | null;
    alternatives: readonly string[];
    extractionSource: ExtractionSource;
  },
  nowMs: number,
): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET status = 'extracted', statement = ?, rationale = ?, alternatives = ?,
            extraction_source = ?, attempts = attempts + 1,
            last_attempt_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      fields.statement,
      fields.rationale,
      JSON.stringify([...fields.alternatives]),
      fields.extractionSource,
      nowMs,
      nowMs,
      id,
    ],
  );
}

/** Records a failed attempt without changing status — the backoff input. */
export function recordAttempt(db: Database, id: string, nowMs: number): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
      WHERE id = ?`,
    [nowMs, nowMs, id],
  );
}

export function replaceEvidence(db: Database, id: string, ev: readonly DecisionEvidence[]): void {
  db.transaction(() => {
    dbRun(db, "DELETE FROM decision_evidence WHERE decision_id = ?", [id]);
    for (const e of ev) {
      dbRun(
        db,
        `INSERT OR REPLACE INTO decision_evidence
           (decision_id, kind, entity_id, item_id, evidence_key, label, url, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, e.kind, e.entityId, e.itemId, evidenceKey(e), e.label, e.url, e.occurredAt],
      );
    }
  })();
}

export function setConfidence(
  db: Database,
  id: string,
  confidence: number,
  hasAdr: boolean,
  nowMs: number,
): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET confidence = ?, has_adr = ?, stats_verified_at = ?, updated_at = ?
      WHERE id = ?`,
    [confidence, hasAdr ? 1 : 0, nowMs, nowMs, id],
  );
}

export function listDecisions(
  db: Database,
  opts: { sinceMs: number; minConfidence: number; limit: number },
): DecisionRecord[] {
  const rows = db
    .query(
      `SELECT * FROM decision_record
        WHERE status = 'extracted' AND decided_at >= ? AND confidence >= ?
        ORDER BY decided_at DESC, id ASC
        LIMIT ?`,
    )
    .all(opts.sinceMs, opts.minConfidence, opts.limit) as DecisionRow[];
  return hydrate(db, rows);
}

export function countByStatus(db: Database): {
  total: number;
  pending: number;
  extracted: number;
  vetoed: number;
} {
  const rows = db
    .query("SELECT status, COUNT(*) AS n FROM decision_record GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const get = (s: string): number => rows.find((r) => r.status === s)?.n ?? 0;
  const pending = get("pending");
  const extracted = get("extracted");
  const vetoed = get("vetoed");
  return { total: pending + extracted + vetoed, pending, extracted, vetoed };
}

export function readPassState(db: Database): PassState {
  const r = db.query("SELECT * FROM decision_pass_state WHERE id = 1").get() as {
    watermark_ms: number;
    watermark_id: string;
    last_pass_at: number | null;
    last_pass_new: number;
    scanned_items: number;
  } | null;
  if (r === null) {
    return {
      watermarkMs: 0,
      watermarkId: "",
      lastPassAt: null,
      lastPassNew: 0,
      scannedItems: 0,
    };
  }
  return {
    watermarkMs: r.watermark_ms,
    watermarkId: r.watermark_id,
    lastPassAt: r.last_pass_at,
    lastPassNew: r.last_pass_new,
    scannedItems: r.scanned_items,
  };
}

export function writePassState(db: Database, s: PassState): void {
  dbRun(
    db,
    `INSERT INTO decision_pass_state
       (id, watermark_ms, watermark_id, last_pass_at, last_pass_new, scanned_items)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       watermark_ms  = excluded.watermark_ms,
       watermark_id  = excluded.watermark_id,
       last_pass_at  = excluded.last_pass_at,
       last_pass_new = excluded.last_pass_new,
       scanned_items = excluded.scanned_items`,
    [s.watermarkMs, s.watermarkId, s.lastPassAt, s.lastPassNew, s.scannedItems],
  );
}

/** Used only by `--rebuild`. Clears vetoes too — that is the point of a rebuild. */
export function clearDecisions(db: Database): void {
  db.transaction(() => {
    dbRun(db, "DELETE FROM decision_evidence", []);
    dbRun(db, "DELETE FROM decision_record", []);
    dbRun(db, "DELETE FROM decision_pass_state", []);
  })();
}
