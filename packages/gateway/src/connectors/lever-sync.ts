import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapLeverPostingToItem } from "./lever-posting-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "lever";
const CURSOR_PREFIX = "nimbus-lever1:";
const BASE = "https://api.lever.co";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type LeverCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies LeverCursorV1);
}

export type LeverSyncableOptions = {
  ensureLeverMcpRunning: () => Promise<void>;
};

interface LeverCreds {
  readonly apiKey: string;
}

/**
 * `lever.api_key` is required. Lever's API host is a fixed SaaS host
 * (`api.lever.co`) — there is no host override key. The connector no-ops unless
 * the key is non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<LeverCreds | null> {
  const apiKey = (await readConnectorSecret(ctx.vault, "lever", "api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

/**
 * Build the Basic auth header. Lever's scheme makes the API key the USERNAME
 * and the password EMPTY, so the header is `Basic base64(<api_key>:)` — note
 * the trailing colon. The gateway cannot import the mcp-shared
 * `encodeBasicAuthHeader`, so the base64 is inlined here (the bitbucket-sync /
 * jenkins-sync pattern). The key is never logged.
 */
function basicAuthHeader(apiKey: string): string {
  const b64 = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/**
 * Build `/v1/postings?limit=100`, optionally with an `offset` cursor (Lever's
 * `next` value from the previous page).
 */
function postingsPath(offset: string | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset !== null) {
    params.set("offset", offset);
  }
  return `/v1/postings?${params.toString()}`;
}

async function leverGet(ctx: SyncContext, creds: LeverCreds, path: string): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: basicAuthHeader(creds.apiKey), Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "lever GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/**
 * `GET /v1/postings` returns the Lever envelope `{ data: [...], hasNext, next }`.
 * Extract the `data` array, the `hasNext` flag, and the `next` offset cursor
 * defensively — a missing/malformed envelope yields an empty page with
 * `hasNext: false` so the walk terminates.
 */
function extractPostings(parsed: unknown): {
  postings: unknown[];
  hasNext: boolean;
  next: string | null;
} {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { postings: [], hasNext: false, next: null };
  }
  const data = root["data"];
  const postings = Array.isArray(data) ? data : [];
  const next = stringField(root, "next") ?? null;
  return { postings, hasNext: root["hasNext"] === true, next: next === "" ? null : next };
}

function upsertPostings(ctx: SyncContext, postings: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const p of postings) {
    const mapped = mapLeverPostingToItem(p, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createLeverSyncable(options: LeverSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureLeverMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let offset: string | null = null;

      // The first postings page is the gating call: a FIRST-page http/parse
      // error maps to the pass-cursor-empty result (http keeps the prior
      // cursor, parse resets). Later-page errors just break, preserving whatever
      // was already collected. Lever offset-paginates: follow `next` while
      // `hasNext` is true AND `next` is a non-empty string (or the MAX_PAGES cap
      // stops the walk).
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await leverGet(ctx, creds, postingsPath(offset));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const { postings, hasNext, next } = extractPostings(outcome.parsed);
        totalUpserted += upsertPostings(ctx, postings, now);

        if (!hasNext || next === null) {
          break;
        }
        offset = next;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
