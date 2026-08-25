import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "discord";
const CURSOR_PREFIX = "nimbus-dsc1:";
const DISCORD_API = "https://discord.com/api/v10";
const MAX_API_CALLS_PER_SYNC = 8;

const TEXT_CHANNEL_TYPES = new Set([0, 5]);

type DiscordSyncCursorV1 = {
  guildIds: string[];
  guildIndex: number;
  channelIds: string[];
  channelIndex: number;
  lastMsgByChannel: Record<string, string>;
};

type DiscordAcc = {
  upserted: number;
  bytesTransferred: number;
  apiCalls: number;
};

type StateRef = { s: DiscordSyncCursorV1 };

function encodeCursor(c: DiscordSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): DiscordSyncCursorV1 | null {
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const guildIds = rec["guildIds"];
  const guildIndex = rec["guildIndex"];
  const channelIds = rec["channelIds"];
  const channelIndex = rec["channelIndex"];
  const lastMsgByChannel = rec["lastMsgByChannel"];
  if (!Array.isArray(guildIds) || guildIds.some((g) => typeof g !== "string")) {
    return null;
  }
  if (typeof guildIndex !== "number" || !Number.isInteger(guildIndex) || guildIndex < 0) {
    return null;
  }
  if (!Array.isArray(channelIds) || channelIds.some((c) => typeof c !== "string")) {
    return null;
  }
  if (typeof channelIndex !== "number" || !Number.isInteger(channelIndex) || channelIndex < 0) {
    return null;
  }
  const lastMap: Record<string, string> = {};
  if (
    lastMsgByChannel !== null &&
    typeof lastMsgByChannel === "object" &&
    !Array.isArray(lastMsgByChannel)
  ) {
    for (const [k, v] of Object.entries(lastMsgByChannel as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") {
        lastMap[k] = v;
      }
    }
  }
  return {
    guildIds,
    guildIndex,
    channelIds,
    channelIndex,
    lastMsgByChannel: lastMap,
  };
}

async function discordFetch(
  token: string,
  path: string,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = path.startsWith("http") ? path : `${DISCORD_API}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "NimbusGateway (https://github.com/nimbus-dev/nimbus)",
    },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

function discordRetryAfterSeconds(json: unknown): number {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return 1;
  }
  const raw = (json as Record<string, unknown>)["retry_after"];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 1;
  }
  return 1;
}

function displayNameFromDiscordAuthor(author: Record<string, unknown>): string {
  const gn = stringField(author, "global_name");
  const un = stringField(author, "username");
  if (gn !== undefined && gn !== "") {
    return gn;
  }
  if (un !== undefined && un !== "") {
    return un;
  }
  return "unknown";
}

function discordGuildIdsFromJson(json: unknown): string[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const ids: string[] = [];
  for (const g of json) {
    const gr = asRecord(g);
    const id = gr === undefined ? undefined : stringField(gr, "id");
    if (id !== undefined && id !== "") {
      ids.push(id);
    }
  }
  return ids;
}

function discordTextChannelIdsFromJson(json: unknown): string[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const chIds: string[] = [];
  for (const ch of json) {
    const cr = asRecord(ch);
    if (cr === undefined) {
      continue;
    }
    const id = stringField(cr, "id");
    const type = cr["type"];
    if (id !== undefined && id !== "" && typeof type === "number" && TEXT_CHANNEL_TYPES.has(type)) {
      chIds.push(id);
    }
  }
  return chIds;
}

function upsertOneDiscordMessageIfValid(
  ctx: SyncContext,
  mr: Record<string, unknown>,
  guildId: string,
  channelId: string,
  now: number,
): boolean {
  const mid = stringField(mr, "id");
  const content = typeof mr["content"] === "string" ? mr["content"] : "";
  const author = asRecord(mr["author"]);
  if (mid === undefined || mid === "" || author === undefined) {
    return false;
  }
  const authorSnowflake = stringField(author, "id");
  const full = content;
  const preview = full.length > 512 ? full.slice(0, 512) : full;
  const titleBase =
    preview.trim() === ""
      ? displayNameFromDiscordAuthor(author)
      : preview.replaceAll(/\s+/g, " ").slice(0, 80);
  const title = titleBase.length > 512 ? titleBase.slice(0, 512) : titleBase;
  const url = `https://discord.com/channels/${guildId}/${channelId}/${mid}`;
  const authorId =
    authorSnowflake !== undefined && authorSnowflake !== ""
      ? ctx.resolvePerson({
          discordUserId: authorSnowflake,
          displayName: displayNameFromDiscordAuthor(author),
        })
      : null;
  ctx.upsertItem({
    service: SERVICE_ID,
    type: "message",
    externalId: `${channelId}:${mid}`,
    title,
    body: full,
    url,
    canonicalUrl: url,
    modifiedAt: now,
    authorId,
    metadata: {
      guildId,
      channelId,
      messageId: mid,
    },
    pinned: false,
    syncedAt: now,
  });
  return true;
}

function discordUpsertMessagesFromPage(
  ctx: SyncContext,
  guildId: string,
  channelId: string,
  messages: unknown[],
  now: number,
  acc: DiscordAcc,
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const mr = asRecord(messages[i]);
    if (mr === undefined) {
      continue;
    }
    if (upsertOneDiscordMessageIfValid(ctx, mr, guildId, channelId, now)) {
      acc.upserted += 1;
    }
  }
}

async function discordFetchGuildList(
  ctx: SyncContext,
  token: string,
  ref: StateRef,
  acc: DiscordAcc,
  finish: (n: DiscordSyncCursorV1, h: boolean) => SyncResult,
): Promise<SyncResult | undefined> {
  await ctx.rateLimiter.acquire("discord");
  acc.apiCalls += 1;
  const res = await discordFetch(token, "/users/@me/guilds");
  acc.bytesTransferred += res.text.length;
  if (res.status === 429) {
    const ra = discordRetryAfterSeconds(res.json);
    const ms = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra * 1000) : 60_000;
    ctx.rateLimiter.penalise("discord", ms);
    throw new Error(`Discord guilds 429: ${res.text.slice(0, 200)}`);
  }
  if (!res.ok || !Array.isArray(res.json)) {
    throw new Error(`Discord guilds ${String(res.status)}: ${res.text.slice(0, 200)}`);
  }
  const ids = discordGuildIdsFromJson(res.json);
  ref.s = {
    guildIds: ids,
    guildIndex: 0,
    channelIds: [],
    channelIndex: 0,
    lastMsgByChannel: {},
  };
  if (ids.length === 0) {
    return finish(ref.s, false);
  }
  return undefined;
}

function discordFinishIfGuildsExhausted(
  ref: StateRef,
  finish: (n: DiscordSyncCursorV1, h: boolean) => SyncResult,
): SyncResult | undefined {
  if (ref.s.guildIndex < ref.s.guildIds.length) {
    return undefined;
  }
  const cleared: DiscordSyncCursorV1 = {
    guildIds: [],
    guildIndex: 0,
    channelIds: [],
    channelIndex: 0,
    lastMsgByChannel: ref.s.lastMsgByChannel,
  };
  return finish(cleared, false);
}

async function discordFetchChannelList(
  ctx: SyncContext,
  token: string,
  guildId: string,
  ref: StateRef,
  acc: DiscordAcc,
): Promise<void> {
  await ctx.rateLimiter.acquire("discord");
  acc.apiCalls += 1;
  const res = await discordFetch(token, `/guilds/${encodeURIComponent(guildId)}/channels`);
  acc.bytesTransferred += res.text.length;
  if (res.status === 429) {
    ctx.rateLimiter.penalise("discord", 60_000);
    throw new Error(`Discord channels 429: ${res.text.slice(0, 200)}`);
  }
  if (!res.ok || !Array.isArray(res.json)) {
    throw new Error(`Discord channels ${String(res.status)}: ${res.text.slice(0, 200)}`);
  }
  const chIds = discordTextChannelIdsFromJson(res.json);
  ref.s = { ...ref.s, channelIds: chIds, channelIndex: 0 };
  if (chIds.length === 0) {
    ref.s = {
      ...ref.s,
      guildIndex: ref.s.guildIndex + 1,
      channelIds: [],
      channelIndex: 0,
    };
  }
}

async function discordFetchAndApplyMessages(
  ctx: SyncContext,
  token: string,
  guildId: string,
  channelId: string,
  ref: StateRef,
  acc: DiscordAcc,
  now: number,
): Promise<void> {
  const after = ref.s.lastMsgByChannel[channelId];
  let path = `/channels/${encodeURIComponent(channelId)}/messages?limit=50`;
  if (after !== undefined && after !== "") {
    path += `&after=${encodeURIComponent(after)}`;
  }

  await ctx.rateLimiter.acquire("discord");
  acc.apiCalls += 1;
  const res = await discordFetch(token, path);
  acc.bytesTransferred += res.text.length;
  if (res.status === 429) {
    ctx.rateLimiter.penalise("discord", 60_000);
    throw new Error(`Discord messages 429: ${res.text.slice(0, 200)}`);
  }
  if (!res.ok) {
    ref.s = { ...ref.s, channelIndex: ref.s.channelIndex + 1 };
    return;
  }
  if (!Array.isArray(res.json)) {
    ref.s = { ...ref.s, channelIndex: ref.s.channelIndex + 1 };
    return;
  }
  const messages = res.json as unknown[];
  if (messages.length === 0) {
    const nextLast: Record<string, string> = { ...ref.s.lastMsgByChannel };
    delete nextLast[channelId];
    ref.s = {
      ...ref.s,
      lastMsgByChannel: nextLast,
      channelIndex: ref.s.channelIndex + 1,
    };
    return;
  }

  const newestId =
    typeof (messages[0] as { id?: string })?.id === "string"
      ? (messages[0] as { id: string }).id
      : "";
  const nextLastMap: Record<string, string> = {
    ...ref.s.lastMsgByChannel,
    [channelId]: newestId,
  };

  discordUpsertMessagesFromPage(ctx, guildId, channelId, messages, now, acc);

  ref.s = {
    ...ref.s,
    lastMsgByChannel: nextLastMap,
  };
}

async function discordSyncTick(
  ctx: SyncContext,
  token: string,
  now: number,
  ref: StateRef,
  acc: DiscordAcc,
  finish: (n: DiscordSyncCursorV1, h: boolean) => SyncResult,
): Promise<SyncResult | undefined> {
  if (ref.s.guildIds.length === 0) {
    return discordFetchGuildList(ctx, token, ref, acc, finish);
  }

  const doneGuilds = discordFinishIfGuildsExhausted(ref, finish);
  if (doneGuilds !== undefined) {
    return doneGuilds;
  }

  const guildId = ref.s.guildIds[ref.s.guildIndex] ?? "";
  if (guildId === "") {
    ref.s = { ...ref.s, guildIndex: ref.s.guildIndex + 1, channelIds: [], channelIndex: 0 };
    return undefined;
  }

  if (ref.s.channelIds.length === 0) {
    await discordFetchChannelList(ctx, token, guildId, ref, acc);
    return undefined;
  }

  if (ref.s.channelIndex >= ref.s.channelIds.length) {
    ref.s = {
      ...ref.s,
      guildIndex: ref.s.guildIndex + 1,
      channelIds: [],
      channelIndex: 0,
    };
    return undefined;
  }

  const channelId: string = ref.s.channelIds[ref.s.channelIndex] ?? "";
  if (channelId === "") {
    ref.s = { ...ref.s, channelIndex: ref.s.channelIndex + 1 };
    return undefined;
  }

  await discordFetchAndApplyMessages(ctx, token, guildId, channelId, ref, acc, now);
  return undefined;
}

export type DiscordSyncableOptions = {
  ensureDiscordMcpRunning: () => Promise<void>;
};

export function createDiscordSyncable(options: DiscordSyncableOptions): Syncable {
  const initialSyncDepthDays = 14;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureDiscordMcpRunning();
      const enabled = await ctx.getSecret("enabled");
      const token = await ctx.getSecret("bot_token");
      if (enabled !== "1" || token === null || token === "") {
        return syncNoopResult(cursor, t0);
      }

      const ref: StateRef = {
        s:
          decodeCursor(cursor) ??
          ({
            guildIds: [],
            guildIndex: 0,
            channelIds: [],
            channelIndex: 0,
            lastMsgByChannel: {},
          } satisfies DiscordSyncCursorV1),
      };

      const acc: DiscordAcc = {
        upserted: 0,
        bytesTransferred: 0,
        apiCalls: 0,
      };
      const now = Date.now();

      const finish = (next: DiscordSyncCursorV1, hasMore: boolean): SyncResult => ({
        cursor: encodeCursor(next),
        itemsUpserted: acc.upserted,
        itemsDeleted: 0,
        hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: acc.bytesTransferred,
      });

      while (acc.apiCalls < MAX_API_CALLS_PER_SYNC) {
        const early = await discordSyncTick(ctx, token, now, ref, acc, finish);
        if (early !== undefined) {
          return early;
        }
      }

      const moreWork =
        ref.s.guildIds.length > 0 &&
        (ref.s.guildIndex < ref.s.guildIds.length ||
          ref.s.channelIndex < ref.s.channelIds.length ||
          ref.s.channelIds.length === 0);
      return finish(ref.s, moreWork);
    },
  };
}
