import type { Database } from "bun:sqlite";

import type { ChatUnreadResult } from "./chat-unread-types.ts";
import { countUnreadSlackThreads, loadSlackSelfUserId } from "./slack-unread.ts";

export type { ChatUnreadResult, ChatUnreadThread } from "./chat-unread-types.ts";

/** The reader's signature, as the MB5 plan declares `ChatUnreadReader` (structurally identical). */
export type ChatUnreadReader = (
  db: Database,
  opts: { readonly nowMs: number; readonly limit: number },
) => ChatUnreadResult;

/**
 * The briefing's unread-chat reader (the MB4/MB5 seam): a thin adapter over `countUnreadSlackThreads`
 * that resolves the owner's Slack user id itself. When the id is not known yet, `countUnreadSlackThreads`
 * returns no threads and the marker counts, so the caller can say the id is unknown.
 *
 * `nowMs` is accepted for the seam and used for nothing today (a future age filter); no branch reads it.
 * `platform/assemble.ts` wires this as `readUnreadChat` once MB5's briefing runtime exists.
 */
export function readUnreadChatThreads(
  db: Database,
  opts: { readonly nowMs: number; readonly limit: number },
): ChatUnreadResult {
  return countUnreadSlackThreads(db, { selfUserId: loadSlackSelfUserId(db), limit: opts.limit });
}
