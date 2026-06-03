import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import type { ImapConnectionConfig, ImapFetchOutcome, ImapMessageFetcher } from "./imap-sync.ts";
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

function intFromSecret(raw: string | null | undefined, fallback: number): number {
  const t = raw?.trim() ?? "";
  if (t === "") {
    return fallback;
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.trunc(n) : fallback;
}

async function loadConfig(ctx: SyncContext): Promise<ImapConnectionConfig | null> {
  // ProtonMail Bridge generates a per-machine username + password; the IMAP
  // host/port default to the Bridge loopback listener.
  const username = (await readConnectorSecret(ctx.vault, "protonmail", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(ctx.vault, "protonmail", "password"))?.trim() ?? "";
  if (username === "" || password === "") {
    return null;
  }
  const host =
    (await readConnectorSecret(ctx.vault, "protonmail", "imap_host"))?.trim() ||
    DEFAULT_BRIDGE_HOST;
  const port = intFromSecret(
    await readConnectorSecret(ctx.vault, "protonmail", "imap_port"),
    DEFAULT_IMAP_PORT,
  );
  const mailbox =
    (await readConnectorSecret(ctx.vault, "protonmail", "mailbox"))?.trim() || DEFAULT_MAILBOX;
  // Bridge uses STARTTLS on a local port with a self-signed cert.
  return { host, port, username, password, mailbox, secure: false, tlsRejectUnauthorized: false };
}

function transientResult(cursor: string | null, t0: number): SyncResult {
  return {
    cursor: cursor ?? pass1Cursor(),
    itemsUpserted: 0,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
  };
}

export function createProtonmailSyncable(options: ProtonmailSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureProtonmailMcpRunning();

      const config = await loadConfig(ctx);
      if (config === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire(SERVICE_ID);

      let outcome: ImapFetchOutcome;
      try {
        outcome = await options.fetchMessages(config, MAX_MESSAGES);
      } catch (err) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, err: err instanceof Error ? err.message : String(err) },
          "protonmail sync: fetch threw; treating as transient failure",
        );
        return transientResult(cursor, t0);
      }

      if (!outcome.ok) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, error: outcome.error },
          "protonmail sync: connection/fetch failed; preserving cursor",
        );
        return transientResult(cursor, t0);
      }

      const now = Date.now();
      let upserted = 0;
      for (const msg of outcome.messages) {
        const mapped = mapProtonmailEmailToItem(msg, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, 0, pass1Cursor(), upserted);
    },
  };
}
