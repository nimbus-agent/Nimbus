import { getValidMendeleyAccessToken } from "../auth/mendeley-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { parseNextLink } from "./mendeley-link-header.ts";
import { mapMendeleyDocumentToItem } from "./mendeley-reference-mapping.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "mendeley";
const CURSOR_PREFIX = "nimbus-mendeley1:";
const BASE = "https://api.mendeley.com";
const DOC_ACCEPT = "application/vnd.mendeley-document.1+json";
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

type MendeleyCursorV1 = { since: string | null };
type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface PageOutcome {
  kind: "ok" | "http_error" | "parse_error";
  docs: unknown[];
  bytes: number;
  nextUrl: string | null;
}

/**
 * Format a cursor timestamp for Mendeley's `modified_since` query param. Defaults
 * to seconds precision (milliseconds stripped) — the lowest-common-denominator
 * ISO 8601 form, since some Mendeley endpoints reject fractional seconds with 400.
 * To switch to millisecond precision, return `date.toISOString()` instead.
 */
export function formatCursorDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function decodeCursor(cursor: string | null): MendeleyCursorV1 | null {
  if (cursor === null) {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(cursor, CURSOR_PREFIX);
  if (parsed !== null && typeof parsed === "object" && "since" in parsed) {
    const since = (parsed as { since: unknown }).since;
    return { since: typeof since === "string" ? since : null };
  }
  return null;
}

function firstPageUrl(since: string | null): string {
  const params = new URLSearchParams({ view: "all", limit: String(PAGE_LIMIT) });
  if (since !== null && since !== "") {
    params.set("modified_since", since);
  }
  return `${BASE}/documents?${params.toString()}`;
}

async function fetchMendeleyPage(
  ctx: SyncContext,
  accessToken: string,
  url: string,
  fetchFn: FetchFn,
): Promise<PageOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: DOC_ACCEPT },
  });
  const text = await res.text();
  const bytes = text.length;
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, url }, "connector fetch failed");
    return { kind: "http_error", docs: [], bytes, nextUrl: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { kind: "parse_error", docs: [], bytes, nextUrl: null };
  }
  return {
    kind: "ok",
    docs: Array.isArray(parsed) ? parsed : [],
    bytes,
    // Resolve the rel="next" href against the current page URL so a relative
    // Link header (RFC 5988 permits it) becomes an absolute URL fetch can use.
    // An already-absolute href is returned unchanged by the URL constructor.
    nextUrl: resolveNextUrl(parseNextLink(res.headers.get("link")), url),
  };
}

function resolveNextUrl(rawNext: string | null, base: string): string | null {
  if (rawNext === null) {
    return null;
  }
  try {
    return new URL(rawNext, base).href;
  } catch {
    return null;
  }
}

function nextCursor(since: string): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { since } satisfies MendeleyCursorV1);
}

export type MendeleySyncableOptions = {
  ensureMendeleyMcpRunning: () => Promise<void>;
};

export function createMendeleySyncable(
  options: MendeleySyncableOptions,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMendeleyMcpRunning();
      const raw = await readConnectorSecret(ctx.vault, "mendeley", "oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let accessToken: string;
      try {
        accessToken = await getValidMendeleyAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor);
      const syncStartIso = formatCursorDate(new Date());
      let url: string | null = firstPageUrl(prev?.since ?? null);
      let totalBytes = 0;
      let upserted = 0;

      for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
        const outcome = await fetchMendeleyPage(ctx, accessToken, url, fetchFn);
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, nextCursor(syncStartIso))
              : syncPassCursorParseEmpty(t0, totalBytes, nextCursor(syncStartIso));
          }
          break;
        }
        for (const d of outcome.docs) {
          const mapped = mapMendeleyDocumentToItem(d, { syncedAt: Date.now() });
          if (mapped !== null) {
            upsertIndexedItemForSync(ctx, mapped);
            upserted += 1;
          }
        }
        url = outcome.nextUrl;
      }

      return syncPassCursorSuccess(t0, totalBytes, nextCursor(syncStartIso), upserted);
    },
  };
}
