/**
 * V92 - Slack read markers (Phase 10 MB4, morning-briefing spec § 5.4).
 *
 * `chat_read_marker`: per (service, channel) the owner's `last_read` position as Slack reported it
 * the last time the marker pass asked (`conversations.info`). `last_read_ts` is Slack's fixed-width
 * `^\d{10}\.\d{6}$` text, compared as text. Written only by `index/chat-read-marker-store.ts` (static
 * D24 rule `chat-read-marker-confined`), through the `setChatReadMarkers` sync capability.
 *
 * No trigger: rows are not keyed by `item`, so MB1's `AFTER DELETE ON item` pattern would fire once per
 * message row of a removed connector. Cleanup is the capability's prune (channels the owner left) and
 * the two removal paths that delete a service's items (`LocalIndex.removeConnectorIndexData`,
 * `commands/data-delete.ts`).
 *
 * Backfill: none. No marker existed before this version.
 */
export const CHAT_READ_MARKER_V92_SQL = [
  `CREATE TABLE IF NOT EXISTS chat_read_marker (
  service TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind IN ('public_channel','private_channel','im','mpim')),
  last_read_ts TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (service, channel_id)
)`,
];
