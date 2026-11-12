import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { decodeSlackCursor, encodeSlackCursor, type SlackSyncCursorV1 } from "./slack-cursor.ts";
import { refreshSlackReadMarkers } from "./slack-read-markers.ts";
import { slackWebApi } from "./slack-web-api.ts";
import { shortIndexedMessageTitleFromPreview } from "./sync-message-preview-title.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "slack";
function slackTsFromMs(ms: number): string {
  return (ms / 1000).toFixed(6);
}

function permalink(teamSub: string | null, channel: string, ts: string): string | null {
  const compact = ts.replace(".", "");
  if (teamSub !== null && teamSub !== "") {
    return `https://${teamSub}.slack.com/archives/${channel}/p${compact}`;
  }
  return null;
}

async function slackTryFillTeamSubdomain(
  token: string,
  state: SlackSyncCursorV1,
): Promise<SlackSyncCursorV1> {
  if (state.teamSubdomain !== null) {
    return state;
  }
  const who = await slackWebApi(token, "auth.test", {});
  if (!who.ok) {
    return state;
  }
  const urlRaw = who.json["url"];
  if (typeof urlRaw !== "string" || urlRaw === "") {
    return state;
  }
  try {
    const host = new URL(urlRaw).hostname;
    const sub = host.replace(/\.slack\.com$/i, "");
    const teamSub = sub === host ? null : sub;
    return { ...state, teamSubdomain: teamSub };
  } catch {
    return state;
  }
}

/**
 * The conversations the sync indexes: the ones the token's user is a member of, plus every direct and
 * group DM (`is_im` / `is_mpim`; `conversations.list` returns a DM object without `is_member`, and
 * it is the owner's by construction - owner ruling OR-10-15). `complete` is false when the page had no
 * `channels` array or an entry with no usable id, so the caller never treats the list as whole.
 */
function slackCollectMemberChannelIds(
  existing: string[],
  chans: unknown,
): { ids: string[]; complete: boolean } {
  const nextIds = [...existing];
  if (!Array.isArray(chans)) {
    return { ids: nextIds, complete: false };
  }
  let complete = true;
  for (const c of chans) {
    const cr = asRecord(c);
    const id = cr?.["id"];
    if (cr === undefined || typeof id !== "string" || id === "") {
      complete = false;
      continue;
    }
    if (cr["is_member"] === true || cr["is_im"] === true || cr["is_mpim"] === true) {
      nextIds.push(id);
    }
  }
  return { ids: nextIds, complete };
}

async function slackAdvanceListPhase(
  ctx: SyncContext,
  token: string,
  state: SlackSyncCursorV1,
  t0: number,
  bytesTransferred: number,
): Promise<
  | { kind: "return"; result: SyncResult }
  | { kind: "done_list"; state: SlackSyncCursorV1; bytesTransferred: number; hasMore: boolean }
> {
  const listBody: Record<string, unknown> = {
    types: "public_channel,private_channel,mpim,im",
    limit: 200,
    exclude_archived: true,
  };
  if (state.listCursor !== null && state.listCursor !== "") {
    listBody["cursor"] = state.listCursor;
  }
  const res = await slackWebApi(token, "conversations.list", listBody);
  const bt = bytesTransferred + res.text.length;
  if (!res.ok) {
    if (res.json["error"] === "ratelimited") {
      ctx.rateLimiter.penalise("slack", 60_000);
    }
    throw new Error(`Slack conversations.list: ${res.text.slice(0, 200)}`);
  }
  const collected = slackCollectMemberChannelIds(state.ids, res.json["channels"]);
  const nextIds = collected.ids;
  const listPartial = state.listPartial || !collected.complete;
  const meta = asRecord(res.json["response_metadata"]);
  const nextList =
    meta !== undefined && typeof meta["next_cursor"] === "string" ? meta["next_cursor"] : "";
  if (nextList !== "") {
    return {
      kind: "return",
      result: {
        cursor: encodeSlackCursor({ ...state, ids: nextIds, listCursor: nextList, listPartial }),
        itemsUpserted: 0,
        itemsDeleted: 0,
        hasMore: true,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: bt,
      },
    };
  }
  const unique = [...new Set(nextIds)].sort((a, b) => a.localeCompare(b));
  const nextState: SlackSyncCursorV1 = {
    ...state,
    phase: "history",
    ids: unique,
    listCursor: null,
    nextIdx: 0,
    histCursor: null,
    listPartial,
  };
  return {
    kind: "done_list",
    state: nextState,
    bytesTransferred: bt,
    hasMore: unique.length > 0,
  };
}

function slackHistoryRequestBody(state: SlackSyncCursorV1, ch: string): Record<string, unknown> {
  const hwVal = state.hw[ch] ?? null;
  const histBody: Record<string, unknown> = {
    channel: ch,
    limit: 100,
  };
  if (state.histCursor !== null && state.histCursor !== "") {
    histBody["cursor"] = state.histCursor;
  } else if (hwVal !== null && hwVal !== "") {
    histBody["oldest"] = hwVal;
    histBody["inclusive"] = false;
  } else {
    histBody["oldest"] = state.floorTs;
    histBody["inclusive"] = true;
  }
  return histBody;
}

function slackTryUpsertIndexedHistoryMessage(
  ctx: SyncContext,
  state: SlackSyncCursorV1,
  ch: string,
  mr: Record<string, unknown>,
  now: number,
): string | null {
  const ts = mr["ts"];
  const text = mr["text"];
  const user = mr["user"];
  const threadTs = mr["thread_ts"];
  if (typeof ts !== "string" || ts === "") {
    return null;
  }
  if (mr["subtype"] !== undefined && mr["subtype"] !== "thread_broadcast") {
    return null;
  }
  const full = typeof text === "string" ? text : "";
  const preview = full.slice(0, 512);
  const title = shortIndexedMessageTitleFromPreview(preview, "(no text)");
  const tsNum = Number.parseFloat(ts);
  const modifiedAt = Number.isFinite(tsNum) ? Math.round(tsNum * 1000) : now;
  const externalId = `${ch}:${ts}`;
  const url = permalink(state.teamSubdomain, ch, ts);
  const authorId =
    typeof user === "string" && user !== "" ? ctx.resolvePerson({ slackHandle: user }) : null;
  ctx.upsertItem({
    service: SERVICE_ID,
    type: "message",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    body: full,
    url,
    canonicalUrl: url,
    modifiedAt,
    authorId,
    metadata: {
      channel: ch,
      user: typeof user === "string" ? user : null,
      thread_ts: typeof threadTs === "string" ? threadTs : null,
    },
    pinned: false,
    syncedAt: now,
  });
  return ts;
}

function slackUpsertHistoryBatch(
  ctx: SyncContext,
  state: SlackSyncCursorV1,
  ch: string,
  messages: unknown,
  itemsUpserted: number,
  hwVal: string | null,
): { itemsUpserted: number; maxTs: string | null } {
  const now = Date.now();
  let maxTs: string | null = hwVal;
  let count = itemsUpserted;
  if (!Array.isArray(messages)) {
    return { itemsUpserted: count, maxTs };
  }
  for (const m of messages) {
    const mr = asRecord(m);
    if (mr === undefined) {
      continue;
    }
    const ts = slackTryUpsertIndexedHistoryMessage(ctx, state, ch, mr, now);
    if (ts === null) {
      continue;
    }
    count += 1;
    maxTs = maxTs === null || ts.localeCompare(maxTs) > 0 ? ts : maxTs;
  }
  return { itemsUpserted: count, maxTs };
}

/**
 * The end of a history round (the last channel's walk is finished): refresh the owner's read markers for
 * the channels just walked (best effort, never fails the sync), then send the cursor back to the LIST
 * phase so the next sync re-lists the conversations - a channel joined or left since is picked up, and
 * the next marker pass prunes by a fresh list. `hw`, `floorTs` and `teamSubdomain` carry over.
 */
async function slackFinishRound(
  ctx: SyncContext,
  token: string,
  state: SlackSyncCursorV1,
  t0: number,
  itemsUpserted: number,
  bytesTransferred: number,
): Promise<SyncResult> {
  const pass = await refreshSlackReadMarkers(ctx, {
    token,
    ids: state.ids,
    mkIdx: state.mkIdx,
    selfUserId: state.selfUserId,
    listComplete: !state.listPartial,
  });
  const next: SlackSyncCursorV1 = {
    ...state,
    phase: "list",
    ids: [],
    nextIdx: 0,
    listCursor: null,
    histCursor: null,
    listPartial: false,
    selfUserId: pass.selfUserId,
    mkIdx: pass.mkIdx,
  };
  return {
    cursor: encodeSlackCursor(next),
    itemsUpserted,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
    bytesTransferred,
  };
}

async function slackRunHistoryPhase(
  ctx: SyncContext,
  token: string,
  state: SlackSyncCursorV1,
  t0: number,
  itemsUpserted: number,
  bytesTransferred: number,
): Promise<SyncResult> {
  const ch = state.ids[state.nextIdx % state.ids.length] ?? "";
  if (ch === "") {
    return syncPassCursorSuccess(t0, bytesTransferred, encodeSlackCursor(state), itemsUpserted);
  }
  const histBody = slackHistoryRequestBody(state, ch);
  const hres = await slackWebApi(token, "conversations.history", histBody);
  const bt = bytesTransferred + hres.text.length;
  if (!hres.ok) {
    if (hres.json["error"] === "ratelimited") {
      ctx.rateLimiter.penalise("slack", 60_000);
    }
    throw new Error(`Slack conversations.history: ${hres.text.slice(0, 200)}`);
  }
  const hwVal = state.hw[ch] ?? null;
  const up = slackUpsertHistoryBatch(ctx, state, ch, hres.json["messages"], itemsUpserted, hwVal);
  const nextHw = { ...state.hw, [ch]: up.maxTs };
  const meta = asRecord(hres.json["response_metadata"]);
  const nextHist =
    meta !== undefined && typeof meta["next_cursor"] === "string" ? meta["next_cursor"] : "";
  if (nextHist !== "") {
    return {
      cursor: encodeSlackCursor({ ...state, hw: nextHw, histCursor: nextHist }),
      itemsUpserted: up.itemsUpserted,
      itemsDeleted: 0,
      hasMore: true,
      durationMs: Math.round(performance.now() - t0),
      bytesTransferred: bt,
    };
  }
  const nextState: SlackSyncCursorV1 = {
    ...state,
    hw: nextHw,
    histCursor: null,
    nextIdx: state.nextIdx + 1,
  };
  if (nextState.nextIdx >= nextState.ids.length) {
    return slackFinishRound(ctx, token, nextState, t0, up.itemsUpserted, bt);
  }
  return {
    cursor: encodeSlackCursor(nextState),
    itemsUpserted: up.itemsUpserted,
    itemsDeleted: 0,
    hasMore: true,
    durationMs: Math.round(performance.now() - t0),
    bytesTransferred: bt,
  };
}

export type SlackSyncableOptions = {
  ensureSlackMcpRunning: () => Promise<void>;
};

export function createSlackSyncable(options: SlackSyncableOptions): Syncable {
  const syncable: Syncable = {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 14,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSlackMcpRunning();
      const rawVault = await ctx.getSecret("oauth");
      if (rawVault === null || rawVault === "") {
        return syncNoopResult(cursor, t0);
      }

      let token: string;
      try {
        token = await ctx.accessToken();
      } catch {
        return syncNoopResult(cursor, t0);
      }

      const depthMs = Math.max(1, syncable.initialSyncDepthDays) * 86_400_000;
      const floorTs = slackTsFromMs(Date.now() - depthMs);

      let state =
        decodeSlackCursor(cursor) ??
        ({
          phase: "list",
          floorTs,
          ids: [],
          nextIdx: 0,
          hw: {},
          listCursor: null,
          histCursor: null,
          teamSubdomain: null,
          selfUserId: null,
          mkIdx: 0,
          listPartial: false,
        } satisfies SlackSyncCursorV1);

      if (state.floorTs === "" || Number.isNaN(Number(state.floorTs))) {
        state = { ...state, floorTs };
      }

      await ctx.rateLimiter.acquire("slack");

      state = await slackTryFillTeamSubdomain(token, state);

      const itemsUpserted = 0;
      let bytesTransferred = 0;
      let hasMore = false;

      if (state.phase === "list") {
        const listOut = await slackAdvanceListPhase(ctx, token, state, t0, bytesTransferred);
        if (listOut.kind === "return") {
          return listOut.result;
        }
        state = listOut.state;
        bytesTransferred = listOut.bytesTransferred;
        hasMore = listOut.hasMore;
      }

      if (state.phase === "history" && state.ids.length === 0) {
        // Nothing to walk (an empty list, or a cursor stuck there by an older version): back to the
        // list phase, so the next sync re-lists instead of idling on an empty history forever.
        const relist: SlackSyncCursorV1 = {
          ...state,
          phase: "list",
          nextIdx: 0,
          listPartial: false,
        };
        return syncPassCursorSuccess(t0, bytesTransferred, encodeSlackCursor(relist), 0);
      }

      if (state.phase === "history") {
        return slackRunHistoryPhase(ctx, token, state, t0, itemsUpserted, bytesTransferred);
      }

      return {
        cursor: encodeSlackCursor(state),
        itemsUpserted,
        itemsDeleted: 0,
        hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred,
      };
    },
  };
  return syncable;
}
