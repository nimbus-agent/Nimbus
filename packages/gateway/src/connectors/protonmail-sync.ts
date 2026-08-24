import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { parsePortSecret, runImapLikeSync } from "./_lib/imap-sync-core.ts";
import type { ImapConnectionConfig, ImapMessageFetcher } from "./imap-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapProtonmailEmailToItem } from "./protonmail-email-mapping.ts";

const SERVICE_ID = "protonmail";
const CURSOR_PREFIX = "nimbus-protonmail1:";
const DEFAULT_MAILBOX = "INBOX";
// ProtonMail Bridge's local IMAP/SMTP defaults (loopback only).
const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_IMAP_PORT = 1143;
/** Single forward pass per cycle: index the most-recent N messages. */
const MAX_MESSAGES = 200;

type ProtonmailCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ProtonmailCursorV1);
}

export type ProtonmailSyncableOptions = {
  ensureProtonmailMcpRunning: () => Promise<void>;
  /** Injected IMAP fetcher (the shared `fetchImapMessages` in prod; fake in tests). */
  fetchMessages: ImapMessageFetcher;
};

async function loadConfig(ctx: SyncContext): Promise<ImapConnectionConfig | null> {
  // ProtonMail Bridge generates a per-machine username + password; the IMAP
  // host/port default to the Bridge loopback listener.
  const username = (await ctx.getSecret("username"))?.trim() ?? "";
  const password = (await ctx.getSecret("password"))?.trim() ?? "";
  if (username === "" || password === "") {
    return null;
  }
  const host = (await ctx.getSecret("imap_host"))?.trim() || DEFAULT_BRIDGE_HOST;
  const port = parsePortSecret(await ctx.getSecret("imap_port"), DEFAULT_IMAP_PORT);
  const mailbox = (await ctx.getSecret("mailbox"))?.trim() || DEFAULT_MAILBOX;
  // Bridge uses STARTTLS on a local port with a self-signed cert.
  return { host, port, username, password, mailbox, secure: false, tlsRejectUnauthorized: false };
}

export function createProtonmailSyncable(options: ProtonmailSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runImapLikeSync(ctx, cursor, {
        serviceId: SERVICE_ID,
        ensureRunning: options.ensureProtonmailMcpRunning,
        loadConfig,
        fetchMessages: options.fetchMessages,
        maxMessages: MAX_MESSAGES,
        pass1Cursor,
        mapMessage: (msg, syncedAt) => mapProtonmailEmailToItem(msg, { syncedAt }),
      });
    },
  };
}
