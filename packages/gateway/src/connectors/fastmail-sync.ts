import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import {
  type FastmailAttachmentMeta,
  type FastmailEmailInput,
  mapFastmailEmailToItem,
} from "./fastmail-email-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "fastmail";
const CURSOR_PREFIX = "nimbus-fastmail1:";
const DEFAULT_BASE_URL = "https://api.fastmail.com";
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
/** Single forward pass per cycle: index the most-recent N emails. */
const MAX_EMAILS = 200;
/** Server-side body-value truncation — we NEVER receive a full body. */
const MAX_BODY_VALUE_BYTES = 2048;
const PREVIEW_MAX_CHARS = 2000;

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

interface JmapSession {
  readonly apiUrl: string;
  readonly accountId: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<FastmailCreds | null> {
  const apiToken = (await readConnectorSecret(ctx.vault, "fastmail", "api_token"))?.trim() ?? "";
  if (apiToken === "") {
    return null;
  }
  const baseRaw = (await readConnectorSecret(ctx.vault, "fastmail", "base_url"))?.trim() ?? "";
  return { baseUrl: trimTrailingSlash(baseRaw === "" ? DEFAULT_BASE_URL : baseRaw), apiToken };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Parse the JMAP session resource → the mail-account api url + account id. */
function parseSession(parsed: unknown): JmapSession | null {
  const root = asRecord(parsed);
  if (root === null) {
    return null;
  }
  const apiUrl = asString(root["apiUrl"]);
  const primary = asRecord(root["primaryAccounts"]);
  const accountId = primary === null ? null : asString(primary[MAIL_CAPABILITY]);
  if (apiUrl === null || accountId === null) {
    return null;
  }
  return { apiUrl, accountId };
}

/** Format one JMAP EmailAddress (`{ name?, email }`) as `Name <email>` / `email`. */
function formatAddress(a: unknown): string {
  const r = asRecord(a);
  if (r === null) {
    return "";
  }
  const email = asString(r["email"]) ?? "";
  const name = asString(r["name"]);
  if (name !== null) {
    return email === "" ? name : `${name} <${email}>`;
  }
  return email;
}

function formatAddresses(v: unknown): string[] {
  return Array.isArray(v) ? v.map(formatAddress).filter((s) => s !== "") : [];
}

function extractAttachments(v: unknown): FastmailAttachmentMeta[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v.map((raw) => {
    const r = asRecord(raw);
    const size = r === null ? null : r["size"];
    return {
      name: r === null ? null : asString(r["name"]),
      sizeBytes: typeof size === "number" && Number.isFinite(size) ? size : null,
      mimeType: r === null ? null : asString(r["type"]),
    };
  });
}

function capPreview(text: string): string {
  const normalized = text
    .replaceAll("\r\n", "\n")
    .replaceAll(/[ \t]+/g, " ")
    .replaceAll(/\n{2,}/g, "\n")
    .trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? normalized.slice(0, PREVIEW_MAX_CHARS)
    : normalized;
}

/**
 * Build the body preview from the first `textBody` part's (server-truncated)
 * body value; fall back to the JMAP server-computed `preview` string. Both are
 * already bounded — we never receive the full body.
 */
function previewFor(raw: Record<string, unknown>): string {
  const bodyValues = asRecord(raw["bodyValues"]);
  const textBody = raw["textBody"];
  if (bodyValues !== null && Array.isArray(textBody)) {
    for (const part of textBody) {
      const partId = asRecord(part)?.["partId"];
      if (typeof partId === "string") {
        const value = asRecord(bodyValues[partId])?.["value"];
        if (typeof value === "string" && value !== "") {
          return capPreview(value);
        }
      }
    }
  }
  return capPreview(asString(raw["preview"]) ?? "");
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

const EMAIL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "subject",
  "from",
  "to",
  "cc",
  "receivedAt",
  "sentAt",
  "messageId",
  "hasAttachment",
  "preview",
  "attachments",
  "textBody",
  "bodyValues",
] as const;

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
