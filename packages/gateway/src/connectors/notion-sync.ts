import { getValidNotionAccessToken } from "../auth/notion-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { isoMs, maxIso } from "./sync-iso-helpers.ts";
import {
  decodeWatermarkCursorV1,
  encodeWatermarkCursorV1,
  type WatermarkCursorV1,
} from "./sync-watermark-cursor-v1.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "notion";
const CURSOR_PREFIX = "nimbus-ntn1:";
const NOTION_VERSION = "2022-06-28";
const SEARCH_URL = "https://api.notion.com/v1/search";

function encodeCursor(c: WatermarkCursorV1): string {
  return encodeWatermarkCursorV1(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): WatermarkCursorV1 | null {
  return decodeWatermarkCursorV1(raw, CURSOR_PREFIX);
}

function titlePartsFromNotionTitleRichText(titleArr: unknown): string[] {
  if (!Array.isArray(titleArr)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of titleArr) {
    const ir = asRecord(item);
    if (ir === undefined) {
      continue;
    }
    if (stringField(ir, "type") !== "text") {
      continue;
    }
    const tx = asRecord(ir["text"]);
    const c = tx === undefined ? undefined : stringField(tx, "content");
    if (c !== undefined && c !== "") {
      parts.push(c);
    }
  }
  return parts;
}

function titleFromNotionPropertyValue(val: unknown): string | null {
  const p = asRecord(val);
  if (p === undefined) {
    return null;
  }
  if (stringField(p, "type") !== "title") {
    return null;
  }
  const joined = titlePartsFromNotionTitleRichText(p["title"]).join("");
  return joined === "" ? null : joined;
}

function extractTitleFromProperties(properties: unknown): string {
  const rec = asRecord(properties);
  if (rec === undefined) {
    return "Untitled";
  }
  for (const val of Object.values(rec)) {
    const t = titleFromNotionPropertyValue(val);
    if (t !== null) {
      return t;
    }
  }
  return "Untitled";
}

function notionSearchRequestBody(nextCursor: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 100,
  };
  if (nextCursor !== undefined && nextCursor !== "") {
    body["start_cursor"] = nextCursor;
  }
  return body;
}

type NotionSearchBatch = {
  results: unknown[];
  hasMore: boolean;
  nextCursor: string | undefined;
  bytesThisPage: number;
};

async function notionFetchSearchBatch(
  ctx: SyncContext,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<NotionSearchBatch> {
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 429) {
    ctx.rateLimiter.penalise("notion", 60_000);
    throw new Error("Notion sync: rate limited");
  }
  if (!res.ok) {
    throw new Error(`Notion sync HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Notion sync: invalid JSON");
  }
  const root = asRecord(parsed);
  if (root === undefined) {
    throw new Error("Notion sync: invalid response");
  }
  const results = root["results"];
  if (!Array.isArray(results)) {
    throw new TypeError("Notion sync: missing results");
  }
  const hasMore = root["has_more"] === true;
  const startNext = stringField(root, "next_cursor");
  const nextCursor = startNext !== undefined && startNext !== "" ? startNext : undefined;
  return { results, hasMore, nextCursor, bytesThisPage: text.length };
}

type NotionRowProcessAcc = {
  maxEdited: string;
  upserted: number;
  shouldStop: boolean;
};

function notionWatermarkOrAdvanceMax(
  edited: string | undefined,
  opts: { watermarkMs: number },
  acc: NotionRowProcessAcc,
): "stop" | "continue" {
  if (edited === undefined || edited === "") {
    return "continue";
  }
  if (opts.watermarkMs >= 0 && isoMs(edited) <= opts.watermarkMs) {
    acc.shouldStop = true;
    return "stop";
  }
  acc.maxEdited = acc.maxEdited === "" ? edited : maxIso(acc.maxEdited, edited);
  return "continue";
}

function notionAuthorIdFromPageRow(ctx: SyncContext, row: Record<string, unknown>): string | null {
  const createdBy = asRecord(row["created_by"]);
  const notionUserId =
    createdBy !== undefined && stringField(createdBy, "object") === "user"
      ? stringField(createdBy, "id")
      : undefined;
  if (notionUserId === undefined || notionUserId === "") {
    return null;
  }
  return resolvePersonForSync(ctx.db, { notionUserId });
}

function notionConsumeSearchResultRow(
  ctx: SyncContext,
  item: unknown,
  opts: { watermarkMs: number; syncTime: number },
  acc: NotionRowProcessAcc,
): boolean {
  const row = asRecord(item);
  if (row === undefined) {
    return false;
  }
  if (stringField(row, "object") !== "page") {
    return false;
  }
  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return false;
  }
  const edited = stringField(row, "last_edited_time");
  if (notionWatermarkOrAdvanceMax(edited, opts, acc) === "stop") {
    return true;
  }
  const title = extractTitleFromProperties(row["properties"]);
  const url = `https://www.notion.so/${id.replaceAll("-", "")}`;
  const modified = edited !== undefined && edited !== "" ? isoMs(edited) : opts.syncTime;
  acc.upserted += 1;
  const authorId = notionAuthorIdFromPageRow(ctx, row);
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "page",
    externalId: id,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: "",
    url,
    canonicalUrl: url,
    modifiedAt: Number.isFinite(modified) ? modified : opts.syncTime,
    authorId,
    metadata: { notionPageId: id },
    pinned: false,
    syncedAt: opts.syncTime,
  });
  return false;
}

function notionAccumulateSearchResults(
  ctx: SyncContext,
  results: unknown[],
  opts: { watermarkMs: number; syncTime: number },
  acc: NotionRowProcessAcc,
): void {
  for (const item of results) {
    if (notionConsumeSearchResultRow(ctx, item, opts, acc)) {
      break;
    }
  }
}

export type NotionSyncableOptions = {
  ensureNotionMcpRunning: () => Promise<void>;
};

export function createNotionSyncable(options: NotionSyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureNotionMcpRunning();
      const rawVault = await readConnectorSecret(ctx.vault, "notion", "oauth");
      if (rawVault === null || rawVault === "") {
        return syncNoopResult(cursor, t0);
      }

      let accessToken: string;
      try {
        accessToken = await getValidNotionAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor);
      const watermark = prev?.watermark ?? null;
      const watermarkMs = watermark !== null && watermark !== "" ? isoMs(watermark) : -1;

      await ctx.rateLimiter.acquire("notion");

      let nextCursor: string | undefined;
      let upserted = 0;
      let bytesTransferred = 0;
      let maxEdited = watermark ?? "";
      const syncTime = Date.now();
      let shouldStop = false;

      for (;;) {
        const body = notionSearchRequestBody(nextCursor);
        const batch = await notionFetchSearchBatch(ctx, accessToken, body);
        bytesTransferred += batch.bytesThisPage;
        const acc: NotionRowProcessAcc = { maxEdited, upserted: 0, shouldStop: false };
        notionAccumulateSearchResults(ctx, batch.results, { watermarkMs, syncTime }, acc);
        upserted += acc.upserted;
        maxEdited = acc.maxEdited;
        shouldStop = acc.shouldStop;

        if (shouldStop) {
          break;
        }
        if (!batch.hasMore) {
          break;
        }
        if (batch.nextCursor === undefined || batch.nextCursor === "") {
          break;
        }
        nextCursor = batch.nextCursor;
      }

      const nextW = maxEdited === "" ? watermark : maxEdited;
      const nextEnc = encodeCursor({ v: 1, watermark: nextW });

      return {
        cursor: nextEnc,
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred,
      };
    },
  };
}
