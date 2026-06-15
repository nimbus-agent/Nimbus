import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface ShareRecordInput {
  readonly contentHash: string;
  readonly kind: string;
  readonly sessionId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly redactionSet: readonly string[];
  readonly provenance: unknown;
  readonly bodyJson: string;
  readonly sigJson: string;
  readonly sink: string;
}

export interface ShareRecord extends Omit<ShareRecordInput, "redactionSet" | "provenance"> {
  readonly id: number;
  readonly redactionSet: readonly string[];
  readonly provenance: unknown;
}

export function insertShareRecord(db: Database, r: ShareRecordInput): void {
  dbRun(
    db,
    `INSERT INTO share_records
       (content_hash, kind, session_id, created_at, expires_at, redaction_set_json, provenance_json, body_json, sig_json, sink)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.contentHash,
      r.kind,
      r.sessionId,
      r.createdAt,
      r.expiresAt,
      JSON.stringify(r.redactionSet),
      JSON.stringify(r.provenance),
      r.bodyJson,
      r.sigJson,
      r.sink,
    ],
  );
}

type Row = {
  id: number;
  content_hash: string;
  kind: string;
  session_id: string | null;
  created_at: number;
  expires_at: number | null;
  redaction_set_json: string;
  provenance_json: string;
  body_json: string;
  sig_json: string;
  sink: string;
};

const map = (row: Row): ShareRecord => ({
  id: row.id,
  contentHash: row.content_hash,
  kind: row.kind,
  sessionId: row.session_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  redactionSet: JSON.parse(row.redaction_set_json) as string[],
  provenance: JSON.parse(row.provenance_json),
  bodyJson: row.body_json,
  sigJson: row.sig_json,
  sink: row.sink,
});

export function getShareRecord(db: Database, contentHash: string): ShareRecord | undefined {
  const row = db
    .query("SELECT * FROM share_records WHERE content_hash = ?")
    .get(contentHash) as Row | null;
  return row === null ? undefined : map(row);
}

export function listShareRecords(
  db: Database,
  opts: { now: number; includeExpired?: boolean; limit?: number },
): ShareRecord[] {
  const limit = opts.limit ?? 100;
  const rows = (
    opts.includeExpired === true
      ? db.query("SELECT * FROM share_records ORDER BY created_at DESC LIMIT ?").all(limit)
      : db
          .query(
            "SELECT * FROM share_records WHERE expires_at IS NULL OR expires_at >= ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(opts.now, limit)
  ) as Row[];
  return rows.map(map);
}

export function pruneExpiredShares(db: Database, now: number): number {
  const before = (
    db
      .query(
        "SELECT COUNT(*) AS c FROM share_records WHERE expires_at IS NOT NULL AND expires_at < ?",
      )
      .get(now) as { c: number }
  ).c;
  dbRun(db, "DELETE FROM share_records WHERE expires_at IS NOT NULL AND expires_at < ?", [now]);
  return before;
}
