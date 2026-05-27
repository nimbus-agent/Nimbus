import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapGreenhouseJobToItem } from "./greenhouse-job-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "greenhouse";
const CURSOR_PREFIX = "nimbus-greenhouse1:";
const BASE = "https://harvest.greenhouse.io";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type GreenhouseCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies GreenhouseCursorV1);
}

export type GreenhouseSyncableOptions = {
  ensureGreenhouseMcpRunning: () => Promise<void>;
};

interface GreenhouseCreds {
  readonly apiKey: string;
}

/**
 * `greenhouse.api_key` is required. Greenhouse's Harvest API host is a fixed
 * SaaS host (`harvest.greenhouse.io`) — there is no host override key. The
 * connector no-ops unless the key is non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<GreenhouseCreds | null> {
  const apiKey = (await readConnectorSecret(ctx.vault, "greenhouse", "api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

/**
 * Build the Basic auth header. Greenhouse's scheme makes the API key the
 * USERNAME and the password EMPTY, so the header is `Basic base64(<api_key>:)` —
 * note the trailing colon. The gateway cannot import the mcp-shared
 * `encodeBasicAuthHeader`, so the base64 is inlined here (the bitbucket-sync /
 * jenkins-sync / lever-sync pattern). The key is never logged.
 */
function basicAuthHeader(apiKey: string): string {
  const b64 = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/** Build `/v1/jobs?per_page=100&page=N` (1-based). */
function jobsPath(page: number): string {
  const params = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page) });
  return `/v1/jobs?${params.toString()}`;
}

async function greenhouseGet(
  ctx: SyncContext,
  creds: GreenhouseCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: basicAuthHeader(creds.apiKey), Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "greenhouse GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/**
 * `GET /v1/jobs` returns a BARE JSON array of job objects (NOT an envelope).
 * A non-array body yields an empty page so the walk terminates. (Greenhouse
 * also sends an RFC-5988 `Link` header with rel="next", but the walk uses the
 * full-page-length heuristic like Netlify — the Link header is not parsed.)
 */
function extractJobs(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [];
}

function upsertJobs(ctx: SyncContext, jobs: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const j of jobs) {
    const mapped = mapGreenhouseJobToItem(j, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createGreenhouseSyncable(options: GreenhouseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGreenhouseMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // The first jobs page is the gating call: a FIRST-page http/parse error
      // maps to the pass-cursor-empty result (http keeps the prior cursor, parse
      // resets). Later-page errors just break, preserving whatever was already
      // collected. Greenhouse page-paginates over a BARE array: increment `page`
      // from 1; stop when a page returns fewer than per_page items (or an empty
      // array), or the MAX_PAGES cap is hit.
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await greenhouseGet(ctx, creds, jobsPath(page));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const jobs = extractJobs(outcome.parsed);
        totalUpserted += upsertJobs(ctx, jobs, now);

        if (jobs.length < PAGE_SIZE) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
