import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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

function intFromSecret(raw: string | null | undefined, fallback: number): number {
  const t = raw?.trim() ?? "";
  if (t === "") {
    return fallback;
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.trunc(n) : fallback;
}

async function loadConfig(ctx: SyncContext): Promise<ImapConnectionConfig | null> {
  const host = (await readConnectorSecret(ctx.vault, "imap", "host"))?.trim() ?? "";
  const username = (await readConnectorSecret(ctx.vault, "imap", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(ctx.vault, "imap", "password"))?.trim() ?? "";
  if (host === "" || username === "" || password === "") {
    return null;
  }
  const port = intFromSecret(await readConnectorSecret(ctx.vault, "imap", "port"), 993);
  const mailbox =
    (await readConnectorSecret(ctx.vault, "imap", "mailbox"))?.trim() || DEFAULT_MAILBOX;
  return { host, port, username, password, mailbox };
}

export function createImapSyncable(options: ImapSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureImapMcpRunning();

      const config = await loadConfig(ctx);
      if (config === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire(SERVICE_ID);

      let outcome: ImapFetchOutcome;
      try {
        outcome = await options.fetchMessages(config, MAX_MESSAGES);
      } catch (err) {
        // Defence-in-depth: even if a fetcher throws, the scheduler must not
        // crash. Treat as a transient failure and preserve the cursor.
        ctx.logger.warn(
          { serviceId: SERVICE_ID, err: err instanceof Error ? err.message : String(err) },
          "imap sync: fetch threw; treating as transient failure",
        );
        return {
          cursor: cursor ?? pass1Cursor(),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: Math.round(performance.now() - t0),
        };
      }

      if (!outcome.ok) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, error: outcome.error },
          "imap sync: connection/fetch failed; preserving cursor",
        );
        return {
          cursor: cursor ?? pass1Cursor(),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: Math.round(performance.now() - t0),
        };
      }

      const now = Date.now();
      let upserted = 0;
      for (const msg of outcome.messages) {
        const mapped = mapImapMessageToItem(msg, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, 0, pass1Cursor(), upserted);
    },
  };
}
