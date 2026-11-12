import type { Database } from "bun:sqlite";

import { dbRun, dbStmtRun } from "../db/write.ts";

/**
 * Chat read markers (V92, Phase 10 MB4). The ONLY writer of `chat_read_marker` (static D24 rule
 * `chat-read-marker-confined`); a syncable reaches it through the `setChatReadMarkers` capability,
 * which binds the service. The removal paths (`LocalIndex.removeConnectorIndexData`,
 * `commands/data-delete.ts`) call `deleteChatReadMarkersForService`. Reads are unrestricted.
 */
export const CHAT_READ_MARKER_SERVICES = ["slack"] as const;
export type ChatReadMarkerService = (typeof CHAT_READ_MARKER_SERVICES)[number];

export const CHAT_READ_MARKER_KINDS = ["public_channel", "private_channel", "im", "mpim"] as const;
export type ChatReadMarkerKind = (typeof CHAT_READ_MARKER_KINDS)[number];

/** A bug guard far above the 100 channels one pass attempts. */
export const CHAT_READ_MARKER_MAX = 1000;

const CHANNEL_ID_RE = /^[A-Za-z0-9]{1,32}$/;
const SLACK_TS_RE = /^\d{10}\.\d{6}$/;

export interface ChatReadMarkerInput {
  readonly channelId: string;
  readonly channelKind: ChatReadMarkerKind;
  /** Slack's `last_read`, fixed-width `^\d{10}\.\d{6}$`; `"0000000000.000000"` is never read. */
  readonly lastReadTs: string;
}

export interface ChatReadMarkerSetOptions {
  /**
   * When present, this service's markers whose channel is NOT listed are deleted in the same
   * transaction (`[]` deletes them all). Absent prunes nothing.
   */
  readonly keepChannelIds?: readonly string[];
}

export interface ChatReadMarkerRow {
  readonly channelId: string;
  readonly channelKind: ChatReadMarkerKind;
  readonly lastReadTs: string;
  readonly capturedAt: number;
}

export function isChatReadMarkerService(service: string): service is ChatReadMarkerService {
  return (CHAT_READ_MARKER_SERVICES as readonly string[]).includes(service);
}

function isValidMarker(m: unknown): m is ChatReadMarkerInput {
  if (m === null || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  return (
    typeof r["channelId"] === "string" &&
    CHANNEL_ID_RE.test(r["channelId"]) &&
    typeof r["channelKind"] === "string" &&
    (CHAT_READ_MARKER_KINDS as readonly string[]).includes(r["channelKind"]) &&
    typeof r["lastReadTs"] === "string" &&
    SLACK_TS_RE.test(r["lastReadTs"])
  );
}

/**
 * Upserts the valid markers (a later entry for the same channel wins; a marker may move BACKWARD,
 * since the owner can mark a channel unread) and, when `opts.keepChannelIds` is given, prunes this
 * service's other markers, in ONE transaction. An invalid marker is skipped and counted, never stored.
 * `captured_at` is `nowMs`, never supplied by the caller.
 */
export function setChatReadMarkerRows(
  db: Database,
  service: string,
  markers: readonly ChatReadMarkerInput[],
  opts: ChatReadMarkerSetOptions | undefined,
  nowMs: number,
): { stored: number; skipped: number; pruned: number } {
  if (!isChatReadMarkerService(service)) {
    throw new Error(`chat read markers are not kept for service "${service}"`);
  }
  if (markers.length > CHAT_READ_MARKER_MAX) {
    throw new Error(`a marker pass stores at most ${String(CHAT_READ_MARKER_MAX)} markers`);
  }
  const valid = new Map<string, ChatReadMarkerInput>();
  let skipped = 0;
  for (const m of markers as readonly unknown[]) {
    if (isValidMarker(m)) {
      valid.set(m.channelId, m);
    } else {
      skipped += 1;
    }
  }
  const upsert = db.query(
    `INSERT INTO chat_read_marker (service, channel_id, channel_kind, last_read_ts, captured_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (service, channel_id) DO UPDATE SET
       channel_kind = excluded.channel_kind,
       last_read_ts = excluded.last_read_ts,
       captured_at = excluded.captured_at`,
  );
  try {
    return db.transaction(() => {
      for (const m of valid.values()) {
        dbStmtRun(upsert, service, m.channelId, m.channelKind, m.lastReadTs, nowMs);
      }
      let pruned = 0;
      if (opts?.keepChannelIds !== undefined) {
        const res = dbRun(
          db,
          `DELETE FROM chat_read_marker
           WHERE service = ? AND channel_id NOT IN (SELECT value FROM json_each(?))`,
          [service, JSON.stringify(opts.keepChannelIds)],
        );
        pruned = res.changes;
      }
      return { stored: valid.size, skipped, pruned };
    })();
  } finally {
    upsert.finalize();
  }
}

/** Removes every marker of one service (connector removal, `nimbus data delete`). Returns the count. */
export function deleteChatReadMarkersForService(db: Database, service: string): number {
  return dbRun(db, "DELETE FROM chat_read_marker WHERE service = ?", [service]).changes;
}

export function listChatReadMarkers(db: Database, service: string): ChatReadMarkerRow[] {
  const rows = db
    .query(
      `SELECT channel_id, channel_kind, last_read_ts, captured_at FROM chat_read_marker
       WHERE service = ? ORDER BY channel_id`,
    )
    .all(service) as Array<{
    channel_id: string;
    channel_kind: ChatReadMarkerKind;
    last_read_ts: string;
    captured_at: number;
  }>;
  return rows.map((r) => ({
    channelId: r.channel_id,
    channelKind: r.channel_kind,
    lastReadTs: r.last_read_ts,
    capturedAt: r.captured_at,
  }));
}
