import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import {
  type CaptureKind,
  type CaptureRow,
  type CaptureState,
  isCaptureKind,
  isCaptureState,
} from "./capture-types.ts";

/** How long a rejected capture's row is kept before `pruneRejected` deletes it (spec § 5.2). */
export const REJECTED_RETENTION_MS = 90 * 86_400_000;

export type NewCaptureRow = Omit<
  CaptureRow,
  "nativeRef" | "decidedAt" | "expiresAt" | "outcomeRef" | "errorCode"
>;

type RawRow = {
  id: string;
  kind: string;
  state: string;
  item_id: string | null;
  payload_json: string | null;
  payload_bytes: number;
  client_label: string | null;
  session_id: string;
  native_ref: string | null;
  created_at: number;
  decided_at: number | null;
};

function toRow(r: RawRow): CaptureRow {
  if (!isCaptureKind(r.kind) || !isCaptureState(r.state)) {
    throw new Error(`unrecognised capture row ${r.id}: kind=${r.kind} state=${r.state}`);
  }
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    itemId: r.item_id,
    payloadJson: r.payload_json,
    payloadBytes: r.payload_bytes,
    clientLabel: r.client_label,
    sessionId: r.session_id,
    nativeRef: r.native_ref,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    expiresAt: null,
    outcomeRef: null,
    errorCode: null,
  };
}

/**
 * The ONLY module that names the `capture` table at runtime (static rule D32(a), invariant I28).
 * Every state change is a guarded `UPDATE … WHERE state = <expected>` with a row-count check, so a
 * lost race refuses instead of double-applying.
 */
export class CaptureStore {
  constructor(private readonly db: Database) {}

  insert(row: NewCaptureRow): void {
    dbRun(
      this.db,
      `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.state,
        row.itemId,
        row.payloadJson,
        row.payloadBytes,
        row.clientLabel,
        row.sessionId,
        row.createdAt,
      ],
    );
  }

  get(id: string): CaptureRow | undefined {
    const r = this.db.query("SELECT * FROM capture WHERE id = ?").get(id) as RawRow | null;
    return r === null ? undefined : toRow(r);
  }

  list(filter: { state?: CaptureState; kind?: CaptureKind; limit: number }): CaptureRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.state !== undefined) {
      where.push("state = ?");
      args.push(filter.state);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    args.push(filter.limit);
    const rows = this.db
      .query(`SELECT * FROM capture ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args) as RawRow[];
    return rows.map(toRow);
  }

  countByState(state: CaptureState): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM capture WHERE state = ?").get(state) as {
      n: number;
    };
    return r.n;
  }

  countCreatedSince(sinceMs: number): number {
    const r = this.db
      .query("SELECT COUNT(*) AS n FROM capture WHERE created_at > ?")
      .get(sinceMs) as { n: number };
    return r.n;
  }

  stateOfItem(itemId: string): CaptureState | undefined {
    const r = this.db.query("SELECT state FROM capture WHERE item_id = ?").get(itemId) as {
      state: string;
    } | null;
    return r !== null && isCaptureState(r.state) ? r.state : undefined;
  }

  markRevoked(id: string, expected: CaptureState, nowMs: number): boolean {
    const res = dbRun(
      this.db,
      `UPDATE capture SET state = 'revoked', payload_json = NULL, item_id = NULL, decided_at = ?
       WHERE id = ? AND state = ?`,
      [nowMs, id, expected],
    );
    return res.changes === 1;
  }

  markAccepted(id: string, itemId: string, nativeRef: string, nowMs: number): boolean {
    return (
      dbRun(
        this.db,
        `UPDATE capture SET state = 'accepted', item_id = ?, native_ref = ?, decided_at = ?
         WHERE id = ? AND state = 'proposed'`,
        [itemId, nativeRef, nowMs, id],
      ).changes === 1
    );
  }

  markRejected(id: string, nowMs: number): boolean {
    return (
      dbRun(
        this.db,
        "UPDATE capture SET state = 'rejected', decided_at = ? WHERE id = ? AND state = 'proposed'",
        [nowMs, id],
      ).changes === 1
    );
  }

  countAcceptedWithNativeRef(nativeRef: string, excludingId: string): number {
    const r = this.db
      .query(
        "SELECT COUNT(*) AS n FROM capture WHERE state = 'accepted' AND native_ref = ? AND id <> ?",
      )
      .get(nativeRef, excludingId) as { n: number };
    return r.n;
  }

  pruneRejected(cutoffMs: number): number {
    return dbRun(
      this.db,
      "DELETE FROM capture WHERE state = 'rejected' AND COALESCE(decided_at, created_at) < ?",
      [cutoffMs],
    ).changes;
  }
}
