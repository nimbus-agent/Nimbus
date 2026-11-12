/**
 * The shape of the morning briefing's unread-chat reader (Phase 10 MB4/MB5 seam). These types are
 * STRUCTURALLY IDENTICAL to the ones MB5 declares in `agents/_lib/briefing-types.ts`; neither slice
 * imports the other, TypeScript structural typing joins them at the one wiring line in
 * `platform/assemble.ts`. Re-exported from `chat-unread-query.ts`, the seam's public module.
 */
export type ChatUnreadThread = {
  readonly itemId: string;
  readonly channelId: string;
  /** The writer stores no channel name today, so this is null. */
  readonly channelName: string | null;
  readonly channelKind: "dm" | "mpim" | "channel";
  readonly threadKey: string;
  readonly latestTsMs: number;
  readonly title: string;
  readonly url: string | null;
  readonly unreadMessages: number;
};

export type ChatUnreadResult = {
  /** Unread threads before the cap. */
  readonly totalThreads: number;
  /** DMs and group DMs first, then newest first, at most `limit`. */
  readonly threads: readonly ChatUnreadThread[];
  readonly channelsWithMarker: number;
  readonly oldestMarkerCapturedAtMs: number | null;
  readonly newestMarkerCapturedAtMs: number | null;
};
