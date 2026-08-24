import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { parsePortSecret, runImapLikeSync } from "./_lib/imap-sync-core.ts";
import { type ImapMessageInput, mapImapMessageToItem } from "./imap-email-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "imap";
const CURSOR_PREFIX = "nimbus-imap1:";
const DEFAULT_MAILBOX = "INBOX";
/** Single forward pass per cycle: index the most-recent N messages. */
const MAX_MESSAGES = 200;

type ImapCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ImapCursorV1);
}

/** Per-tenant IMAP connection config resolved from the vault (read in the gateway, NOT the connector). */
export interface ImapConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly mailbox: string;
  /**
   * Implicit-TLS toggle. Defaults to `true` (IMAPS/993). ProtonMail Bridge
   * exposes a STARTTLS endpoint on a local port, so it sets this to `false`.
   */
  readonly secure?: boolean;
  /**
   * When explicitly `false`, accept a self-signed server certificate (used by
   * ProtonMail Bridge's localhost listener). Defaults to verifying.
   */
  readonly tlsRejectUnauthorized?: boolean;
}

/**
 * Outcome of an IMAP fetch. `ok` carries header/attachment-metadata/preview
 * views; `error` is a transient/connection failure the scheduler should tolerate
 * (no throw). Mirrors the `_lib/aws-cli.ts` `{ ok }` result shape.
 */
export type ImapFetchOutcome =
  | { readonly ok: true; readonly messages: readonly ImapMessageInput[] }
  | { readonly ok: false; readonly error: string };

/**
 * Injectable IMAP fetcher. The real implementation (over imapflow) lives in
 * `_lib/imap-client.ts` and is wired in `assemble-sync-registrations.ts`; tests
 * pass a fake so no real socket is opened. MUST NOT throw on connection failure
 * — it returns `{ ok: false }` instead so the scheduler does not crash.
 */
export type ImapMessageFetcher = (
  config: ImapConnectionConfig,
  limit: number,
) => Promise<ImapFetchOutcome>;

export type ImapSyncableOptions = {
  ensureImapMcpRunning: () => Promise<void>;
  /** Injected IMAP fetcher (real over imapflow in prod; fake in tests). */
  fetchMessages: ImapMessageFetcher;
};

async function loadConfig(ctx: SyncContext): Promise<ImapConnectionConfig | null> {
  const host = (await ctx.getSecret("host"))?.trim() ?? "";
  const username = (await ctx.getSecret("username"))?.trim() ?? "";
  const password = (await ctx.getSecret("password"))?.trim() ?? "";
  if (host === "" || username === "" || password === "") {
    return null;
  }
  const port = parsePortSecret(await ctx.getSecret("port"), 993);
  const mailbox = (await ctx.getSecret("mailbox"))?.trim() || DEFAULT_MAILBOX;
  return { host, port, username, password, mailbox };
}

export function createImapSyncable(options: ImapSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runImapLikeSync(ctx, cursor, {
        serviceId: SERVICE_ID,
        ensureRunning: options.ensureImapMcpRunning,
        loadConfig,
        fetchMessages: options.fetchMessages,
        maxMessages: MAX_MESSAGES,
        pass1Cursor,
        mapMessage: (msg, syncedAt) => mapImapMessageToItem(msg, { syncedAt }),
      });
    },
  };
}
