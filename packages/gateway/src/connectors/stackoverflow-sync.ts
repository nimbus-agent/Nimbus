import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapStackOverflowQuestionToItem } from "./stackoverflow-question-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "stackoverflow";
const CURSOR_PREFIX = "nimbus-stackoverflow1:";
const BASE = "https://api.stackoverflowteams.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type StackOverflowCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies StackOverflowCursorV1);
}

export type StackOverflowSyncableOptions = {
  ensureStackOverflowMcpRunning: () => Promise<void>;
};

interface StackOverflowCreds {
  readonly token: string;
  readonly team: string;
}

async function loadCreds(ctx: SyncContext): Promise<StackOverflowCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "stackoverflow", "token"))?.trim() ?? "";
  const team = (await readConnectorSecret(ctx.vault, "stackoverflow", "team"))?.trim() ?? "";
  if (token === "" || team === "") {
    return null;
  }
  return { token, team };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

function questionsPath(team: string, page: number): string {
  const params = new URLSearchParams({
    page: String(page),
    pagesize: String(PAGE_SIZE),
    sort: "creation",
    order: "desc",
  });
  return `/v3/teams/${encodeURIComponent(team)}/questions?${params.toString()}`;
}

async function stackOverflowGet(
  ctx: SyncContext,
  creds: StackOverflowCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, status: res.status, path },
      "stackoverflow GET failed",
    );
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractPage(parsed: unknown): { items: unknown[]; totalPages: number } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], totalPages: 0 };
  }
  const items = root["items"];
  const totalPages = root["totalPages"];
  return {
    items: Array.isArray(items) ? items : [],
    totalPages: typeof totalPages === "number" && Number.isFinite(totalPages) ? totalPages : 0,
  };
}

function upsertQuestions(ctx: SyncContext, questions: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const q of questions) {
    const mapped = mapStackOverflowQuestionToItem(q, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createStackOverflowSyncable(options: StackOverflowSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureStackOverflowMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await stackOverflowGet(ctx, creds, questionsPath(creds.team, page));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const { items, totalPages } = extractPage(outcome.parsed);
        totalUpserted += upsertQuestions(ctx, items, now);

        if (items.length === 0 || page >= totalPages) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
