import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapReadwiseHighlightToItem } from "./readwise-highlight-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "readwise";
const CURSOR_PREFIX = "nimbus-readwise1:";
const BASE = "https://readwise.io";
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

type ReadwiseCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ReadwiseCursorV1);
}

export type ReadwiseSyncableOptions = {
  ensureReadwiseMcpRunning: () => Promise<void>;
};

interface ReadwiseCreds {
  readonly token: string;
}

/**
 * `readwise.token` is required. Readwise's API host is a fixed SaaS host
 * (`readwise.io`) — there is no host override key. The connector no-ops unless
 * the token is non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<ReadwiseCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "readwise", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/** Build `/api/v2/highlights/?page_size=1000&page=N`. */
function highlightsPath(page: number): string {
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE), page: String(page) });
  return `/api/v2/highlights/?${params.toString()}`;
}

async function readwiseGet(
  ctx: SyncContext,
  creds: ReadwiseCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Readwise uses Django-REST-Framework token auth: the literal word "Token",
  // NOT "Bearer" (the token is never logged).
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Token ${creds.token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "readwise GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/**
 * `GET /api/v2/highlights/` returns the Django-REST-Framework page envelope
 * `{ count, next, previous, results: [...] }`. Extract the `results` array and
 * the `next` page URL defensively — a missing/malformed envelope yields an empty
 * page with `next: null` so the walk terminates.
 */
function extractHighlights(parsed: unknown): { highlights: unknown[]; next: string | null } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { highlights: [], next: null };
  }
  const results = root["results"];
  const highlights = Array.isArray(results) ? results : [];
  const nextRaw = root["next"];
  const next = typeof nextRaw === "string" && nextRaw !== "" ? nextRaw : null;
  return { highlights, next };
}

function upsertHighlights(ctx: SyncContext, highlights: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const h of highlights) {
    const mapped = mapReadwiseHighlightToItem(h, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createReadwiseSyncable(options: ReadwiseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureReadwiseMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // The highlights walk is the gating call: a FIRST-page http/parse error
      // maps to the pass-cursor-empty result. Later-page errors just break,
      // preserving whatever was already collected. Readwise page-paginates
      // (DRF): increment `page` from 1; stop when a page is empty OR the
      // envelope's `next` URL is null (or the MAX_PAGES cap stops the walk).
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await readwiseGet(ctx, creds, highlightsPath(page));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const { highlights, next } = extractHighlights(outcome.parsed);
        totalUpserted += upsertHighlights(ctx, highlights, now);

        if (highlights.length === 0 || next === null) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
