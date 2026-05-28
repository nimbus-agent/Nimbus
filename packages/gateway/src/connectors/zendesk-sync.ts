import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { mapZendeskTicketToItem } from "./zendesk-ticket-mapping.ts";

const SERVICE_ID = "zendesk";
const CURSOR_PREFIX = "nimbus-zendesk1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type ZendeskCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ZendeskCursorV1);
}

export type ZendeskSyncableOptions = {
  ensureZendeskMcpRunning: () => Promise<void>;
};

interface ZendeskCreds {
  readonly url: string;
  readonly email: string;
  readonly apiToken: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function zendeskBasicAuthHeader(email: string, apiToken: string): string {
  const cred = `${email}/token:${apiToken}`;
  const b64 = Buffer.from(cred, "utf8").toString("base64");
  return `Basic ${b64}`;
}

async function loadCreds(ctx: SyncContext): Promise<ZendeskCreds | null> {
  const url = (await readConnectorSecret(ctx.vault, "zendesk", "url"))?.trim() ?? "";
  const email = (await readConnectorSecret(ctx.vault, "zendesk", "email"))?.trim() ?? "";
  const apiToken = (await readConnectorSecret(ctx.vault, "zendesk", "api_token"))?.trim() ?? "";
  if (url === "" || email === "" || apiToken === "") {
    return null;
  }
  return { url: trimTrailingSlash(url), email, apiToken };
}

function ticketsPath(afterCursor: string | null): string {
  const params = new URLSearchParams({ "page[size]": String(PAGE_SIZE) });
  if (afterCursor !== null && afterCursor !== "") {
    params.set("page[after]", afterCursor);
  }
  return `/api/v2/tickets.json?${params.toString()}`;
}

function zendeskGet(ctx: SyncContext, creds: ZendeskCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.url}${path}`, {
    headers: {
      Authorization: zendeskBasicAuthHeader(creds.email, creds.apiToken),
      Accept: "application/json",
    },
  });
}

function extractTickets(parsed: unknown): unknown[] {
  const root = asRecord(parsed);
  if (root === undefined) {
    return [];
  }
  const tickets = root["tickets"];
  return Array.isArray(tickets) ? tickets : [];
}

function extractContinuation(parsed: unknown): { hasMore: boolean; afterCursor: string | null } {
  const meta = asRecord(asRecord(parsed)?.["meta"]) ?? {};
  const hasMore = meta["has_more"] === true;
  const afterCursor = stringField(meta, "after_cursor") ?? null;
  return { hasMore, afterCursor };
}

function upsertTickets(
  ctx: SyncContext,
  creds: ZendeskCreds,
  tickets: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const t of tickets) {
    const mapped = mapZendeskTicketToItem(t, { baseUrl: creds.url, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createZendeskSyncable(options: ZendeskSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureZendeskMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let afterCursor: string | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await zendeskGet(ctx, creds, ticketsPath(afterCursor));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        totalUpserted += upsertTickets(ctx, creds, extractTickets(outcome.parsed), now);

        const cont = extractContinuation(outcome.parsed);
        if (!cont.hasMore || cont.afterCursor === null || cont.afterCursor === "") {
          break;
        }
        afterCursor = cont.afterCursor;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
