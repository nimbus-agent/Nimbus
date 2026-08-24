import { deleteItemByServiceExternal } from "../index/item-store.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  deltaKey,
  flattenPairs,
  type GraphTeamsMessage,
  nextMessageCursorFromDeltaPage,
  parseChannelsListPage,
  parseTeamsListPage,
  TEAMS_GRAPH_BASE,
  TEAMS_PAGE_SIZE,
  TEAMS_SERVICE_ID,
  upsertChannelMessage,
} from "./_lib/teams/api.ts";
import { encodeTeamsSyncCursor, parseCursor, type TeamsSyncCursorV1 } from "./_lib/teams/cursor.ts";
import { fetchMicrosoftGraphJson, parseODataDeltaPage } from "./microsoft-graph-sync-shared.ts";

export { decodeTeamsSyncCursor } from "./_lib/teams/cursor.ts";
export { encodeTeamsSyncCursor, type TeamsSyncCursorV1 };

export type TeamsSyncableOptions = {
  ensureMicrosoftMcpRunning: () => Promise<void>;
};

export function createTeamsSyncable(options: TeamsSyncableOptions): Syncable {
  return {
    serviceId: TEAMS_SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 14,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMicrosoftMcpRunning();
      const token = await ctx.accessToken();
      const state = parseCursor(cursor);
      let bytesTransferred = 0;

      if (state.phase === "teams") {
        const initialTeams = `${TEAMS_GRAPH_BASE}/me/joinedTeams?$top=50`;
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

        const initialChannels = `${TEAMS_GRAPH_BASE}/teams/${encodeURIComponent(tid)}/channels?$top=50`;
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
      const initialUrl = `${TEAMS_GRAPH_BASE}/teams/${encodeURIComponent(pair.teamId)}/channels/${encodeURIComponent(pair.channelId)}/messages/delta?$top=${String(TEAMS_PAGE_SIZE)}`;

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
            TEAMS_SERVICE_ID,
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
