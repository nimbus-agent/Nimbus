import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapNetlifySiteToItem } from "./netlify-site-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "netlify";
const CURSOR_PREFIX = "nimbus-netlify1:";
const BASE = "https://api.netlify.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type NetlifyCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies NetlifyCursorV1);
}

export type NetlifySyncableOptions = {
  ensureNetlifyMcpRunning: () => Promise<void>;
};

interface NetlifyCreds {
  readonly token: string;
}

/**
 * `netlify.token` is required. Netlify's API host is a fixed SaaS host
 * (`api.netlify.com`) — there is no host override key. The connector no-ops
 * unless the token is non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<NetlifyCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "netlify", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/** Build `/api/v1/sites?per_page=100&page=N`. */
function sitesPath(page: number): string {
  const params = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page) });
  return `/api/v1/sites?${params.toString()}`;
}

async function netlifyGet(
  ctx: SyncContext,
  creds: NetlifyCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Netlify uses a standard `Authorization: Bearer <token>` header.
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "netlify GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/** `GET /api/v1/sites` returns a bare JSON array of site objects. */
function extractSites(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [];
}

function upsertSites(ctx: SyncContext, sites: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const s of sites) {
    const mapped = mapNetlifySiteToItem(s, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createNetlifySyncable(options: NetlifySyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureNetlifyMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // The sites walk is the gating call: a FIRST-page http/parse error maps
      // to the pass-cursor-empty result. Later-page errors just break,
      // preserving whatever was already collected. Netlify page-paginates:
      // increment `page` from 1; stop when a page returns fewer than per_page
      // items (or an empty array).
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await netlifyGet(ctx, creds, sitesPath(page));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const sites = extractSites(outcome.parsed);
        totalUpserted += upsertSites(ctx, sites, now);

        if (sites.length < PAGE_SIZE) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
