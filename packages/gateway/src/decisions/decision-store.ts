import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import type { SourceKind } from "../sources/source-kinds.ts";
import { type SourceMapping, sourceFilterSql } from "../sources/source-mapping.ts";
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
  scored_kind: string | null;
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
    scoredKind: r.scored_kind as SourceKind | null,
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

/**
 * The model-work queues' filter: a row whose source is no longer in the effective decisions set
 * is not sent to the model (it stays as it is and resumes if the type is mapped again). A row
 * whose source item is gone passes through, as before. Joined as `item i` on the record `d`.
 */
export function pendingWorkFilter(mapping: SourceMapping): { sql: string; params: string[] } {
  const f = sourceFilterSql(mapping.typesFor("decisions"), "i");
  return { sql: `(i.id IS NULL OR ${f.sql})`, params: f.params };
}

/**
 * The READ visibility rule for every user-facing decisions surface (`nimbus decisions`, its counts,
 * `nimbus negotiate`'s decisions lane, the `nimbus wow` selector): a row shows while its source's
 * `service:type` is in the effective decisions set. Two kinds of row show whatever the mapping
 * says — an owner-accepted `'agent'` decision (its source is a `nimbus:capture` item, which no
 * mapping can name, I28) and a row whose source item is gone (shown exactly as before mappings
 * existed). Nothing is deleted: re-including a type shows its rows again. Distinct from
 * {@link pendingWorkFilter}, which governs what the pass sends to the model and has no `'agent'`
 * arm (agent rows are never queued). Joined as `LEFT JOIN item i` on the record `d`.
 */
export function decisionVisibilityFilter(mapping: SourceMapping): {
  sql: string;
  params: string[];
} {
  const f = sourceFilterSql(mapping.typesFor("decisions"), "i");
  return {
    sql: `(d.extraction_source = 'agent' OR i.id IS NULL OR ${f.sql})`,
    params: f.params,
  };
}

export function selectPendingByPriority(
  db: Database,
  limit: number,
  cooldownBeforeMs: number,
  mapping: SourceMapping,
): DecisionRecord[] {
  const f = pendingWorkFilter(mapping);
  const rows = db
    .query(
      `SELECT d.* FROM decision_record d
         LEFT JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'pending' AND d.last_attempt_at <= ? AND ${f.sql}
        ORDER BY d.priority DESC, d.decided_at DESC, d.id ASC
        LIMIT ?`,
    )
    .all(cooldownBeforeMs, ...f.params, limit) as DecisionRow[];
  return hydrate(db, rows);
}

export function selectSnippetUpgrades(
  db: Database,
  limit: number,
  mapping: SourceMapping,
): DecisionRecord[] {
  const f = pendingWorkFilter(mapping);
  const rows = db
    .query(
      `SELECT d.* FROM decision_record d
         LEFT JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.extraction_source = 'snippet' AND ${f.sql}
        ORDER BY d.last_attempt_at ASC, d.id ASC
        LIMIT ?`,
    )
    .all(...f.params, limit) as DecisionRow[];
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
  /** The kind `confidence` was scored under (`null`: the source's type is not mapped). */
  scoredKind: SourceKind | null,
): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET confidence = ?, has_adr = ?, scored_kind = ?, stats_verified_at = ?, updated_at = ?
      WHERE id = ?`,
    [confidence, hasAdr ? 1 : 0, scoredKind, nowMs, nowMs, id],
  );
}

/**
 * `mapping` is REQUIRED, never defaulted: a default would let a user-facing read forget it and
 * silently show an excluded type's rows. `limit` counts VISIBLE rows (the filter is in the WHERE).
 */
export function listDecisions(
  db: Database,
  opts: { sinceMs: number; minConfidence: number; limit: number; mapping: SourceMapping },
): DecisionRecord[] {
  const f = decisionVisibilityFilter(opts.mapping);
  const rows = db
    .query(
      `SELECT d.* FROM decision_record d
         LEFT JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.decided_at >= ? AND d.confidence >= ? AND ${f.sql}
        ORDER BY d.decided_at DESC, d.id ASC
        LIMIT ?`,
    )
    .all(opts.sinceMs, opts.minConfidence, ...f.params, opts.limit) as DecisionRow[];
  return hydrate(db, rows);
}

/** Counts the rows {@link decisionVisibilityFilter} shows under `mapping` (required, as above). */
export function countByStatus(
  db: Database,
  mapping: SourceMapping,
): {
  total: number;
  pending: number;
  extracted: number;
  vetoed: number;
} {
  const f = decisionVisibilityFilter(mapping);
  const rows = db
    .query(
      `SELECT d.status AS status, COUNT(*) AS n FROM decision_record d
         LEFT JOIN item i ON i.id = d.source_item_id
        WHERE ${f.sql}
        GROUP BY d.status`,
    )
    .all(...f.params) as Array<{ status: string; n: number }>;
  const get = (s: string): number => rows.find((r) => r.status === s)?.n ?? 0;
  const pending = get("pending");
  const extracted = get("extracted");
  const vetoed = get("vetoed");
  return { total: pending + extracted + vetoed, pending, extracted, vetoed };
}

/** {@link countByStatus} over rows decided at or after `sinceMs` (the brief's window). */
export function countByStatusSince(
  db: Database,
  mapping: SourceMapping,
  sinceMs: number,
): { pending: number; extracted: number; vetoed: number } {
  const f = decisionVisibilityFilter(mapping);
  const rows = db
    .query(
      `SELECT d.status AS status, COUNT(*) AS n FROM decision_record d
         LEFT JOIN item i ON i.id = d.source_item_id
        WHERE d.decided_at >= ? AND ${f.sql}
        GROUP BY d.status`,
    )
    .all(sinceMs, ...f.params) as Array<{ status: string; n: number }>;
  const get = (s: string): number => rows.find((r) => r.status === s)?.n ?? 0;
  return { pending: get("pending"), extracted: get("extracted"), vetoed: get("vetoed") };
}

/** How many rows {@link listDecisions} would show with no limit. */
export function countShown(
  db: Database,
  opts: { sinceMs: number; minConfidence: number; mapping: SourceMapping },
): number {
  const f = decisionVisibilityFilter(opts.mapping);
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM decision_record d
         LEFT JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.decided_at >= ? AND d.confidence >= ? AND ${f.sql}`,
    )
    .get(opts.sinceMs, opts.minConfidence, ...f.params) as { n: number };
  return row.n;
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

/**
 * Used only by `--rebuild`. Clears vetoes too — that is the point of a rebuild. Owner-accepted
 * `'agent'` rows (and their evidence) SURVIVE: they are not derivable from the index, so a
 * rebuild could never re-mine them; revoking the capture is how they leave. The pass-state
 * watermark is still reset so every historical item is re-scanned, and the per-type catch-up
 * cursors go with it, so every type starts again from the run-start reconcile rules rather than
 * from a cursor that described the store just cleared.
 */
export function clearDecisions(db: Database): void {
  db.transaction(() => {
    dbRun(
      db,
      `DELETE FROM decision_evidence
        WHERE decision_id NOT IN (SELECT id FROM decision_record WHERE extraction_source = 'agent')`,
      [],
    );
    dbRun(db, "DELETE FROM decision_record WHERE extraction_source IS NOT 'agent'", []);
    dbRun(db, "DELETE FROM decision_pass_state", []);
    dbRun(db, "DELETE FROM source_catchup_state WHERE pass = 'decisions'", []);
  })();
}

export interface AgentDecisionInsert {
  readonly id: string; // `capture:<captureId>` — never collides with a mined (hashed) id
  readonly captureId: string;
  readonly sourceItemId: string; // the accepted capture's nimbus:capture item
  readonly statement: string;
  readonly rationale: string | null;
  readonly alternatives: readonly string[];
  readonly decidedAt: number;
  readonly evidence: readonly DecisionEvidence[];
  readonly nowMs: number;
}

/**
 * The ONLY writer of an `extraction_source = 'agent'` row (static D32(d): callable only from
 * `mcp-sink/capture-native.ts`). An owner-ACCEPTED capture, so it lands `extracted` at confidence
 * 1.0; `cue_tier`/`cue_text` are NOT NULL in the schema and carry a fixed, honest marker. The id
 * `capture:<captureId>` cannot collide with a mined (hashed) id, so a plain INSERT is right: a
 * collision would be a bug and must throw (rolling the accept back), not overwrite.
 */
export function insertAgentDecision(db: Database, d: AgentDecisionInsert): void {
  db.transaction(() => {
    dbRun(
      db,
      `INSERT INTO decision_record
         (id, source_item_id, status, statement, rationale, alternatives, extraction_source,
          cue_tier, cue_text, priority, confidence, decided_at, has_adr, stats_verified_at,
          attempts, last_attempt_at, updated_at, capture_id)
       VALUES (?, ?, 'extracted', ?, ?, ?, 'agent', 'explicit', 'agent capture', 0, 1, ?, 0, ?, 0, 0, ?, ?)`,
      [
        d.id,
        d.sourceItemId,
        d.statement,
        d.rationale,
        JSON.stringify([...d.alternatives]),
        d.decidedAt,
        d.nowMs,
        d.nowMs,
        d.captureId,
      ],
    );
    replaceEvidence(db, d.id, d.evidence);
  })();
}

export function agentDecisionOwned(db: Database, id: string, captureId: string): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM decision_record WHERE id = ? AND capture_id = ? AND extraction_source = 'agent'",
      )
      .get(id, captureId) !== null
  );
}

/** Revoke's inverse: deletes the row ONLY while this capture still owns it (spec § 5.3). */
export function deleteAgentDecision(db: Database, id: string, captureId: string): boolean {
  let deleted = false;
  db.transaction(() => {
    if (!agentDecisionOwned(db, id, captureId)) return;
    // Explicit, not left to the cascade: the cascade needs `foreign_keys = ON` on THIS connection.
    dbRun(db, "DELETE FROM decision_evidence WHERE decision_id = ?", [id]);
    deleted =
      dbRun(db, "DELETE FROM decision_record WHERE id = ? AND capture_id = ?", [id, captureId])
        .changes === 1;
  })();
  return deleted;
}

/** A revoked capture's item is gone: no evidence row may keep pointing at it (spec § 5.3). */
export function deleteEvidenceCitingItem(db: Database, itemId: string): number {
  return dbRun(db, "DELETE FROM decision_evidence WHERE item_id = ?", [itemId]).changes;
}
