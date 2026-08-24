import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { shortIndexedMessageTitleFromPreview } from "./sync-message-preview-title.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "slack";
const CURSOR_PREFIX = "nimbus-slk1:";

type SlackSyncCursorV1 = {
  phase: "list" | "history";
  floorTs: string;
  ids: string[];
  nextIdx: number;
  hw: Record<string, string | null>;
  listCursor: string | null;
  histCursor: string | null;
  teamSubdomain: string | null;
};

function encodeCursor(c: SlackSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
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

function decodeCursor(raw: string | null): SlackSyncCursorV1 | null {
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (parsed === undefined) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
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
  return {
    phase,
    floorTs,
    ids,
    nextIdx,
    hw: slackDecodeHighWater(hw),
    listCursor: typeof listCursor === "string" ? listCursor : null,
    histCursor: typeof histCursor === "string" ? histCursor : null,
    teamSubdomain: typeof teamSubdomain === "string" ? teamSubdomain : null,
  };
}

function slackTsFromMs(ms: number): string {
  return (ms / 1000).toFixed(6);
}

async function slackWebApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, json: {}, text };
  }
  const json =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const okField = json["ok"];
  return { ok: okField === true && res.ok, json, text };
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

function slackCollectMemberChannelIds(existing: string[], chans: unknown): string[] {
  const nextIds = [...existing];
  if (!Array.isArray(chans)) {
    return nextIds;
  }
  for (const c of chans) {
    const cr = asRecord(c);
    if (cr === undefined) {
      continue;
    }
    const id = cr["id"];
    const member = cr["is_member"];
    if (typeof id === "string" && id !== "" && member === true) {
      nextIds.push(id);
    }
  }
  return nextIds;
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
  const nextIds = slackCollectMemberChannelIds(state.ids, res.json["channels"]);
  const meta = asRecord(res.json["response_metadata"]);
  const nextList =
    meta !== undefined && typeof meta["next_cursor"] === "string" ? meta["next_cursor"] : "";
  if (nextList !== "") {
    return {
      kind: "return",
      result: {
        cursor: encodeCursor({ ...state, ids: nextIds, listCursor: nextList }),
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
  upsertIndexedItemForSync(ctx, {
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
    return {
      cursor: encodeCursor(state),
      itemsUpserted,
      itemsDeleted: 0,
      hasMore: false,
      durationMs: Math.round(performance.now() - t0),
      bytesTransferred,
    };
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
      cursor: encodeCursor({ ...state, hw: nextHw, histCursor: nextHist }),
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
  const hasMore = nextState.nextIdx < nextState.ids.length;
  return {
    cursor: encodeCursor(nextState),
    itemsUpserted: up.itemsUpserted,
    itemsDeleted: 0,
    hasMore,
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
        decodeCursor(cursor) ??
        ({
          phase: "list",
          floorTs,
          ids: [],
          nextIdx: 0,
          hw: {},
          listCursor: null,
          histCursor: null,
          teamSubdomain: null,
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
        return {
          cursor: encodeCursor(state),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: Math.round(performance.now() - t0),
          bytesTransferred,
        };
      }

      if (state.phase === "history") {
        return slackRunHistoryPhase(ctx, token, state, t0, itemsUpserted, bytesTransferred);
      }

      return {
        cursor: encodeCursor(state),
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
