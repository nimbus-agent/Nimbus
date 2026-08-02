import { BODY_MAX_PROSE } from "../../../index/body-caps.ts";
import { upsertIndexedItemForSync } from "../../../index/item-store.ts";
import { resolvePersonForSync } from "../../../people/linker.ts";
import { plainTextPreviewFromHtml } from "../../../string/html-plain-text.ts";
import type { SyncContext } from "../../../sync/types.ts";
import { asUnknownObjectRecord } from "../../json-unknown.ts";
import { modifiedMsFromIso, type ODataDeltaPage } from "../../microsoft-graph-sync-shared.ts";
import { shortIndexedMessageTitleFromPreview } from "../../sync-message-preview-title.ts";
import type { TeamsSyncCursorV1 } from "./cursor.ts";

export const TEAMS_SERVICE_ID = "teams";
export const TEAMS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const TEAMS_PAGE_SIZE = 25;

export type GraphTeamsMessage = {
  id?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  body?: { content?: string; contentType?: string };
  from?: { user?: { displayName?: string; id?: string } };
  "@removed"?: { reason?: string };
};

export function deltaKey(teamId: string, channelId: string): string {
  return `${teamId}|${channelId}`;
}

export function flattenPairs(
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

export function upsertChannelMessage(
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
  const full = plainTextPreviewFromHtml(content, BODY_MAX_PROSE);
  const preview = full.slice(0, 512);
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
    service: TEAMS_SERVICE_ID,
    type: "message",
    externalId,
    title,
    body: full,
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

export function parseTeamsListPage(json: unknown): {
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

export function parseChannelsListPage(json: unknown): {
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

export function nextMessageCursorFromDeltaPage(
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
