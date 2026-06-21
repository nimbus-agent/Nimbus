/**
 * Gateway-side iCloud Mail sync — reuses the shared IMAP-like sync engine.
 *
 * iCloud Mail speaks plain IMAP over TLS (imap.mail.me.com:993). Authentication
 * uses the account's app-specific password (NOT the Apple ID password), stored
 * in the Vault under `apple.icloud_email` + `apple.icloud_app_password`.
 *
 * The calendar half (CalDAV) is added in Phase F3 by extending this file and
 * the `AppleSyncableOptions` type.
 */
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { runImapLikeSync } from "./_lib/imap-sync-core.ts";
import { mapImapLikeMessageToItem } from "./imap-email-mapping.ts";
import type { ImapConnectionConfig, ImapMessageFetcher } from "./imap-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "apple" as const;
const CURSOR_PREFIX = "nimbus-apple1:";
const DEFAULT_MAILBOX = "INBOX";
/** Fixed iCloud IMAP endpoint — always port 993 over implicit TLS. */
const ICLOUD_IMAP_HOST = "imap.mail.me.com";
const ICLOUD_IMAP_PORT = 993;
/** Single forward pass per cycle: index the most-recent N messages. */
const MAX_MESSAGES = 200;

type AppleCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies AppleCursorV1);
}

/**
 * Resolve the iCloud Mail connection config from the Vault.
 *
 * Reads `apple.icloud_email` (the full iCloud e-mail address) and
 * `apple.icloud_app_password` (the app-specific password generated under
 * Apple ID → Sign-In & Security → App-Specific Passwords). Both must be
 * non-empty; returns `null` if either is absent so the scheduler skips
 * the cycle gracefully.
 *
 * The mailbox is read from `apple.mailbox` (optional, defaults to "INBOX").
 * Host, port, and TLS mode are fixed constants — iCloud Mail does not
 * allow user-configurable endpoints.
 */
export async function loadMailConfig(ctx: SyncContext): Promise<ImapConnectionConfig | null> {
  const email = (await ctx.vault.get("apple.icloud_email"))?.trim() ?? "";
  const appPw = (await ctx.vault.get("apple.icloud_app_password"))?.trim() ?? "";
  if (email === "" || appPw === "") {
    return null;
  }
  const mailbox = (await ctx.vault.get("apple.mailbox"))?.trim() || DEFAULT_MAILBOX;
  return {
    host: ICLOUD_IMAP_HOST,
    port: ICLOUD_IMAP_PORT,
    secure: true,
    username: email,
    password: appPw,
    mailbox,
  };
}

/**
 * Options for the Apple syncable. The `fetchMessages` seam is injected so
 * tests can pass a fake without opening a real IMAP socket.
 *
 * NOTE: `fetchEvents` (CalDAV) will be added in Phase F3 when the calendar
 * half is wired in. Adding it before it is used would be dead code and would
 * be flagged by the linter.
 */
export type AppleSyncableOptions = {
  /** Ensure the apple MCP connector process is running before fetching. */
  ensureAppleMcpRunning: () => Promise<void>;
  /** Injected IMAP fetcher (real over imapflow in prod; fake in tests). */
  fetchMessages: ImapMessageFetcher;
};

/**
 * Apple (iCloud Mail) syncable — registers under `serviceId: "apple"` with
 * the scheduler. The sync body delegates entirely to `runImapLikeSync`, which
 * handles ensure-running → load config → rate-limit → fetch → map + upsert.
 */
export function createAppleSyncable(options: AppleSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runImapLikeSync(ctx, cursor, {
        serviceId: SERVICE_ID,
        ensureRunning: options.ensureAppleMcpRunning,
        loadConfig: loadMailConfig,
        fetchMessages: options.fetchMessages,
        maxMessages: MAX_MESSAGES,
        pass1Cursor,
        mapMessage: (msg, syncedAt) => mapImapLikeMessageToItem(SERVICE_ID, msg, { syncedAt }),
      });
    },
  };
}
