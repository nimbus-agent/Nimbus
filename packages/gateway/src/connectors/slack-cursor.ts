import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

/**
 * The Slack syncable's cursor (`nimbus-slk1:` + base64url JSON). Split out of `slack-sync.ts` so the
 * index-side reader (`index/slack-unread.ts`) can read the cached own user id without a Slack handle.
 * `selfUserId`, `mkIdx` and `listPartial` (Phase 10 MB4) are optional on decode: an older cursor decodes with
 * `selfUserId: null`, `mkIdx: 0` and `listPartial: false`, and the prefix is unchanged (as `teamSubdomain` was added).
 */
export const SLACK_CURSOR_PREFIX = "nimbus-slk1:";

export type SlackSyncCursorV1 = {
  phase: "list" | "history";
  floorTs: string;
  ids: string[];
  nextIdx: number;
  hw: Record<string, string | null>;
  listCursor: string | null;
  histCursor: string | null;
  teamSubdomain: string | null;
  /** The token's own Slack user id (`auth.test`), refreshed by every marker pass. */
  selfUserId: string | null;
  /** Round-robin offset into the sorted channel ids for the read-marker pass. */
  mkIdx: number;
  /**
   * True when a `conversations.list` page of the current round was malformed (no `channels` array or
   * an entry with no id): the list is then incomplete and the marker pass must not prune.
   */
  listPartial: boolean;
};

export function encodeSlackCursor(c: SlackSyncCursorV1): string {
  return encodeNimbusJsonCursor(SLACK_CURSOR_PREFIX, c);
}

function slackDecodeHighWater(hw: unknown): Record<string, string | null> {
  const hwOut: Record<string, string | null> = {};
  if (hw === null || typeof hw !== "object" || Array.isArray(hw)) {
    return hwOut;
  }
  for (const [k, v] of Object.entries(hw as Record<string, unknown>)) {
    hwOut[k] = typeof v === "string" ? v : null;
  }
  return hwOut;
}

function slackStringIdArrayOk(ids: unknown): ids is string[] {
  return Array.isArray(ids) && ids.every((x) => typeof x === "string");
}

export function decodeSlackCursor(raw: string | null): SlackSyncCursorV1 | null {
  const rec = decodeNimbusJsonCursorObject(raw, SLACK_CURSOR_PREFIX);
  if (rec === null) {
    return null;
  }
  const phase = rec["phase"];
  const floorTs = rec["floorTs"];
  const ids = rec["ids"];
  const nextIdx = rec["nextIdx"];
  const hw = rec["hw"];
  if (phase !== "list" && phase !== "history") {
    return null;
  }
  if (typeof floorTs !== "string" || floorTs === "") {
    return null;
  }
  if (!slackStringIdArrayOk(ids)) {
    return null;
  }
  if (typeof nextIdx !== "number" || !Number.isInteger(nextIdx) || nextIdx < 0) {
    return null;
  }
  const listCursor = rec["listCursor"];
  const histCursor = rec["histCursor"];
  const teamSubdomain = rec["teamSubdomain"];
  const selfUserId = rec["selfUserId"];
  const mkIdx = rec["mkIdx"];
  const listPartial = rec["listPartial"];
  return {
    phase,
    floorTs,
    ids,
    nextIdx,
    hw: slackDecodeHighWater(hw),
    listCursor: typeof listCursor === "string" ? listCursor : null,
    histCursor: typeof histCursor === "string" ? histCursor : null,
    teamSubdomain: typeof teamSubdomain === "string" ? teamSubdomain : null,
    selfUserId: typeof selfUserId === "string" && selfUserId !== "" ? selfUserId : null,
    mkIdx: typeof mkIdx === "number" && Number.isInteger(mkIdx) && mkIdx >= 0 ? mkIdx : 0,
    listPartial: listPartial === true,
  };
}

/** The own user id a stored Slack cursor carries, or null (no cursor, a foreign one, none cached). */
export function readSlackSelfUserId(cursor: string | null): string | null {
  return decodeSlackCursor(cursor)?.selfUserId ?? null;
}
