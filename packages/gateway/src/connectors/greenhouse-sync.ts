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

async function loadCreds(ctx: SyncContext): Promise<GreenhouseCreds | null> {
  const apiKey = (await readConnectorSecret(ctx.vault, "greenhouse", "api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

function basicAuthHeader(apiKey: string): string {
  const b64 = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

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
