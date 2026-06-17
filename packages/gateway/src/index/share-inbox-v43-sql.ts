/**
 * V43 (Phase 6 Slice 8d) — `share_inbox`: a single dual-purpose, recipient-pubkey-keyed table.
 *
 *   direction = 'pending'  → a sender-side forward awaiting a not-yet-paired recipient; the
 *                            first-successful-pair hook drains these to the newly-paired peer.
 *   direction = 'received' → an inbound, INERT forwarded share (viewable/replayable; never merged
 *                            into the index, never executed — receiving needs no HITL, spec §9.4).
 *
 * `share_json` is the full signed ShareFile (body + sig + forwarding envelope), so each row is a
 * self-contained artifact. `origin_label`/`hops` are denormalized for the attribution chip.
 * Append-only; manual prune only (mirrors share_records, spec §10).
 */
export const SHARE_INBOX_V43_SQL = `
CREATE TABLE IF NOT EXISTS share_inbox (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_pubkey  TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  direction         TEXT NOT NULL,
  share_json        TEXT NOT NULL,
  origin_label      TEXT NOT NULL,
  hops              INTEGER NOT NULL,
  received_at       INTEGER NOT NULL,
  status            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_inbox_unique
  ON share_inbox(recipient_pubkey, content_hash, direction);
CREATE INDEX IF NOT EXISTS idx_share_inbox_recipient ON share_inbox(recipient_pubkey);
CREATE INDEX IF NOT EXISTS idx_share_inbox_status ON share_inbox(status);
`;
