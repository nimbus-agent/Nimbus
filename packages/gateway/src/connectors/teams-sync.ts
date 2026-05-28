import { getValidMicrosoftAccessToken } from "../auth/microsoft-access-token.ts";
import { deleteItemByServiceExternal, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import { plainTextPreviewFromHtml } from "../string/html-plain-text.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { asUnknownObjectRecord } from "./json-unknown.ts";
import {
  fetchMicrosoftGraphJson,
  modifiedMsFromIso,
  type ODataDeltaPage,
  parseODataDeltaPage,
} from "./microsoft-graph-sync-shared.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { shortIndexedMessageTitleFromPreview } from "./sync-message-preview-title.ts";

const SERVICE_ID = "teams";
const CURSOR_PREFIX = "nimbus-tms1:";
const GRAPH = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 25;

export type TeamsSyncCursorV1 = {
  v: 1;
  phase: "teams" | "channels" | "messages";
  teams: { id: string }[];
  teamsNext: string | null;
  channelTeamIdx: number;
  channelsByTeam: Record<string, string[]>;
  chanNext: string | null;
  pairs: { teamId: string; channelId: string }[];
  pairIdx: number;
  deltaByKey: Record<string, string | null>;
};

function initialCursor(): TeamsSyncCursorV1 {
  return {
    v: 1,
    phase: "teams",
    teams: [],
    teamsNext: null,
    channelTeamIdx: 0,
    channelsByTeam: {},
    chanNext: null,
    pairs: [],
    pairIdx: 0,
    deltaByKey: {},
  };
}

function teamsCursorTeamsEntriesOk(teams: unknown): boolean {
  if (!Array.isArray(teams)) {
    return false;
  }
  for (const t of teams) {
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      return false;
    }
    const tr = t as Record<string, unknown>;
    if (typeof tr["id"] !== "string" || tr["id"] === "") {
      return false;
    }
  }
  return true;
}

function teamsCursorPairsEntriesOk(pairs: unknown): boolean {
  if (!Array.isArray(pairs)) {
    return false;
  }
  for (const p of pairs) {
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      return false;
    }
    const pr = p as Record<string, unknown>;
    if (typeof pr["teamId"] !== "string" || typeof pr["channelId"] !== "string") {
      return false;
    }
  }
  return true;
}

function teamsCursorDeltaValuesOk(deltaByKey: unknown): boolean {
  if (deltaByKey === null || typeof deltaByKey !== "object" || Array.isArray(deltaByKey)) {
    return false;
  }
  for (const v of Object.values(deltaByKey as Record<string, unknown>)) {
    if (v !== null && typeof v !== "string") {
      return false;
    }
  }
  return true;
}

function isTeamsCursorV1(o: unknown): o is TeamsSyncCursorV1 {
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    return false;
  }
  const r = o as Record<string, unknown>;
  if (r["v"] !== 1) {
    return false;
  }
  const phase = r["phase"];
  if (phase !== "teams" && phase !== "channels" && phase !== "messages") {
    return false;
  }
  if (!teamsCursorTeamsEntriesOk(r["teams"])) {
    return false;
  }
  const teamsNext = r["teamsNext"];
  if (teamsNext !== null && typeof teamsNext !== "string") {
    return false;
  }
  const channelTeamIdx = r["channelTeamIdx"];
  if (
    typeof channelTeamIdx !== "number" ||
    !Number.isInteger(channelTeamIdx) ||
    channelTeamIdx < 0
  ) {
    return false;
  }
  const channelsByTeam = r["channelsByTeam"];
  if (
    channelsByTeam === null ||
    typeof channelsByTeam !== "object" ||
    Array.isArray(channelsByTeam)
  ) {
    return false;
  }
  const chanNext = r["chanNext"];
  if (chanNext !== null && typeof chanNext !== "string") {
    return false;
  }
  if (!teamsCursorPairsEntriesOk(r["pairs"])) {
    return false;
  }
  const pairIdx = r["pairIdx"];
  if (typeof pairIdx !== "number" || !Number.isInteger(pairIdx) || pairIdx < 0) {
    return false;
  }
  return teamsCursorDeltaValuesOk(r["deltaByKey"]);
}

function parseCursor(raw: string | null): TeamsSyncCursorV1 {
  if (raw === null || raw === "") {
    return initialCursor();
  }
  const o = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (isTeamsCursorV1(o)) {
    return o;
  }
  return initialCursor();
}

export function encodeTeamsSyncCursor(c: TeamsSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

export function decodeTeamsSyncCursor(raw: string): TeamsSyncCursorV1 | undefined {
  const o = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  return isTeamsCursorV1(o) ? o : undefined;
}

function deltaKey(teamId: string, channelId: string): string {
  return `${teamId}|${channelId}`;
}

function flattenPairs(
  channelsByTeam: Record<string, string[]>,
): { teamId: string; channelId: string }[] {
  const teamIds = Object.keys(channelsByTeam).sort((a, b) => a.localeCompare(b));
  const out: { teamId: string; channelId: string }[] = [];
  for (const tid of teamIds) {
    const cids = [...(channelsByTeam[tid] ?? [])].sort((a, b) => a.localeCompare(b));
    for (const cid of cids) {
      out.push({ teamId: tid, channelId: cid });
    }
  }
  return out;
}

type GraphTeamsMessage = {
  id?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  body?: { content?: string; contentType?: string };
  from?: { user?: { displayName?: string; id?: string } };
  "@removed"?: { reason?: string };
};

function upsertChannelMessage(
  ctx: SyncContext,
  teamId: string,
  channelId: string,
  m: GraphTeamsMessage,
  now: number,
): void {
  const id = m.id;
  if (id === undefined || id === "") {
    return;
  }
  const externalId = `${teamId}:${channelId}:${id}`;
  const content = m.body !== undefined && typeof m.body.content === "string" ? m.body.content : "";
  const preview = plainTextPreviewFromHtml(content, 512);
  let fromName: string | null = null;
  const displayName = m.from?.user?.displayName;
  if (displayName !== undefined && displayName !== "") {
    fromName = displayName;
  }
  let titleBase: string;
  if (preview.trim() !== "") {
    titleBase = shortIndexedMessageTitleFromPreview(preview, "(message)");
  } else if (fromName === null) {
    titleBase = "(message)";
  } else {
    titleBase = `Message from ${fromName}`;
  }
  let title = titleBase;
  if (title.length > 512) {
    title = title.slice(0, 512);
  }
  const modified = modifiedMsFromIso(m.lastModifiedDateTime ?? m.createdDateTime, now);
  const graphUserId = m.from?.user?.id;
  const authorId =
    graphUserId !== undefined && graphUserId !== ""
      ? resolvePersonForSync(ctx.db, {
          microsoftUserId: graphUserId,
          displayName: fromName ?? graphUserId,
        })
      : null;

  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "message",
    externalId,
    title,
    bodyPreview: preview,
    url: null,
    canonicalUrl: null,
    modifiedAt: modified,
    authorId,
    metadata: {
      teamId,
      channelId,
      messageId: id,
      fromUserId: m.from?.user?.id ?? null,
    },
    pinned: false,
    syncedAt: now,
  });
}

function parseTeamsListPage(json: unknown): {
  ids: { id: string }[];
  nextLink: string | null;
} {
  const o = asUnknownObjectRecord(json);
  const value = o["value"];
  const ids: { id: string }[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = asUnknownObjectRecord(item);
      const id = r?.["id"];
      if (typeof id === "string" && id !== "") {
        ids.push({ id });
      }
    }
  }
  const next = o["@odata.nextLink"];
  return {
    ids,
    nextLink: typeof next === "string" && next !== "" ? next : null,
  };
}

function parseChannelsListPage(json: unknown): {
  channelIds: string[];
  nextLink: string | null;
} {
  const o = asUnknownObjectRecord(json);
  const value = o["value"];
  const channelIds: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = asUnknownObjectRecord(item);
      const id = r?.["id"];
      const archived = r?.["isArchived"];
      if (typeof id === "string" && id !== "" && archived !== true) {
        channelIds.push(id);
      }
    }
  }
  const next = o["@odata.nextLink"];
  return {
    channelIds,
    nextLink: typeof next === "string" && next !== "" ? next : null,
  };
}

function nextMessageCursorFromDeltaPage(
  page: ODataDeltaPage,
  state: TeamsSyncCursorV1,
  key: string,
  encode: (c: TeamsSyncCursorV1) => string,
): { stored: string | null; hasMore: boolean } {
  const nextLink = page["@odata.nextLink"];
  const deltaLink = page["@odata.deltaLink"];
  if (typeof nextLink === "string" && nextLink !== "") {
    const nextState: TeamsSyncCursorV1 = {
      ...state,
      deltaByKey: { ...state.deltaByKey, [key]: nextLink },
    };
    return { stored: encode(nextState), hasMore: true };
  }
  if (typeof deltaLink === "string" && deltaLink !== "") {
    let pairIdx = state.pairIdx + 1;
    let hasMore = true;
    if (pairIdx >= state.pairs.length) {
      pairIdx = 0;
      hasMore = false;
    }
    const nextState: TeamsSyncCursorV1 = {
      ...state,
      deltaByKey: { ...state.deltaByKey, [key]: deltaLink },
      pairIdx,
    };
    return { stored: encode(nextState), hasMore };
  }
  let pairIdx = state.pairIdx + 1;
  let hasMore = true;
  if (pairIdx >= state.pairs.length) {
    pairIdx = 0;
    hasMore = false;
  }
  const nextState: TeamsSyncCursorV1 = {
    ...state,
    pairIdx,
  };
  return { stored: encode(nextState), hasMore };
}

export type TeamsSyncableOptions = {
  ensureMicrosoftMcpRunning: () => Promise<void>;
};

export function createTeamsSyncable(options: TeamsSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 14,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMicrosoftMcpRunning();
      const token = await getValidMicrosoftAccessToken(ctx.vault);
      const state = parseCursor(cursor);
      let bytesTransferred = 0;

      if (state.phase === "teams") {
        const initialTeams = `${GRAPH}/me/joinedTeams?$top=50`;
        const { json, bytes } = await fetchMicrosoftGraphJson(
          ctx,
          token,
          state.teamsNext,
          initialTeams,
          "Teams",
        );
        bytesTransferred += bytes;
        const page = parseTeamsListPage(json);
        const mergedTeams = [...state.teams, ...page.ids];
        if (page.nextLink !== null) {
          const nextState: TeamsSyncCursorV1 = {
            ...state,
            teams: mergedTeams,
            teamsNext: page.nextLink,
          };
          return {
            cursor: encodeTeamsSyncCursor(nextState),
            itemsUpserted: 0,
            itemsDeleted: 0,
            hasMore: true,
            durationMs: Math.round(performance.now() - t0),
            bytesTransferred,
          };
        }
        const nextState: TeamsSyncCursorV1 = {
          ...state,
          teams: mergedTeams,
          teamsNext: null,
          phase: "channels",
          channelTeamIdx: 0,
          chanNext: null,
          channelsByTeam: {},
        };
        return {
          cursor: encodeTeamsSyncCursor(nextState),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: true,
          durationMs: Math.round(performance.now() - t0),
          bytesTransferred,
        };
      }

      if (state.phase === "channels") {
        const tid = state.teams[state.channelTeamIdx]?.id;
        if (tid === undefined) {
          const pairs = flattenPairs(state.channelsByTeam);
          const nextState: TeamsSyncCursorV1 = {
            ...state,
            phase: "messages",
            pairs,
            pairIdx: 0,
            deltaByKey: {},
          };
          return {
            cursor: encodeTeamsSyncCursor(nextState),
            itemsUpserted: 0,
            itemsDeleted: 0,
            hasMore: pairs.length > 0,
            durationMs: Math.round(performance.now() - t0),
            bytesTransferred,
          };
        }

        const initialChannels = `${GRAPH}/teams/${encodeURIComponent(tid)}/channels?$top=50`;
        const { json, bytes } = await fetchMicrosoftGraphJson(
          ctx,
          token,
          state.chanNext,
          initialChannels,
          "Teams",
        );
        bytesTransferred += bytes;
        const page = parseChannelsListPage(json);
        const prev = state.channelsByTeam[tid] ?? [];
        const merged = [...new Set([...prev, ...page.channelIds])];
        const nextChannelsByTeam = { ...state.channelsByTeam, [tid]: merged };

        if (page.nextLink !== null) {
          const nextState: TeamsSyncCursorV1 = {
            ...state,
            channelsByTeam: nextChannelsByTeam,
            chanNext: page.nextLink,
          };
          return {
            cursor: encodeTeamsSyncCursor(nextState),
            itemsUpserted: 0,
            itemsDeleted: 0,
            hasMore: true,
            durationMs: Math.round(performance.now() - t0),
            bytesTransferred,
          };
        }

        const nextState: TeamsSyncCursorV1 = {
          ...state,
          channelsByTeam: nextChannelsByTeam,
          chanNext: null,
          channelTeamIdx: state.channelTeamIdx + 1,
        };
        return {
          cursor: encodeTeamsSyncCursor(nextState),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: true,
          durationMs: Math.round(performance.now() - t0),
          bytesTransferred,
        };
      }

      if (state.pairs.length === 0) {
        return {
          cursor: encodeTeamsSyncCursor(state),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: Math.round(performance.now() - t0),
          bytesTransferred,
        };
      }

      const pair = state.pairs[state.pairIdx];
      if (pair === undefined) {
        return {
          cursor: encodeTeamsSyncCursor(state),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: Math.round(performance.now() - t0),
          bytesTransferred,
        };
      }

      const key = deltaKey(pair.teamId, pair.channelId);
      const nextDelta = state.deltaByKey[key] ?? null;
      const initialUrl = `${GRAPH}/teams/${encodeURIComponent(pair.teamId)}/channels/${encodeURIComponent(pair.channelId)}/messages/delta?$top=${String(PAGE_SIZE)}`;

      const { json, bytes } = await fetchMicrosoftGraphJson(
        ctx,
        token,
        nextDelta ?? null,
        initialUrl,
        "Teams",
      );
      bytesTransferred += bytes;
      const parsed = parseODataDeltaPage(json);
      const values = (parsed.value ?? []) as GraphTeamsMessage[];
      const now = Date.now();
      let upserted = 0;
      let deleted = 0;

      for (const msg of values) {
        const removed = msg["@removed"] !== undefined && msg["@removed"] !== null;
        const mid = msg.id;
        if (removed && mid !== undefined && mid !== "") {
          deleteItemByServiceExternal(
            ctx.db,
            SERVICE_ID,
            `${pair.teamId}:${pair.channelId}:${mid}`,
          );
          deleted += 1;
          continue;
        }
        upsertChannelMessage(ctx, pair.teamId, pair.channelId, msg, now);
        upserted += 1;
      }

      const { stored, hasMore } = nextMessageCursorFromDeltaPage(
        parsed,
        state,
        key,
        encodeTeamsSyncCursor,
      );

      return {
        cursor: stored,
        itemsUpserted: upserted,
        itemsDeleted: deleted,
        hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred,
      };
    },
  };
}
