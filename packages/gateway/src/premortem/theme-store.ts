import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { normalizeThemeLabel, themeConfidence, themeId } from "./theme-identity.ts";

export type PremortemTheme = {
  id: string;
  service: string;
  label: string;
  status: "extracted" | "demoted";
  confidence: number;
  evidenceCount: number;
  lastSeenAt: number;
};

export type ThemeEvidenceInput = {
  itemId: string;
  evidenceKey: string;
  label: string;
  url?: string;
  occurredAt?: number;
};

/**
 * Insert-or-accumulate on `(service, normalized label)`. Evidence rows carry a
 * composite primary key, so re-supplying one is a no-op rather than a duplicate
 * — which is what keeps confidence honest across repeated passes.
 */
export function upsertTheme(
  db: Database,
  input: {
    service: string;
    label: string;
    nowMs: number;
    evidence: readonly ThemeEvidenceInput[];
  },
): string {
  const id = themeId(input.service, input.label);
  const normalized = normalizeThemeLabel(input.label);

  dbRun(
    db,
    `INSERT INTO premortem_theme
       (id, service, label, normalized, status, confidence, first_seen_at, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, 'extracted', 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status       = 'extracted',
       last_seen_at = excluded.last_seen_at,
       updated_at   = excluded.updated_at`,
    [id, input.service, input.label, normalized, input.nowMs, input.nowMs, input.nowMs],
  );

  for (const e of input.evidence) {
    dbRun(
      db,
      `INSERT OR IGNORE INTO premortem_theme_evidence
         (theme_id, item_id, evidence_key, label, url, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, e.itemId, e.evidenceKey, e.label, e.url ?? null, e.occurredAt ?? null],
    );
  }

  // Recompute from the stored count so confidence reflects total corroboration,
  // never just this pass's contribution.
  const row = db
    .query(`SELECT COUNT(*) AS n FROM premortem_theme_evidence WHERE theme_id = ?`)
    .get(id) as { n: number };
  dbRun(db, `UPDATE premortem_theme SET confidence = ? WHERE id = ?`, [themeConfidence(row.n), id]);

  return id;
}

export function themesForServices(db: Database, services: readonly string[]): PremortemTheme[] {
  if (services.length === 0) {
    return [];
  }
  // I9: one bound placeholder per service; the list is never interpolated.
  const placeholders = services.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT t.id, t.service, t.label, t.status, t.confidence, t.last_seen_at,
              (SELECT COUNT(*) FROM premortem_theme_evidence e WHERE e.theme_id = t.id) AS n
         FROM premortem_theme t
        WHERE t.status = 'extracted' AND t.service IN (${placeholders})
        ORDER BY t.confidence DESC, t.label ASC`,
    )
    .all(...services) as Array<{
    id: string;
    service: string;
    label: string;
    status: string;
    confidence: number;
    last_seen_at: number;
    n: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    service: r.service,
    label: r.label,
    status: r.status === "demoted" ? "demoted" : "extracted",
    confidence: r.confidence,
    evidenceCount: r.n,
    lastSeenAt: r.last_seen_at,
  }));
}

export function readPassState(db: Database): { watermarkMs: number; watermarkId: string } {
  const row = db
    .query(`SELECT watermark_ms, watermark_id FROM premortem_pass_state WHERE id = 1`)
    .get() as { watermark_ms: number; watermark_id: string } | undefined;
  return { watermarkMs: row?.watermark_ms ?? 0, watermarkId: row?.watermark_id ?? "" };
}

export function writePassState(
  db: Database,
  s: {
    watermarkMs: number;
    watermarkId: string;
    nowMs: number;
    newThemes: number;
    scanned: number;
  },
): void {
  dbRun(
    db,
    `UPDATE premortem_pass_state
        SET watermark_ms = ?, watermark_id = ?, last_pass_at = ?,
            last_pass_new = ?, scanned_items = ?
      WHERE id = 1`,
    [s.watermarkMs, s.watermarkId, s.nowMs, s.newThemes, s.scanned],
  );
}

/**
 * Delete evidence whose source item has left the index, and recompute the
 * confidence of every theme that lost a row.
 *
 * There is no foreign key from `premortem_theme_evidence.item_id` to `item(id)`
 * — items are synced and pruned dynamically — so without this sweep dead rows
 * accumulate forever behind every removed item. It also keeps confidence
 * honest: corroboration the user can no longer inspect should not still be
 * counted toward it.
 *
 * KNOWN LIMIT, accepted deliberately: an item that is pruned and later
 * re-synced UNCHANGED keeps its original `modified_at`, so it lands behind the
 * watermark and is never re-mined — its evidence does not come back, and the
 * theme's confidence stays permanently lower. The alternative (keeping dead
 * rows forever so a hypothetical restore works) overstates corroboration in
 * the common case to protect the rare one.
 */
export function pruneOrphanedEvidence(db: Database): number {
  const orphans = db
    .query(
      `SELECT e.theme_id AS theme_id, e.evidence_key AS evidence_key
         FROM premortem_theme_evidence e
        WHERE NOT EXISTS (SELECT 1 FROM item i WHERE i.id = e.item_id)`,
    )
    .all() as Array<{ theme_id: string; evidence_key: string }>;
  if (orphans.length === 0) {
    return 0;
  }

  const touched = new Set<string>();
  for (const o of orphans) {
    dbRun(db, `DELETE FROM premortem_theme_evidence WHERE theme_id = ? AND evidence_key = ?`, [
      o.theme_id,
      o.evidence_key,
    ]);
    touched.add(o.theme_id);
  }

  for (const themeIdValue of touched) {
    const row = db
      .query(`SELECT COUNT(*) AS n FROM premortem_theme_evidence WHERE theme_id = ?`)
      .get(themeIdValue) as { n: number };
    dbRun(db, `UPDATE premortem_theme SET confidence = ? WHERE id = ?`, [
      themeConfidence(row.n),
      themeIdValue,
    ]);
  }
  return orphans.length;
}

/**
 * Demote — never delete — a theme whose every source item has left the index.
 * The row is the durable record of extraction budget already spent; deleting it
 * would re-mine the identical theme on the next pass.
 */
export function demoteThemesWithNoLiveEvidence(db: Database, nowMs: number): number {
  const stale = db
    .query(
      `SELECT t.id FROM premortem_theme t
        WHERE t.status = 'extracted'
          AND NOT EXISTS (
            SELECT 1 FROM premortem_theme_evidence e
              JOIN item i ON i.id = e.item_id
             WHERE e.theme_id = t.id
          )`,
    )
    .all() as Array<{ id: string }>;
  for (const s of stale) {
    dbRun(db, `UPDATE premortem_theme SET status = 'demoted', updated_at = ? WHERE id = ?`, [
      nowMs,
      s.id,
    ]);
  }
  return stale.length;
}
