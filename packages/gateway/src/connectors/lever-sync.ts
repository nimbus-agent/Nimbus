import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
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

async function loadCreds(ctx: SyncContext): Promise<LeverCreds | null> {
  const apiKey = (await readConnectorSecret(ctx.vault, "lever", "api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

function basicAuthHeader(apiKey: string): string {
  const b64 = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function postingsPath(offset: string | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset !== null) {
    params.set("offset", offset);
  }
  return `/v1/postings?${params.toString()}`;
}

function leverGet(ctx: SyncContext, creds: LeverCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: basicAuthHeader(creds.apiKey), Accept: "application/json" },
  });
}

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
