import {
  asRecord,
  asString,
  CORE_CAPABILITY,
  EMAIL_PROPERTIES,
  extractAttachments,
  formatAddresses,
  type JmapSession,
  MAIL_CAPABILITY,
  MAX_BODY_VALUE_BYTES,
  parseSession,
  previewFor,
} from "@nimbus-dev/sdk";

import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { type FastmailEmailInput, mapFastmailEmailToItem } from "./fastmail-email-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "fastmail";
const CURSOR_PREFIX = "nimbus-fastmail1:";
const DEFAULT_BASE_URL = "https://api.fastmail.com";
/** Single forward pass per cycle: index the most-recent N emails. */
const MAX_EMAILS = 200;

type FastmailCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies FastmailCursorV1);
}

export type FastmailSyncableOptions = {
  ensureFastmailMcpRunning: () => Promise<void>;
};

interface FastmailCreds {
  readonly baseUrl: string;
  readonly apiToken: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<FastmailCreds | null> {
  const apiToken = (await ctx.getSecret("api_token"))?.trim() ?? "";
  if (apiToken === "") {
    return null;
  }
  const baseRaw = (await ctx.getSecret("base_url"))?.trim() ?? "";
  return { baseUrl: trimTrailingSlash(baseRaw === "" ? DEFAULT_BASE_URL : baseRaw), apiToken };
}

function normalizeJmapEmail(raw: unknown): FastmailEmailInput | null {
  const r = asRecord(raw);
  if (r === null) {
    return null;
  }
  const id = asString(r["id"]);
  const messageIdArr = r["messageId"];
  const messageId = Array.isArray(messageIdArr) ? (asString(messageIdArr[0]) ?? null) : null;
  if (id === null && messageId === null) {
    return null;
  }
  return {
    id: id ?? "",
    messageId,
    subject: asString(r["subject"]),
    from: formatAddresses(r["from"]),
    to: formatAddresses(r["to"]),
    cc: formatAddresses(r["cc"]),
    receivedAt: asString(r["receivedAt"]),
    attachments: extractAttachments(r["attachments"]),
    preview: previewFor(r),
  };
}

function getSession(ctx: SyncContext, creds: FastmailCreds): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, `${creds.baseUrl}/jmap/session`, {
    headers: { Authorization: `Bearer ${creds.apiToken}`, Accept: "application/json" },
  });
}

function emailQueryBody(accountId: string): string {
  return JSON.stringify({
    using: [CORE_CAPABILITY, MAIL_CAPABILITY],
    methodCalls: [
      [
        "Email/query",
        {
          accountId,
          sort: [{ property: "receivedAt", isAscending: false }],
          collapseThreads: false,
          limit: MAX_EMAILS,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: [...EMAIL_PROPERTIES],
          fetchTextBodyValues: true,
          maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
          bodyProperties: ["partId", "blobId", "size", "name", "type", "disposition"],
        },
        "e",
      ],
    ],
  });
}

function queryEmails(
  ctx: SyncContext,
  creds: FastmailCreds,
  session: JmapSession,
): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, session.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.apiToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: emailQueryBody(session.accountId),
  });
}

/** Extract the `Email/get` response `list` from a JMAP method-responses envelope. */
function extractEmails(parsed: unknown): unknown[] {
  const root = asRecord(parsed);
  const responses = root === null ? null : root["methodResponses"];
  if (!Array.isArray(responses)) {
    return [];
  }
  for (const entry of responses) {
    if (Array.isArray(entry) && entry[0] === "Email/get") {
      const list = asRecord(entry[1])?.["list"];
      return Array.isArray(list) ? list : [];
    }
  }
  return [];
}

export function createFastmailSyncable(options: FastmailSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureFastmailMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      let totalBytes = 0;

      const sessionOutcome = await getSession(ctx, creds);
      totalBytes += sessionOutcome.bytes;
      if (sessionOutcome.kind !== "ok") {
        return sessionOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }
      const session = parseSession(sessionOutcome.parsed);
      if (session === null) {
        return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const queryOutcome = await queryEmails(ctx, creds, session);
      totalBytes += queryOutcome.bytes;
      if (queryOutcome.kind !== "ok") {
        return queryOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let upserted = 0;
      for (const raw of extractEmails(queryOutcome.parsed)) {
        const normalized = normalizeJmapEmail(raw);
        if (normalized === null) {
          continue;
        }
        const mapped = mapFastmailEmailToItem(normalized, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), upserted);
    },
  };
}
