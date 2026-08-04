import { type IndexedItemBodyInput, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import { plainTextFromHtml } from "../string/html-plain-text.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import {
  asRecord,
  basicAuthHeader,
  normalizeAtlassianSiteBaseUrl,
  stringField,
} from "./atlassian-api-sync-helpers.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { isoMs, maxIso } from "./sync-iso-helpers.ts";
import {
  decodeWatermarkCursorV1,
  encodeWatermarkCursorV1,
  type WatermarkCursorV1,
} from "./sync-watermark-cursor-v1.ts";

const SERVICE_ID = "confluence";
const CURSOR_PREFIX = "nimbus-cfl1:";

function wikiApiBase(siteBase: string): string {
  const b = normalizeAtlassianSiteBaseUrl(siteBase);
  if (b === "") {
    return "";
  }
  const root = b.endsWith("/wiki") ? b : `${b}/wiki`;
  return `${root}/rest/api`;
}

function encodeCursor(c: WatermarkCursorV1): string {
  return encodeWatermarkCursorV1(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): WatermarkCursorV1 | null {
  return decodeWatermarkCursorV1(raw, CURSOR_PREFIX);
}

function lastModifiedFromContent(row: Record<string, unknown>): string | undefined {
  const hist = asRecord(row["history"]);
  if (hist === undefined) {
    return undefined;
  }
  const lu = asRecord(hist["lastUpdated"]);
  if (lu === undefined) {
    return undefined;
  }
  return stringField(lu, "when");
}

function confluenceLastUpdatedBy(row: Record<string, unknown>): Record<string, unknown> | null {
  const hist = asRecord(row["history"]);
  const lu = hist === undefined ? undefined : asRecord(hist["lastUpdated"]);
  const by = lu === undefined ? undefined : asRecord(lu["by"]);
  return by ?? null;
}

type ConfluencePagedSearchParams = {
  ctx: SyncContext;
  apiBase: string;
  email: string;
  token: string;
  baseRaw: string;
  cqlBase: string;
  watermark: string | null;
  watermarkMs: number;
  t0: number;
};

function resolveConfluenceAuthorId(ctx: SyncContext, by: Record<string, unknown>): string | null {
  const accountId = stringField(by, "accountId");
  if (accountId === undefined || accountId === "") {
    return null;
  }
  const email = stringField(by, "email");
  const displayName = stringField(by, "displayName");
  if (email !== undefined && email !== "" && email.includes("@")) {
    return resolvePersonForSync(ctx.db, {
      jiraAccountId: accountId,
      canonicalEmail: email,
      displayName: displayName ?? email,
    });
  }
  return resolvePersonForSync(ctx.db, {
    jiraAccountId: accountId,
    displayName: displayName ?? accountId,
  });
}

function confluenceWatermarkStopOrBumpMax(
  when: string | undefined,
  watermarkMs: number,
  acc: { maxEdited: string },
): boolean {
  if (when === undefined || when === "") {
    return false;
  }
  if (watermarkMs >= 0 && isoMs(when) <= watermarkMs) {
    return true;
  }
  acc.maxEdited = acc.maxEdited === "" ? when : maxIso(acc.maxEdited, when);
  return false;
}

/**
 * `null` (not `""`) when the row carries no storage body at all — an absent
 * expand must not be indistinguishable from an empty page, or the store would
 * report `body_complete = 1` for a body we never received.
 */
export function confluenceBodyText(row: Record<string, unknown>): string | null {
  const body = asRecord(row["body"]);
  const storage = body === undefined ? undefined : asRecord(body["storage"]);
  const value = storage === undefined ? undefined : stringField(storage, "value");
  return value === undefined ? null : plainTextFromHtml(value);
}

function confluenceUpsertOneSearchHit(
  ctx: SyncContext,
  item: unknown,
  opts: {
    watermarkMs: number;
    baseRaw: string;
    syncTime: number;
  },
  acc: { maxEdited: string; upserted: number },
): boolean {
  const row = asRecord(item);
  if (row === undefined) {
    return false;
  }
  if (stringField(row, "type") !== "page") {
    return false;
  }
  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return false;
  }
  const title = stringField(row, "title") ?? id;
  const when = lastModifiedFromContent(row);
  if (confluenceWatermarkStopOrBumpMax(when, opts.watermarkMs, acc)) {
    return true;
  }
  const site = normalizeAtlassianSiteBaseUrl(opts.baseRaw);
  const webUi = `${site}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
  const modified = when !== undefined && when !== "" ? isoMs(when) : opts.syncTime;
  acc.upserted += 1;
  const by = confluenceLastUpdatedBy(row);
  const authorId = by === null ? null : resolveConfluenceAuthorId(ctx, by);
  const text = confluenceBodyText(row);
  const bodyInput: IndexedItemBodyInput = text === null ? { bodyPreview: "" } : { body: text };
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "page",
    externalId: id,
    title: title.length > 512 ? title.slice(0, 512) : title,
    ...bodyInput,
    url: webUi,
    canonicalUrl: webUi,
    modifiedAt: Number.isFinite(modified) ? modified : opts.syncTime,
    authorId,
    metadata: { confluencePageId: id },
    pinned: false,
    syncedAt: opts.syncTime,
  });
  return false;
}

async function confluenceFetchSearchPageBatch(
  ctx: SyncContext,
  batch: {
    apiBase: string;
    email: string;
    token: string;
    cqlBase: string;
    start: number;
    limit: number;
  },
): Promise<{ results: unknown[]; bytes: number }> {
  const { apiBase, email, token, cqlBase, start, limit } = batch;
  const qs = new URLSearchParams({
    cql: cqlBase,
    limit: String(limit),
    start: String(start),
    expand: "history.lastUpdated,space,version,body.storage",
  });
  const url = `${apiBase}/content/search?${qs.toString()}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: basicAuthHeader(email, token),
    },
  });
  const text = await res.text();
  const bytes = text.length;

  if (res.status === 429) {
    ctx.rateLimiter.penalise("confluence", 60_000);
    throw new Error("Confluence sync: rate limited");
  }
  if (!res.ok) {
    throw new Error(`Confluence sync HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Confluence sync: invalid JSON");
  }
  const root = asRecord(parsed);
  const results = root?.["results"];
  if (!Array.isArray(results)) {
    throw new TypeError("Confluence sync: missing results");
  }
  return { results, bytes };
}

async function confluenceRunPagedSearch(p: ConfluencePagedSearchParams): Promise<SyncResult> {
  const { ctx, apiBase, email, token, baseRaw, cqlBase, watermark, watermarkMs, t0 } = p;
  const limit = 25;
  let start = 0;
  let bytesTransferred = 0;
  const acc = { maxEdited: watermark ?? "", upserted: 0 };
  const syncTime = Date.now();
  let shouldStop = false;

  for (;;) {
    await ctx.rateLimiter.acquire("confluence");
    const { results, bytes } = await confluenceFetchSearchPageBatch(ctx, {
      apiBase,
      email,
      token,
      cqlBase,
      start,
      limit,
    });
    bytesTransferred += bytes;

    for (const item of results) {
      const stop = confluenceUpsertOneSearchHit(ctx, item, { watermarkMs, baseRaw, syncTime }, acc);
      if (stop) {
        shouldStop = true;
        break;
      }
    }

    if (shouldStop || results.length === 0 || results.length < limit) {
      break;
    }
    start += limit;
  }

  const nextW = acc.maxEdited === "" ? watermark : acc.maxEdited;
  return {
    cursor: encodeCursor({ v: 1, watermark: nextW }),
    itemsUpserted: acc.upserted,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
    bytesTransferred,
  };
}

export type ConfluenceSyncableOptions = {
  ensureConfluenceMcpRunning: () => Promise<void>;
};

export function createConfluenceSyncable(options: ConfluenceSyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureConfluenceMcpRunning();
      const token = await readConnectorSecret(ctx.vault, "confluence", "api_token");
      const email = await readConnectorSecret(ctx.vault, "confluence", "email");
      const baseRaw = await readConnectorSecret(ctx.vault, "confluence", "base_url");
      if (
        token === null ||
        token === "" ||
        email === null ||
        email === "" ||
        baseRaw === null ||
        baseRaw === ""
      ) {
        return syncNoopResult(cursor, t0);
      }
      const apiBase = wikiApiBase(baseRaw);
      if (apiBase === "") {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor);
      const watermark = prev?.watermark ?? null;
      const watermarkMs = watermark !== null && watermark !== "" ? isoMs(watermark) : -1;

      const cqlBase =
        watermarkMs < 0
          ? `type = page AND lastModified >= now("-${String(initialSyncDepthDays)}d") order by lastModified desc`
          : `type = page AND lastModified > "${watermark}" order by lastModified desc`;

      // No acquire here: `confluenceRunPagedSearch` acquires once per paging
      // request, first iteration included. A second acquire at this level would
      // spend a token that buys nothing.
      return confluenceRunPagedSearch({
        ctx,
        apiBase,
        email,
        token,
        baseRaw,
        cqlBase,
        watermark,
        watermarkMs,
        t0,
      });
    },
  };
}
