// packages/gateway/src/share/share-inbox-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { ShareFile } from "./share-format.ts";

/** Received rows are the local gateway's own inbox — keyed by this constant, not a peer pubkey. */
const RECEIVED_SELF = "@self";

export interface ShareInboxRow {
  readonly id: number;
  readonly recipientPubkey: string;
  readonly contentHash: string;
  readonly direction: "pending" | "received";
  readonly share: ShareFile;
  readonly originLabel: string;
  readonly hops: number;
  readonly receivedAt: number;
  readonly status: string;
}

interface RawRow {
  id: number;
  recipient_pubkey: string;
  content_hash: string;
  direction: string;
  share_json: string;
  origin_label: string;
  hops: number;
  received_at: number;
  status: string;
}

function toRow(r: RawRow): ShareInboxRow {
  return {
    id: r.id,
    recipientPubkey: r.recipient_pubkey,
    contentHash: r.content_hash,
    direction: r.direction === "pending" ? "pending" : "received",
    share: JSON.parse(r.share_json) as ShareFile,
    originLabel: r.origin_label,
    hops: r.hops,
    receivedAt: r.received_at,
    status: r.status,
  };
}

function insert(
  db: Database,
  p: {
    recipientPubkey: string;
    share: ShareFile;
    direction: "pending" | "received";
    status: string;
    now: number;
  },
): void {
  dbRun(
    db,
    `INSERT OR IGNORE INTO share_inbox
       (recipient_pubkey, content_hash, direction, share_json, origin_label, hops, received_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.recipientPubkey,
      p.share.contentHash,
      p.direction,
      JSON.stringify(p.share),
      p.share.body.origin.label,
      p.share.forwarding.hops,
      p.now,
      p.status,
    ],
  );
}

/** Queue a forward for a (possibly not-yet-paired) recipient, keyed by their pubkey. */
export function insertPendingForward(
  db: Database,
  p: { recipientPubkey: string; share: ShareFile; now: number },
): void {
  insert(db, { ...p, direction: "pending", status: "pending" });
}

/** Store an inbound forwarded share as an inert, viewable artifact in the local inbox. */
export function insertReceivedShare(db: Database, p: { share: ShareFile; now: number }): void {
  insert(db, { recipientPubkey: RECEIVED_SELF, ...p, direction: "received", status: "viewable" });
}

/** List the local inbox (received inert shares), newest first. */
export function listReceivedShares(db: Database, opts: { limit?: number }): ShareInboxRow[] {
  const limit = opts.limit ?? 200;
  const rows = db
    .query(
      `SELECT * FROM share_inbox WHERE direction = 'received' AND recipient_pubkey = ?
       ORDER BY received_at DESC LIMIT ?`,
    )
    .all(RECEIVED_SELF, limit) as RawRow[];
  return rows.map(toRow);
}

/** All still-pending forwards queued for a recipient pubkey (status 'pending'). */
export function drainPending(db: Database, recipientPubkey: string): ShareInboxRow[] {
  const rows = db
    .query(
      `SELECT * FROM share_inbox WHERE direction = 'pending' AND status = 'pending' AND recipient_pubkey = ?
       ORDER BY received_at ASC`,
    )
    .all(recipientPubkey) as RawRow[];
  return rows.map(toRow);
}

/** Mark a pending forward delivered (kept for audit; never re-drained). */
export function markDelivered(db: Database, id: number): void {
  dbRun(db, `UPDATE share_inbox SET status = 'delivered' WHERE id = ?`, [id]);
}
