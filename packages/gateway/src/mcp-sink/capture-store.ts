import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import {
  type CaptureKind,
  type CaptureRow,
  type CaptureState,
  isCaptureKind,
  isCaptureState,
} from "./capture-types.ts";

/**
 * How long a FINISHED capture row — a rejected proposal, or an action that was rejected, expired,
 * executed or failed — is kept after its decision before `pruneFinished` deletes it (spec § 5.2).
 * A live note, an accepted capture and a revoked row are never pruned.
 */
export const FINISHED_RETENTION_MS = 90 * 86_400_000;

export type CaptureListOrder = "asc" | "desc";

/** Fixed SQL per order — never composed from a caller's string. */
const LIST_ORDER_SQL: Readonly<Record<CaptureListOrder, string>> = {
  asc: "created_at ASC, id ASC",
  desc: "created_at DESC, id DESC",
};

export type NewCaptureRow = Omit<
  CaptureRow,
  "nativeRef" | "decidedAt" | "outcomeRef" | "errorCode"
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
  expires_at: number | null;
  outcome_ref: string | null;
  error_code: string | null;
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
    expiresAt: r.expires_at,
    outcomeRef: r.outcome_ref,
    errorCode: r.error_code,
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
      `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.expiresAt,
      ],
    );
  }

  get(id: string): CaptureRow | undefined {
    const r = this.db.query("SELECT * FROM capture WHERE id = ?").get(id) as RawRow | null;
    return r === null ? undefined : toRow(r);
  }

  /** Newest first by default; `order: "asc"` (oldest first) is what a batch accept drains by. */
  list(filter: {
    state?: CaptureState;
    kind?: CaptureKind;
    limit: number;
    order?: CaptureListOrder;
  }): CaptureRow[] {
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
      .query(
        `SELECT * FROM capture ${clause} ORDER BY ${LIST_ORDER_SQL[filter.order ?? "desc"]} LIMIT ?`,
      )
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

  /** Unexpired proposed actions. `expires_at = now` is EXPIRED (Review Focus 2). */
  countPendingActions(nowMs: number): number {
    return (
      this.db
        .query(
          "SELECT COUNT(*) AS n FROM capture WHERE kind = 'action' AND state = 'proposed' AND expires_at > ?",
        )
        .get(nowMs) as { n: number }
    ).n;
  }

  countPendingActionsExpiringBy(nowMs: number, byMs: number): number {
    return (
      this.db
        .query(
          "SELECT COUNT(*) AS n FROM capture WHERE kind = 'action' AND state = 'proposed' AND expires_at > ? AND expires_at <= ?",
        )
        .get(nowMs, byMs) as { n: number }
    ).n;
  }

  /** Proposed decision/term/link rows — the queue `max_pending` bounds (spec § 7 step 8). */
  countPendingNative(): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM capture WHERE kind <> 'action' AND state = 'proposed'")
        .get() as { n: number }
    ).n;
  }

  dueActionIds(nowMs: number): string[] {
    return (
      this.db
        .query(
          "SELECT id FROM capture WHERE kind = 'action' AND state = 'proposed' AND expires_at <= ? ORDER BY id",
        )
        .all(nowMs) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  /** Expire every due proposed action. Run INSIDE the caller's transaction (it audits per id). */
  expireDueActions(nowMs: number): string[] {
    const ids = this.dueActionIds(nowMs);
    if (ids.length === 0) return ids;
    const changed = dbRun(
      this.db,
      `UPDATE capture SET state = 'expired', decided_at = ?
       WHERE kind = 'action' AND state = 'proposed' AND expires_at <= ?`,
      [nowMs, nowMs],
    ).changes;
    if (changed !== ids.length) {
      throw new Error(
        `expireDueActions: expired ${String(changed)} rows, expected ${String(ids.length)}`,
      );
    }
    return ids;
  }

  /** The CAS of spec § 8 step 5: the expiry predicate closes the window across the re-check await. */
  claimAction(id: string, nowMs: number): boolean {
    return (
      dbRun(
        this.db,
        `UPDATE capture SET state = 'executing', decided_at = ?
       WHERE id = ? AND kind = 'action' AND state = 'proposed' AND expires_at > ?`,
        [nowMs, id, nowMs],
      ).changes === 1
    );
  }

  finalizeAction(
    id: string,
    state: "executed" | "failed" | "rejected",
    f: { readonly outcomeRef?: string; readonly errorCode?: string },
    nowMs: number,
  ): boolean {
    return (
      dbRun(
        this.db,
        `UPDATE capture SET state = ?, outcome_ref = ?, error_code = ?, decided_at = ?
       WHERE id = ? AND kind = 'action' AND state = 'executing'`,
        [state, f.outcomeRef ?? null, f.errorCode ?? null, nowMs, id],
      ).changes === 1
    );
  }

  interruptedActionIds(): string[] {
    return (
      this.db
        .query("SELECT id FROM capture WHERE kind = 'action' AND state = 'executing' ORDER BY id")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
  }

  /** Boot reconcile: `executing` survived a restart → `failed`, never back to `proposed`. */
  failInterruptedActions(nowMs: number): string[] {
    const ids = this.interruptedActionIds();
    if (ids.length === 0) return ids;
    dbRun(
      this.db,
      `UPDATE capture SET state = 'failed', error_code = 'ERR_ACTION_INTERRUPTED', decided_at = ?
       WHERE kind = 'action' AND state = 'executing'`,
      [nowMs],
    );
    return ids;
  }

  pruneFinished(cutoffMs: number): number {
    return dbRun(
      this.db,
      `DELETE FROM capture WHERE state IN ('rejected', 'expired', 'executed', 'failed')
       AND COALESCE(decided_at, created_at) < ?`,
      [cutoffMs],
    ).changes;
  }

  /**
   * The owner's purge of one FINISHED action row (`captures.purge`): guarded on the state the
   * caller just read, so a row that moved on since is left alone and the caller reports the race.
   */
  deleteFinishedAction(id: string, expected: CaptureState): boolean {
    return (
      dbRun(
        this.db,
        `DELETE FROM capture WHERE id = ? AND kind = 'action' AND state = ?
         AND state IN ('executed', 'failed', 'rejected', 'expired')`,
        [id, expected],
      ).changes === 1
    );
  }
}
