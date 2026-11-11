import type { Database } from "bun:sqlite";

import { readSlackSelfUserId } from "../connectors/slack-cursor.ts";
import { loadSchedulerState } from "../sync/scheduler-store.ts";
import type { ChatReadMarkerKind } from "./chat-read-marker-store.ts";
import type { ChatUnreadResult, ChatUnreadThread } from "./chat-unread-types.ts";

/**
 * Unread Slack threads for the morning briefing (Phase 10 MB4). READ ONLY: it never writes.
 *
 * A message counts as unread when its `ts` is newer than the owner's `last_read` for its channel
 * (`chat_read_marker`, kept by the Slack sync) and it is not the owner's own. Both are Slack's
 * fixed-width `^\d{10}\.\d{6}$` text, so the comparison is a TEXT compare (a REAL cast would lose
 * precision at 16 significant digits). The `ts` is not in the item metadata: it is the part of
 * `external_id` after the channel id (`<channel>:<ts>`; a channel id never contains `:`). A thread is
 * `coalesce(metadata.thread_ts, ts)`.
 *
 * Stated bounds: the sync indexes top-level messages and `thread_broadcast` replies only, so a thread
 * counts as unread when its parent or a broadcast is newer than `last_read`, never for a plain reply;
 * depth is the connector's 14-day window; a channel with no marker yet counts nothing and is listed in
 * `channelsWithoutMarker`.
 */

export type SlackUnreadResult = ChatUnreadResult & {
  /** Channels with indexed messages but no marker yet, de-duplicated and in code-unit order. */
  readonly channelsWithoutMarker: readonly string[];
};

export const DEFAULT_SLACK_UNREAD_LIMIT = 50;

const TS_GLOB = "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]";

// `metadata` is read through json_valid() so one malformed row never raises
// (see the sqlite-json-extract-raises-on-bad-json lesson). The keys are the ones
// `connectors/slack-sync.ts` writes: channel, user, thread_ts.
// lane-census: scope=message service=slack
const UNREAD_CTE = `
WITH msgs AS (
  SELECT id, title, url,
         substr(external_id, instr(external_id, ':') + 1) AS ts,
         CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.channel') END AS ch,
         CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.user') END AS usr,
         CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.thread_ts') END AS tts
  FROM item
  WHERE service = 'slack' AND type = 'message'
),
unread AS (
  SELECT m.id, m.title, m.url, m.ch, m.ts, coalesce(m.tts, m.ts) AS tkey, k.channel_kind
  FROM msgs m
  JOIN chat_read_marker k ON k.service = 'slack' AND k.channel_id = m.ch
  WHERE m.ts GLOB '${TS_GLOB}'
    AND m.ts > k.last_read_ts
    AND (m.usr IS NULL OR m.usr <> ?)
),
ranked AS (
  SELECT id, title, url, ch, ts, tkey, channel_kind,
         ROW_NUMBER() OVER (PARTITION BY ch, tkey ORDER BY ts DESC, id) AS rn,
         COUNT(*) OVER (PARTITION BY ch, tkey) AS cnt
  FROM unread
)`;

const THREADS_SQL = `${UNREAD_CTE}
SELECT id, title, url, ch, ts, tkey, channel_kind, cnt
FROM ranked
WHERE rn = 1
ORDER BY CASE WHEN channel_kind IN ('im', 'mpim') THEN 0 ELSE 1 END, ts DESC, ch, tkey
LIMIT ?`;

const TOTAL_SQL = `${UNREAD_CTE}
SELECT COUNT(*) AS n FROM ranked WHERE rn = 1`;

type ThreadRow = {
  id: string;
  title: string;
  url: string | null;
  ch: string;
  ts: string;
  tkey: string;
  channel_kind: ChatReadMarkerKind;
  cnt: number;
};

/** The briefing's three channel kinds from the marker's four Slack types. */
export function chatKindOf(kind: ChatReadMarkerKind): ChatUnreadThread["channelKind"] {
  switch (kind) {
    case "im":
      return "dm";
    case "mpim":
      return "mpim";
    case "public_channel":
    case "private_channel":
      return "channel";
  }
}

/** Slack `ts` text (guarded `^\d{10}\.\d{6}$`) to epoch ms: seconds x 1000 + the first 3 fraction digits. */
export function slackTsToMs(ts: string): number {
  return Number(ts.slice(0, 10)) * 1000 + Number(ts.slice(11, 14));
}

function markerStats(db: Database): {
  count: number;
  oldest: number | null;
  newest: number | null;
} {
  const row = db
    .query(
      `SELECT COUNT(*) AS n, MIN(captured_at) AS lo, MAX(captured_at) AS hi
       FROM chat_read_marker WHERE service = 'slack'`,
    )
    .get() as { n: number; lo: number | null; hi: number | null };
  return { count: row.n, oldest: row.lo, newest: row.hi };
}

// lane-census: scope=message service=slack
function channelsWithoutMarker(db: Database): string[] {
  const rows = db
    .query(
      `WITH msgs AS (
         SELECT CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.channel') END AS ch
         FROM item WHERE service = 'slack' AND type = 'message'
       )
       SELECT DISTINCT ch FROM msgs
       WHERE ch IS NOT NULL
         AND ch NOT IN (SELECT channel_id FROM chat_read_marker WHERE service = 'slack')
       ORDER BY ch`,
    )
    .all() as Array<{ ch: unknown }>;
  return rows.map((r) => String(r.ch));
}

/**
 * Counts the owner's unread Slack threads. `selfUserId` is the token's own user id (`loadSlackSelfUserId`);
 * null means unknown: nothing is counted (the owner's own messages must never read as unread) but the
 * marker statistics are still filled so the caller can say why.
 */
export function countUnreadSlackThreads(
  db: Database,
  opts: { selfUserId: string | null; limit?: number },
): SlackUnreadResult {
  const stats = markerStats(db);
  const base = {
    channelsWithMarker: stats.count,
    oldestMarkerCapturedAtMs: stats.oldest,
    newestMarkerCapturedAtMs: stats.newest,
    channelsWithoutMarker: channelsWithoutMarker(db),
  };
  if (opts.selfUserId === null) {
    return { ...base, totalThreads: 0, threads: [] };
  }
  const requested = opts.limit ?? DEFAULT_SLACK_UNREAD_LIMIT;
  const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
  const total = db.query(TOTAL_SQL).get(opts.selfUserId) as { n: number };
  const rows = db.query(THREADS_SQL).all(opts.selfUserId, limit) as ThreadRow[];
  const threads: ChatUnreadThread[] = rows.map((r) => ({
    itemId: r.id,
    channelId: r.ch,
    channelName: null,
    channelKind: chatKindOf(r.channel_kind),
    threadKey: r.tkey,
    latestTsMs: slackTsToMs(r.ts),
    title: r.title,
    url: r.url,
    unreadMessages: r.cnt,
  }));
  return { ...base, totalThreads: total.n, threads };
}

/** The Slack token's own user id as the last marker pass cached it in the scheduler cursor, or null. */
export function loadSlackSelfUserId(db: Database): string | null {
  return readSlackSelfUserId(loadSchedulerState(db, "slack")?.cursor ?? null);
}
